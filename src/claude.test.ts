import assert from "node:assert/strict";
import { mock } from "node:test";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveMinCachedTokens, resolveStrategy } from "./provider.ts";
import { SessionWarmer } from "./warmer.ts";
import { DEFAULT_CONFIG, type WarmResult } from "./types.ts";

function fixture<T>(value: Partial<T>): T {
  // SAFETY: tests supply the host fields exercised by the warmer.
  return value as T;
}

function claudeModel(id: string): Model<Api> {
  return fixture<Model<Api>>({
    id, provider: "anthropic", api: "anthropic-messages", baseUrl: "https://api.anthropic.com/v1",
  });
}

function context(model: Model<Api>, idle = true): ExtensionContext {
  return fixture<ExtensionContext>({
    cwd: process.cwd(), model, hasUI: false, isIdle: () => idle,
    sessionManager: fixture<ExtensionContext["sessionManager"]>({ getSessionId: () => "claude-cache-test" }),
  });
}

const pi = fixture<ExtensionAPI>({ getThinkingLevel: () => "off" });

function response(cacheRead = 8192): AssistantMessage {
  return fixture<AssistantMessage>({
    stopReason: "stop",
    usage: {
      input: 0, output: 1, cacheRead, cacheWrite: 0, totalTokens: cacheRead + 1,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });
}

function nextDue(warmer: SessionWarmer): number | null {
  const due = /(?:^|\s)nextDue=(\S+)/.exec(warmer.getStatusText())?.[1];
  return !due || due === "none" ? null : Date.parse(due);
}

function timerHarness<Warmer>(warmer: Warmer): { runWarm: (reason: "timer") => Promise<WarmResult> } {
  // SAFETY: exercises the existing timer callback without waiting four real minutes.
  return warmer as { runWarm: (reason: "timer") => Promise<WarmResult> };
}

const floors: ReadonlyArray<readonly [string, number]> = [
  ["claude-fable-5-1", 512], ["claude-mythos-5-1", 512], ["claude-opus-5-5", 512],
  ["claude-opus-5", 512], ["claude-sonnet-5-5", 512], ["claude-fable-5", 512], ["claude-mythos-5", 512],
  ["claude-mythos-preview", 2048], ["claude-opus-4-7", 2048],
  ["claude-opus-4-6", 4096], ["claude-opus-4-5", 4096], ["claude-haiku-4-5", 4096],
  ["claude-opus-4-8", 1024], ["claude-sonnet-5", 1024], ["claude-sonnet-4-6", 1024],
  ["claude-sonnet-4-5", 1024], ["claude-opus-4-1", 1024], ["claude-opus-4", 1024], ["claude-sonnet-4", 1024],
  ["claude-haiku-3-5", 2048], ["claude-3-5-haiku", 2048],
];
for (const [id, floor] of floors) {
  assert.equal(resolveMinCachedTokens(claudeModel(id), 1), floor, id);
  assert.equal(resolveMinCachedTokens(claudeModel(`${id}-20260901`), 1), floor, `${id}: dated ID`);
  assert.equal(resolveMinCachedTokens(claudeModel(`${id}-latest`), 1), floor, `${id}: latest alias`);
  assert.equal(resolveMinCachedTokens(claudeModel(id), 8192), 8192, `${id}: stricter user floor`);
}
assert.equal(resolveMinCachedTokens(claudeModel("claude-haiku-4.5"), 512), 4096);
assert.equal(resolveMinCachedTokens(claudeModel("anthropic/claude-sonnet-5.5"), 1), 512);
assert.equal(resolveMinCachedTokens(claudeModel("claude-unknown"), 10), 10, "unknown models are not guessed");
assert.equal(resolveMinCachedTokens(claudeModel("MiniMax-M2.5"), 10), 10, "Messages compatibility is not Claude identity");
assert.equal(resolveMinCachedTokens(undefined, 10), 10);
assert.equal(resolveMinCachedTokens(fixture<Model<Api>>({ id: "claude-haiku-4-5", api: "openai-completions", provider: "proxy" }), 10), 10);

// Both cache styles, TTLs, thinking signatures and effort survive exact replay
// on the latest models. No top-level marker is injected into four explicit slots.
for (const id of ["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5-20251001"]) {
  for (const automatic of [false, true]) {
    for (const ttl of ["5m", "1h"]) {
      const model = claudeModel(id);
      const ctx = context(model);
      const marker = { type: "ephemeral", ttl };
      const blockMarker = automatic ? {} : { cache_control: marker };
      const legacyThinking = id.startsWith("claude-haiku-");
      const payload = {
        model: id, stream: true, max_tokens: 8192,
        thinking: legacyThinking ? { type: "enabled", budget_tokens: 1024 } : { type: "adaptive" },
        tools: [{ name: "test_tool", input_schema: { type: "object" }, ...blockMarker }],
        system: [{ type: "text", text: "synthetic instructions", ...blockMarker }],
        messages: [
          { role: "user", content: [{ type: "text", text: "synthetic request", ...blockMarker }] },
          { role: "assistant", content: [
            { type: "thinking", thinking: "synthetic thought", signature: "synthetic-signature" },
            { type: "tool_use", id: "test-call", name: "test_tool", input: {} },
          ] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "test-call", content: "synthetic result", ...blockMarker }] },
        ],
      };
      if (automatic) Object.assign(payload, { cache_control: marker });
      if (!legacyThinking) Object.assign(payload, { output_config: { effort: "medium" } });
      const original = structuredClone(payload);
      let replay: unknown;
      const warmer = new SessionWarmer(pi, async (_model, _context, options) => {
        replay = await options?.onPayload?.({}, model);
        return response();
      });
      try {
        warmer.bindContext(ctx);
        warmer.capturePayload(payload, ctx);
        const plan = resolveStrategy(model, { ...DEFAULT_CONFIG, intervalMs: null }, payload);
        assert.equal(plan.family, ttl === "1h" ? "anthropic-long" : "anthropic-short");
        assert.equal(plan.intervalMs, ttl === "1h" ? 48 * 60_000 : 4 * 60_000);
        assert.equal(plan.automaticWarm, true, `${id}: route supports current model without a catalog whitelist`);
        assert.equal((await warmer.warmNow(ctx)).cacheHit, true);
        assert.deepEqual(replay, { ...original, max_tokens: legacyThinking ? 1025 : 1 });
        assert.deepEqual(payload, original, "neither original payload nor cache markers are mutated");
      } finally { warmer.dispose(); }
    }
  }
}

// A known provider minimum wins over a lowered user setting. Short real turns
// are unknown, not misses, and cannot dispatch automatic probes.
{
  const model = claudeModel("claude-haiku-4-5-20251001");
  const ctx = context(model);
  let calls = 0;
  const warmer = new SessionWarmer(pi, async () => {
    calls++;
    const uncached = response(0);
    uncached.usage.input = 3072;
    uncached.usage.totalTokens += 3072;
    return uncached;
  });
  const payload = { model: model.id, cache_control: { type: "ephemeral" }, messages: [{ role: "user", content: "synthetic request" }] };
  try {
    warmer.setConfig({ ...DEFAULT_CONFIG, minCachedTokens: 1 });
    warmer.onProviderRequestStart(payload, ctx);
    warmer.onAssistantMessageEnd(ctx);
    warmer.noteAssistantUsage(ctx, { input: 3072 });
    warmer.onAgentSettled(ctx);
    assert.equal(nextDue(warmer), null);
    assert(warmer.getStatusText().includes("minCachedTokens=4096"));
    warmer.onProviderRequestStart(payload, ctx);
    warmer.onAssistantMessageEnd(ctx);
    warmer.noteAssistantUsage(ctx, { input: 3072 });
    warmer.onAgentSettled(ctx);
    assert.equal(warmer.getLatestRealTurnObservation()?.state, "unknown");
    assert.equal(warmer.getLatestRealTurnObservation()?.reason, "prompt below minimum (3072 < 4096)");
    const refused = await timerHarness(warmer).runWarm("timer");
    assert.equal(refused.unavailable, true);
    assert.equal(calls, 0, "automatic fire-time guard cannot send an uncacheable prompt");
    assert(warmer.getStatusText().includes("probeFailStreak=0/2"));
    assert.equal((await warmer.warmNow(ctx)).unavailable, undefined, "manual diagnostics remain available below the minimum");
    assert.equal(calls, 1);
    assert.equal(nextDue(warmer), null, "a diagnostic miss must not arm an uncacheable timer");
    assert.equal(warmer.getLatestRealTurnObservation()?.state, "unknown", "manual probes cannot turn short real turns into misses");

    warmer.onProviderRequestStart(payload, ctx);
    warmer.onAssistantMessageEnd(ctx);
    warmer.noteAssistantUsage(ctx, { cacheRead: 4096 });
    warmer.onAgentSettled(ctx);
    assert.equal(warmer.getLatestRealTurnObservation()?.state, "hit");
    assert.notEqual(nextDue(warmer), null, "the minimum itself is eligible");
    warmer.setConfig({ ...warmer.getConfig(), minCachedTokens: 8192 });
    warmer.reschedule();
    assert.equal(nextDue(warmer), null, "raising the user floor clears an already-armed timer");
  } finally { warmer.dispose(); }
}

// Mock only Date, not timers: deterministic TTL assertions without allowing
// background callbacks to interleave with real provider lifecycle events.
const start = Date.UTC(2026, 8, 29);
mock.timers.enable({ apis: ["Date"], now: start });
try {
  for (const long of [false, true]) {
    mock.timers.setTime(start);
    const model = claudeModel("claude-opus-5-5");
    const ctx = context(model);
    const warmer = new SessionWarmer(pi);
    const payload = { model: model.id, cache_control: { type: "ephemeral", ttl: long ? "1h" : "5m" }, messages: [{ role: "user", content: "synthetic request" }] };
    try {
      warmer.setConfig({ ...DEFAULT_CONFIG, intervalMs: null });
      warmer.onProviderRequestStart(payload, ctx);
      mock.timers.setTime(start + (long ? 45 : 3) * 60_000);
      warmer.onAssistantMessageEnd(ctx);
      warmer.noteAssistantUsage(ctx, { cacheRead: 8192 });
      warmer.onAgentSettled(ctx);
      assert.equal(nextDue(warmer), start + (long ? 48 : 4) * 60_000, "generation time consumes the cache lifetime");

      if (!long) {
        // A continuing turn must not reset the deadline at settlement either.
        warmer.onProviderRequestStart(payload, ctx);
        mock.timers.setTime(start + 8 * 60_000);
        warmer.onAssistantMessageEnd(ctx);
        warmer.noteAssistantUsage(ctx, { cacheRead: 8192 });
        warmer.onAgentSettled(ctx);
        assert.equal(nextDue(warmer), Date.now() + 1000, "an overdue refresh is due soon, not four minutes later");
      }
    } finally { warmer.dispose(); }
  }

  mock.timers.setTime(start);
  {
    const model = claudeModel("claude-sonnet-5-5");
    const ctx = context(model);
    const warmer = new SessionWarmer(pi, async (_model, _context, options) => {
      mock.timers.setTime(start + 90_000);
      await options?.onPayload?.({}, model);
      mock.timers.setTime(start + 270_000);
      return response();
    });
    try {
      warmer.onProviderRequestStart({ model: model.id, cache_control: { type: "ephemeral" }, messages: [{ role: "user", content: "synthetic request" }] }, ctx);
      warmer.onAssistantMessageEnd(ctx);
      warmer.noteAssistantUsage(ctx, { cacheRead: 8192 });
      mock.timers.setTime(start + 60_000);
      await warmer.warmNow(ctx);
      assert.equal(nextDue(warmer), start + 330_000, "next refresh uses probe dispatch, not invocation or response end");
      // A probe hit must not extend the last-real-turn idle cutoff.
      mock.timers.setTime(start + 30 * 60_000);
      warmer.reschedule();
      assert.equal(nextDue(warmer), null);
    } finally { warmer.dispose(); }
  }

  mock.timers.setTime(start);
  {
    const model = fixture<Model<Api>>({ id: "test-openai", provider: "openai", api: "openai-responses", baseUrl: "https://api.openai.com/v1" });
    const ctx = context(model);
    const warmer = new SessionWarmer(pi);
    try {
      warmer.onProviderRequestStart({ model: model.id, prompt_cache_key: "synthetic-key", input: [{ role: "user", content: "synthetic request" }] }, ctx);
      mock.timers.setTime(start + 3 * 60_000);
      warmer.onAssistantMessageEnd(ctx);
      warmer.noteAssistantUsage(ctx, { cacheRead: 8192 });
      warmer.onAgentSettled(ctx);
      assert.equal(nextDue(warmer), start + 7 * 60_000, "other providers retain their existing cadence");
    } finally { warmer.dispose(); }
  }

  mock.timers.setTime(start);
  {
    const model = claudeModel("claude-fable-5-1");
    const ctx = context(model, false);
    const warmer = new SessionWarmer(pi);
    try {
      warmer.onProviderRequestStart({ model: model.id, cache_control: { type: "ephemeral" }, messages: [{ role: "user", content: "synthetic request" }] }, ctx);
      mock.timers.setTime(start + 3 * 60_000);
      warmer.onAssistantMessageEnd(ctx);
      warmer.noteAssistantUsage(ctx, { cacheRead: 8192 });
      warmer.onToolExecutionStart({ toolCallId: "synthetic-tool", toolName: "bash", args: { command: "synthetic command" } }, ctx);
      assert.equal(nextDue(warmer), start + 6 * 60_000, "explicit tool minimum-runtime policy remains enforced");
    } finally { warmer.dispose(); }
  }
} finally { mock.timers.reset(); }

console.log("claude.test.ts: all assertions passed");
