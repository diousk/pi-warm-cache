import assert from "node:assert/strict";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CLAUDE_BRIDGE_WARM_CONTROL, ClaudeBridgeTransport } from "./claude-bridge.ts";
import { bridgeCacheRefusal, completeBridgeFork, createClaudeBridgeCacheHook, type BridgeSdkOptions } from "./claude-bridge-hook.ts";
import { resolveMinCachedTokens, resolveProviderCapability } from "./provider.ts";
import { SessionWarmer } from "./warmer.ts";
import { DEFAULT_CONFIG } from "./types.ts";

function fixture<T>(value: Partial<T>): T {
  // SAFETY: fixtures provide the host fields exercised by each test.
  return value as T;
}
const listeners = new Map<string, Set<(data: any) => void>>();
const events: ExtensionAPI["events"] = {
  on(name, listener) {
    const group = listeners.get(name) ?? new Set(); group.add(listener); listeners.set(name, group);
    return () => { group.delete(listener); };
  },
  emit(name, data) { for (const listener of listeners.get(name) ?? []) listener(data); },
};
const pi = fixture<ExtensionAPI>({ events, getThinkingLevel: () => "off" });
const model = fixture<Model<Api>>({ id: "claude-haiku-4-5", provider: "claude-bridge", api: "claude-bridge", baseUrl: "claude-bridge" });
const ctx = fixture<ExtensionContext>({
  model, hasUI: false, cwd: process.cwd(), isIdle: () => true,
  sessionManager: fixture<ExtensionContext["sessionManager"]>({ getSessionId: () => "bridge-test" }),
  modelRegistry: fixture<ExtensionContext["modelRegistry"]>({ complete: async () => { throw new Error("opaque bridge anchor dispatched through HTTP"); } }),
});
const realOptions: BridgeSdkOptions = {
  tools: [], env: { SYNTHETIC_AUTH: "do-not-emit" },
  settings: { autoMemoryEnabled: false, includeGitInstructions: false },
  extraArgs: { model: "claude-haiku-4-5", "strict-mcp-config": null },
  systemPrompt: { type: "preset", preset: "claude_code", append: "synthetic private prompt" },
  effort: "high", thinking: { type: "adaptive" },
};
const tools = [{ name: "write", description: "synthetic write tool", inputSchema: { type: "object" } }];
let calls = 0, closes = 0;
let observedOptions: BridgeSdkOptions | undefined;
let observedPrompt: string | undefined;
const dependencies = {
  query(prompt: string, options: BridgeSdkOptions) {
    calls++; observedPrompt = prompt; observedOptions = options;
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: "system", subtype: "init", session_id: "isolated-fork" };
        yield { type: "stream_event", event: { type: "message_start", message: {
          usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 8192, cache_creation_input_tokens: 128 },
        } } };
        yield { type: "stream_event", event: { type: "message_delta", usage: { output_tokens: 1 } } };
        yield { type: "result", subtype: "success" };
      },
      close() { closes++; },
    };
  },
  inertMcpServers(input: typeof tools) {
    assert.deepEqual(input, tools); assert.notEqual(input, tools);
    return undefined;
  },
};

const transport = new ClaudeBridgeTransport(pi);
const warmer = new SessionWarmer(pi, undefined, { transport }); transport.bind(warmer);
transport.configure(ctx, DEFAULT_CONFIG); warmer.bindContext(ctx);
assert.equal(warmer.getCapability().state, "unsupported", "stock bridge is never whitelisted");
assert.equal(resolveProviderCapability(model).state, "unsupported", "model name alone never verifies the route");
assert.equal(resolveMinCachedTokens(model, 512), 4096, "Haiku floor applies to bridge too");
const hook = createClaudeBridgeCacheHook(pi, dependencies);
try {
  transport.configure(ctx, DEFAULT_CONFIG); warmer.bindContext(ctx); warmer.setConfig(DEFAULT_CONFIG);
  assert.equal(warmer.getCapability().state, "verified");
  assert.equal(transport.strategy({ ...DEFAULT_CONFIG, intervalMs: 3_000_000, anthropicTtl: "1h" }).intervalMs, 240_000);
  assert.equal(transport.strategy({ ...DEFAULT_CONFIG, intervalMs: 120_000 }).intervalMs, 120_000);
  assert.equal(hook.capture(model, "foreign-session", realOptions, tools), undefined);
  const capture = hook.capture(model, "bridge-test", realOptions, tools);
  assert(capture);
  assert.equal((await warmer.warmNow(ctx)).ok, false, "not ready while a real request is in flight");
  capture.observe({ type: "system", subtype: "init", session_id: "original-session" });
  capture.observe({ type: "stream_event", event: { type: "message_start", message: { usage: {
    cache_creation_input_tokens: 8192,
    cache_creation: { ephemeral_1h_input_tokens: 8192, ephemeral_5m_input_tokens: 0 },
  } } } });
  capture.observe({ type: "stream_event", event: { type: "message_stop" } });
  assert.equal(transport.strategy(DEFAULT_CONFIG).family, "anthropic-long", "only real 1h write evidence enables long cadence");
  assert.equal(transport.strategy(DEFAULT_CONFIG).intervalMs, 50 * 60_000);
  assert.equal(transport.strategy({ ...DEFAULT_CONFIG, intervalMs: 20 * 60_000 }).intervalMs, 20 * 60_000,
    "non-default user interval may shorten the observed 1h cadence");
  assert.equal(transport.strategy({ ...DEFAULT_CONFIG, anthropicTtl: "5m" }).intervalMs, 240_000,
    "the explicit 5m mode keeps a short bridge cadence");
  warmer.onAssistantMessageEnd(ctx);
  warmer.noteAssistantUsage(ctx, { input: 1, output: 5, cacheRead: 8192, cacheWrite: 0 });
  warmer.onAgentSettled(ctx);
  const initialReal = warmer.getLatestRealTurnObservation();
  const result = await warmer.warmNow(ctx);
  assert(result.ok && result.cacheHit);
  assert.equal(calls, 1); assert.equal(closes, 1);
  assert.equal(observedPrompt, DEFAULT_CONFIG.warmSuffix);
  assert.equal(observedOptions?.resume, "original-session");
  assert.equal(observedOptions?.forkSession, true); assert.equal(observedOptions?.persistSession, false);
  assert.equal(observedOptions?.maxTurns, 1); assert.equal(observedOptions?.env?.CLAUDE_CODE_MAX_OUTPUT_TOKENS, undefined,
    "implicit/adaptive CC thinking must keep its native ceiling");
  assert.equal(observedOptions?.env?.CLAUDE_CODE_MAX_RETRIES, "0");
  assert.equal(observedOptions?.effort, "high"); assert.deepEqual(observedOptions?.thinking, realOptions.thinking);
  assert.deepEqual(observedOptions?.systemPrompt, realOptions.systemPrompt);
  assert.equal(observedOptions?.settings?.disableAllHooks, true);
  assert.equal((await observedOptions?.canUseTool?.())?.behavior, "deny");
  assert.deepEqual(observedOptions?.tools, []);
  assert.deepEqual(warmer.getLatestRealTurnObservation(), initialReal, "warm usage must not become real-turn usage");
  assert.equal(warmer.getLatestProbeObservation()?.output, 1);
  assert(!warmer.getStatusText().includes("synthetic private prompt"));
  assert(!warmer.getStatusText().includes("do-not-emit"));
  assert(warmer.getStatusText().includes("cost=n/a (Claude Code quota)"), "zero bridge catalog prices must not imply free probes");
  const frozen = JSON.stringify(observedOptions?.systemPrompt);
  realOptions.systemPrompt = { append: "changed real prompt" };
  assert.equal(JSON.stringify(observedOptions?.systemPrompt), frozen, "snapshot does not track mutable real prompt options");
  capture.start();
  assert.equal((await warmer.warmNow(ctx)).ok, false, "new real request cancels the old ready lease");
  capture.observe({ type: "stream_event", event: { type: "message_start", message: { usage: {
    cache_creation: { ephemeral_1h_input_tokens: 8192, ephemeral_5m_input_tokens: 100 },
  } } } });
  capture.observe({ type: "stream_event", event: { type: "message_stop" } });
  assert.equal(transport.strategy(DEFAULT_CONFIG).family, "anthropic-short", "mixed TTL writes need short cadence");
  warmer.onAssistantMessageEnd(ctx);
  warmer.noteAssistantUsage(ctx, { input: 1, output: 5, cacheRead: 8192, cacheWrite: 0 });
  transport.invalidate(); warmer.invalidateAnchor(ctx, "compacted");
  assert.equal((await warmer.warmNow(ctx)).ok, false);
  assert.equal(calls, 1);
  assert.equal(await completeBridgeFork(model, "original-session", { ...realOptions, thinking: { type: "enabled", budgetTokens: 1024 } }, tools,
    DEFAULT_CONFIG, new AbortController().signal, dependencies).then(r => r.usage.cacheRead), 8192);
  assert.equal(observedOptions?.env?.CLAUDE_CODE_MAX_OUTPUT_TOKENS, "1025", "fixed thinking cannot be reduced to fit an output cap");
  const before = calls;
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(completeBridgeFork(model, "original-session", realOptions, tools, DEFAULT_CONFIG, aborted.signal, dependencies));
  assert.equal(calls, before, "pre-aborted probes never start an SDK query");
  for (const override of [
    { tools: ["Bash"] }, { extraArgs: { model: model.id } },
    { env: { ANTHROPIC_BASE_URL: "https://unknown.example" } },
    { env: { CLAUDE_CODE_EXTRA_BODY: "{}" } }, { outputFormat: {} },
  ]) assert(bridgeCacheRefusal({ ...realOptions, ...override }));
  const notices: string[] = [];
  events.emit(CLAUDE_BRIDGE_WARM_CONTROL, { version: 99, sessionId: "unknown-version", attach: true,
    receive: () => notices.push("unexpected") });
  assert.deepEqual(notices, []);
  transport.dispose();
  assert.equal(transport.strategy(DEFAULT_CONFIG).family, "anthropic-short", "session disposal clears observed TTL");
  assert.equal(hook.capture(model, "bridge-test", realOptions, tools), undefined, "shutdown removes the bridge subscription");
} finally { transport.dispose(); warmer.dispose(); hook.dispose(); }
console.log("claude-bridge.test.ts: all assertions passed");
