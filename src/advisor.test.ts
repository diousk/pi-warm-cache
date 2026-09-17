import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context, Model, Api, SimpleStreamOptions, AssistantMessage } from "@earendil-works/pi-ai";
import type { ModelsApiStreamOptions } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AdvisorWarmer, CODEX_ADVISOR_MAX_INTERVAL_MS, isAdvisorRequest } from "./advisor.ts";
import { DEFAULT_CONFIG } from "./types.ts";
import { parseConfigArgs, parseConfigJson } from "./config.ts";
function fixture<T>(value: Partial<T>): T {
  // SAFETY: tests provide the subset of host interfaces exercised by this bridge.
  return value as T;
}

const systemPrompt = `You are an advisor model in an advisor-strategy pattern. An executor model is running a task end-to-end — calling tools, reading results, iterating toward a solution. When the executor hits a decision it cannot reasonably solve alone, it consults you for guidance. The executor's full tool inventory is prepended before the conversation so you can judge tool-choice correctness.

You read the shared conversation context and return ONE of:
- a plan (concrete next steps the executor should take),
- a correction (the executor is going down a wrong path — redirect it),
- a stop signal (the executor should halt and escalate to the user).

You NEVER call tools. You NEVER produce user-facing output. Be concise, directive, and grounded in the shared context. Name files, functions, and line numbers where possible. No preamble, no apologies, no meta-commentary about being an advisor — just the guidance the executor needs.`;
const context: Context = { systemPrompt, messages: [], tools: [] };
assert(isAdvisorRequest(context));
assert(!isAdvisorRequest({ ...context, systemPrompt: "another extension" }));
assert(!DEFAULT_CONFIG.warmAdvisor);
assert(parseConfigArgs("advisor=on").warmAdvisor);
assert(parseConfigArgs("ADVISOR=ON").warmAdvisor);
assert.throws(() => parseConfigArgs("advisor=maybe"));
assert(!parseConfigArgs("advisor=off", { ...DEFAULT_CONFIG, warmAdvisor: true }).warmAdvisor);
assert(parseConfigJson('{"warmAdvisor":true}').warmAdvisor);
assert.equal(CODEX_ADVISOR_MAX_INTERVAL_MS, 180_000);

const model = fixture<Model<Api>>({ id: "gpt-5.6", provider: "openai-codex", api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api", cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1 } });
const response = fixture<AssistantMessage>({ role: "assistant", content: [{ type: "text", text: "Advice" }], stopReason: "stop", usage: { input: 0, output: 1, cacheRead: 2048, cacheWrite: 0, totalTokens: 2049, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
let observed: SimpleStreamOptions | undefined;
const observedOptions = (): SimpleStreamOptions | undefined => observed;
let probes = 0;
let replay: unknown;
let replayTransport: string | undefined;
let replaySignal: AbortSignal | undefined;
let activeTools = ["advisor"];
let fail = false;
let pending: (() => Promise<void>) | undefined;
let delay = false;
const runtime = {
  async completeSimple(m: Model<Api>, _context: Context, options?: SimpleStreamOptions): Promise<AssistantMessage> {
    assert.equal(this, runtime);
    observed = options;
    if (fail) throw new Error("original error");
    await options?.onPayload?.({ instructions: systemPrompt, input: [], store: false, prompt_cache_key: options.sessionId }, m);
    if (delay) await new Promise<void>(resolve => { pending = async () => resolve(); });
    return response;
  },
};
const original = runtime.completeSimple;
const registry = {
  runtime,
  async complete<TApi extends Api>(_m: Model<TApi>, _c: Context, options?: ModelsApiStreamOptions<TApi>) {
    probes++;
    replayTransport = options?.transport;
    replaySignal = options?.signal;
    replay = await options?.onPayload?.({}, model);
    return response;
  },
};
const ctx = fixture<ExtensionContext>({
  model, cwd: "/tmp", hasUI: false, isIdle: () => false,
  sessionManager: fixture<ExtensionContext["sessionManager"]>({ getSessionId: () => "executor-session" }), modelRegistry: Object.assign(fixture<ExtensionContext["modelRegistry"]>({ complete: registry.complete }), { runtime }),
});
const pi = fixture<ExtensionAPI>({ getThinkingLevel: () => "off", getActiveTools: () => activeTools });
const bridge = new AdvisorWarmer(pi);
const config = { ...DEFAULT_CONFIG, warmAdvisor: true, intervalMs: 1000 };
try {
  bridge.configure(config, ctx);
  const installed = runtime.completeSimple;
  bridge.configure(config, ctx);
  assert.equal(runtime.completeSimple, installed, "no duplicate wrapper");
  const competing = new AdvisorWarmer(pi);
  competing.configure(config, ctx);
  assert(competing.status().includes("already owned"));
  competing.dispose();
  assert.equal(runtime.completeSimple, installed);
  await runtime.completeSimple(model, context);
  assert.equal(observed, undefined, "outside advisor tool must pass through");
  bridge.toolStart("a", "advisor");
  await runtime.completeSimple(model, { ...context, systemPrompt: "custom advisor" });
  assert.equal(observedOptions(), undefined, "unknown prompts must not be modified");
  let callback = 0;
  const signal = new AbortController().signal;
  const result = await runtime.completeSimple(model, context, { signal, transport: "sse", onPayload: body => {
    callback++;
    // SAFETY: the fake runtime supplies an object payload above.
    return { ...body as object, marker: "retained" };
  } });
  assert.equal(result, response);
  assert.equal(observedOptions()?.signal, signal);
  assert.equal(callback, 1);
  const key = observedOptions()?.sessionId;
  assert(key?.startsWith("warm-advisor-"));
  assert(bridge.status().includes("nextDue="));
  bridge.configure({ ...config, intervalMs: 240_000 }, ctx);
  assert(bridge.status().includes("intervalMs=180000"), "live config reload must retain the Codex advisor cap");
  bridge.configure(config, ctx);
  bridge.toolEnd("a");
  await new Promise(resolve => setTimeout(resolve, 1150));
  assert.equal(probes, 1, "independent warming must run while executor is busy");
  assert.equal(replayTransport, "sse", "probe must retain advisor transport");
  assert.notEqual(replaySignal, signal, "probe must not inherit an expired real request signal");
  assert.equal(callback, 1, "probe must not call real-request callbacks");
  // SAFETY: captured fake Codex payload contains the tested cache key and marker.
  const replayBody = replay as { prompt_cache_key: string; marker: string; input: unknown[] };
  assert.equal(replayBody.prompt_cache_key, key);
  assert.equal(replayBody.marker, "retained");
  assert.deepEqual(replayBody.input, [], "advisor Codex warm must replay the exact original input endpoint");
  bridge.toolStart("b", "advisor");
  await runtime.completeSimple(model, context);
  assert.equal(observedOptions()?.sessionId, key, "stable advisor key across calls");
  await runtime.completeSimple(model, context, { sessionId: "existing" });
  assert.equal(observedOptions()?.sessionId, "existing");
  await runtime.completeSimple(model, context, { cacheRetention: "none" });
  assert.equal(observedOptions()?.sessionId, undefined);
  assert(bridge.status().includes("disabled caching"));
  bridge.toolStart("other", "bash");
  await runtime.completeSimple(model, context);
  assert.equal(observed, undefined, "ambiguous parallel tools must pass through");
  bridge.toolEnd("other");
  fail = true;
  await assert.rejects(runtime.completeSimple(model, context), /original error/);
  fail = false;
  delay = true;
  const request = runtime.completeSimple(model, context);
  await new Promise(resolve => setTimeout(resolve, 0));
  bridge.invalidate("compacted");
  await pending?.();
  await request;
  assert(bridge.status().includes("compacted"), "late response cannot re-arm invalidated state");
  delay = false;
  const cancelled = new AbortController();
  cancelled.abort();
  await runtime.completeSimple(model, context, { signal: cancelled.signal });
  assert(!bridge.status().includes("nextDue="), "aborted requests cannot arm warming");
  await runtime.completeSimple(model, context);
  activeTools = [];
  const before = probes;
  await new Promise(resolve => setTimeout(resolve, 1150));
  assert.equal(probes, before, "disabled advisor must not send another probe");
  const upstream = runtime.completeSimple;
  const outer: typeof original = (...args) => upstream(...args);
  runtime.completeSimple = outer;
  bridge.dispose();
  assert.equal(runtime.completeSimple, outer, "do not remove another extension's wrapper");
  await runtime.completeSimple(model, context);
  assert.equal(observedOptions(), undefined, "detached wrapper must pass through");
  runtime.completeSimple = original;
} finally { bridge.dispose(); }
assert.equal(runtime.completeSimple, original, "restore original on shutdown");
bridge.configure(config, { ...ctx, modelRegistry: fixture<ExtensionContext["modelRegistry"]>({}) });
assert(bridge.status().includes("unavailable"));
bridge.dispose();
bridge.configure(DEFAULT_CONFIG, ctx);
bridge.toolStart("disabled", "advisor");
assert.equal(bridge.status(), "Advisor warming: off");
bridge.dispose();
const advisorTmpRoot = mkdtempSync(join(tmpdir(), "advisor-warm-selection-"));
const oldXdg = process.env.XDG_CONFIG_HOME;
try {
  process.env.XDG_CONFIG_HOME = advisorTmpRoot;
  mkdirSync(join(advisorTmpRoot, "rpiv-advisor"));
  const selection = join(advisorTmpRoot, "rpiv-advisor", "advisor.json");
  writeFileSync(selection, JSON.stringify({ modelKey: "openai-codex/gpt-5.6" }));
  activeTools = ["advisor"];
  bridge.configure(config, ctx);
  bridge.toolStart("selection", "advisor");
  await runtime.completeSimple(model, context);
  bridge.toolEnd("selection");
  const before = probes;
  writeFileSync(selection, JSON.stringify({ modelKey: "another/model" }));
  await new Promise(resolve => setTimeout(resolve, 1150));
  assert.equal(probes, before, "persisted selection changes must stop the old model's probes");
  assert(bridge.status().includes("selection changed"));
  bridge.configure({ ...config, maxIdleWarmMs: 1 }, ctx);
  bridge.toolStart("idle-limit", "advisor");
  await runtime.completeSimple(model, context);
  bridge.toolEnd("idle-limit");
  await new Promise(resolve => setTimeout(resolve, 1150));
  assert.equal(probes, before, "advisor must honor idle cutoff independently of executor activity");
} finally {
  bridge.dispose();
  if (oldXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = oldXdg;
  rmSync(advisorTmpRoot, { recursive: true, force: true });
}
console.log("advisor.test.ts: all assertions passed");
