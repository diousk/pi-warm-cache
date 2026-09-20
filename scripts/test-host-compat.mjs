// Exercise the installed Pi loader and (on 0.86) its actual CacheWarmer.
// All provider calls are in-memory; no credentials or network are used.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mock } from "node:test";
import { fileURLToPath } from "node:url";
import * as ai from "@earendil-works/pi-ai";
import piWarmCache from "../src/index.ts";
import { currentInstructions } from "../src/compat.ts";
import { AdvisorWarmer, isAdvisorRequest, ADVISOR_PROMPT_SHA256 } from "../src/advisor.ts";
import { DEFAULT_CONFIG } from "../src/types.ts";
import { createHash } from "node:crypto";

const root = new URL("../node_modules/@earendil-works/pi-coding-agent/", import.meta.url);
const { version } = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
const { createExtensionRuntime, loadExtensionFromFactory, loadExtensions } = await import(new URL("dist/core/extensions/loader.js", root));
const { createEventBus } = await import(new URL("dist/core/event-bus.js", root));
const loaded = await loadExtensions([fileURLToPath(new URL("../src/index.ts", import.meta.url))], process.cwd());
assert.deepEqual(loaded.errors, [], "extension file must compile and load through the real host loader");
assert.equal(loaded.extensions.length, 1);
const runtime = createExtensionRuntime();
runtime.getThinkingLevel = () => "off";
const extension = await loadExtensionFromFactory(pi => piWarmCache(pi, () => {}), process.cwd(), createEventBus(), runtime);
const model = {
  id: "compat-test", name: "Compatibility test", provider: "anthropic", api: "anthropic-messages",
  baseUrl: "https://api.anthropic.com", reasoning: false, input: ["text"], contextWindow: 200000, maxTokens: 4096,
  cost: { input: 10, output: 15, cacheRead: 0.3, cacheWrite: 12.5 }, promptCache: { short: 20 },
};
const notices = [];
let probeCalls = 0;
const usage = { input: 0, output: 1, cacheRead: 100000, cacheWrite: 0, totalTokens: 100001,
  cost: { input: 0, output: 0.000015, cacheRead: 0.03, cacheWrite: 0, total: 0.030015 } };
const ctx = {
  model, cwd: process.cwd(), hasUI: false, isIdle: () => true,
  sessionManager: { getSessionId: () => "compat-session" },
  modelRegistry: { complete: async () => { probeCalls++; throw new Error("unexpected extension probe"); } },
  ui: { notify: text => notices.push(text), setStatus() {}, setWidget() {}, theme: { fg: (_, text) => text } },
};
async function emit(type, event = {}) {
  let result;
  for (const handler of extension.handlers.get(type) ?? []) result = await handler({ type, ...event }, ctx);
  return result;
}
const command = extension.commands.get("warm");
assert(command, "real host loader must register /warm");
assert(extension.handlers.has("cache_warming_decision"), "0.85 loader must accept the inert event too");
const decision = { action: "warm", warmCost: 0.03, missCost: 0.345, continuationProbability: 1 };
const payload = { model: model.id, system: [{ type: "text", text: "fixture", cache_control: { type: "ephemeral" } }], messages: [{ role: "user", content: "hello" }], max_tokens: 4096 };
async function status() { await command.handler("status", ctx); return notices.at(-1); }

try {
  await command.handler("on interval=1h", ctx);
  await emit("turn_start");
  await emit("before_provider_request", { payload });
  await emit("message_end", { message: { role: "assistant", usage } });
  const before = await status();
  assert(before.includes("Warming owner: pi-warm-cache"));
  assert.deepEqual(await emit("cache_warming_decision", decision), { action: "stop" });
  await emit("before_provider_request", { payload: { ...payload, model: "native-probe", max_tokens: 1 } });
  assert.equal(await status(), before, "native callback must not mutate anchors, usage, or timers");
  await emit("turn_start");
  await emit("before_provider_request", { payload: { ...payload, messages: [{ role: "user", content: "next real turn" }] } });
  assert.notEqual(await status(), before, "next real turn must be captured");
  await command.handler("off", ctx);
  assert.equal(await emit("cache_warming_decision", decision), undefined);
  assert((await status()).includes("Pi policy"));
  await command.handler("on", ctx);
  ctx.model = { ...model, provider: "custom", baseUrl: "https://unsupported.invalid" };
  assert.equal(await emit("cache_warming_decision", decision), undefined, "unsupported routes delegate to Pi");
  ctx.model = model;
  await command.handler("on tools=off spend=0.01", ctx);
  assert.deepEqual(await emit("cache_warming_decision", decision), { action: "stop" }, "policy pauses must retain ownership");

  // The actual advisor test fixture is shared, not a second drifting prompt.
  const advisorSource = readFileSync(new URL("../src/advisor.test.ts", import.meta.url), "utf8");
  const prompt = advisorSource.match(/const systemPrompt = `([\s\S]*?)`;/)[1];
  assert.equal(createHash("sha256").update(prompt).digest("hex"), ADVISOR_PROMPT_SHA256);
  const legacy = { systemPrompt: prompt, tools: [], messages: [] };
  assert(isAdvisorRequest(legacy));
  const advisorRuntime = { completeSimple: async (_model, _context, options) => {
    await options?.onPayload?.(payload, model);
    return { role: "assistant", stopReason: "stop", usage };
  } };
  const originalAdvisor = advisorRuntime.completeSimple;
  const advisor = new AdvisorWarmer({ getThinkingLevel: () => "off", getActiveTools: () => ["advisor"] });
  try {
    const advisorCtx = { ...ctx, modelRegistry: { ...ctx.modelRegistry, runtime: advisorRuntime } };
    advisor.configure({ ...DEFAULT_CONFIG, warmAdvisor: true, intervalMs: 3600000 }, advisorCtx);
    const wrapped = advisorRuntime.completeSimple;
    advisor.configure({ ...DEFAULT_CONFIG, warmAdvisor: true, intervalMs: 3600000 }, advisorCtx);
    assert.equal(advisorRuntime.completeSimple, wrapped, "reload/configure must not double-wrap");
    advisor.toolStart("advisor-call", "advisor");
    await advisorRuntime.completeSimple(model, ai.normalizeContext ? ai.normalizeContext(legacy) : legacy);
    assert(!advisor.status().includes("nextDue=none") && advisor.status().includes("nextDue="), "host context must produce an independent advisor timer");
    advisor.invalidate("compaction test");
    assert(advisor.status().includes("compaction test"));
  } finally { advisor.dispose(); }
  assert.equal(advisorRuntime.completeSimple, originalAdvisor, "shutdown must restore advisor runtime");
  if (ai.normalizeContext) {
    const normalized = ai.normalizeContext(legacy);
    assert(isAdvisorRequest(normalized), "transcript advisor must be recognized");
    const tool = { name: "test", description: "test", parameters: { type: "object", properties: {} } };
    const withTool = { messages: [...normalized.messages, { role: "system", content: "", toolsAdded: [tool], timestamp: 1 }] };
    assert(!isAdvisorRequest(withTool), "effective tools prohibit advisor capture");
    const removed = { messages: [...withTool.messages, { role: "system", content: "", toolsRemoved: [{ name: "test" }], timestamp: 2 }] };
    assert(isAdvisorRequest(removed), "tool removals must be replayed");
    assert(!isAdvisorRequest({ messages: [...normalized.messages, { role: "system", content: "changed instructions", timestamp: 3 }] }));
    const sectioned = { messages: [...normalized.messages, { role: "system", content: "", sections: { extra: "extra instructions" }, timestamp: 4 }] };
    assert(!isAdvisorRequest(sectioned), "prompt sections must affect recognition");
    assert.equal(currentInstructions(normalized).prompt, prompt);
  } else {
    assert.equal(version, "0.85.1");
    assert(!isAdvisorRequest({ systemPrompt: prompt, messages: [] }), "legacy missing tools remains unrecognized");
  }

  if (version === "0.86.0") {
    const { CacheWarmer } = await import(new URL("dist/core/cache-warmer.js", root));
    let nativeCalls = 0;
    const native = new CacheWarmer({ streamSimple: (_model, _context, options) => ({ result: async () => {
      nativeCalls++;
      assert.equal(options.maxTokens, 1);
      await emit("before_provider_request", { payload: { ...payload, max_tokens: 1 } });
      return { provider: model.provider, model: model.id, stopReason: "stop", usage };
    } }) }, {
      getBranch: () => [{ type: "message", message: { role: "assistant", usage } }],
      appendUsage: () => ({ type: "usage", usage }),
    }, () => "idle", async event => (await emit("cache_warming_decision", event))?.action ?? event.action);
    mock.timers.enable({ apis: ["setTimeout", "Date"] });
    try {
      for (const phase of ["streaming", "idle"]) {
        native.start({ model, context: legacy, options: {} }, () => true);
        if (phase === "idle") native.onAgentSettled();
        mock.timers.tick(10000);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(nativeCalls, 0, `${phase}: native provider call must be vetoed before dispatch`);
        assert.equal(native.status.reason, "stopped by extension");
      }
      await command.handler("off", ctx);
      const disabledStatus = await status();
      native.start({ model, context: legacy, options: {} }, () => true);
      mock.timers.tick(10000);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(nativeCalls, 1, "native warming must resume under Pi policy when extension is off");
      assert.equal(await status(), disabledStatus, "native request must not reset extension state");
    } finally { native.cancel(); mock.timers.reset(); }
  }
  assert.equal(probeCalls, 0);
  console.log(`host compatibility: Pi ${version} passed`);
} finally { await emit("session_shutdown"); }
