/** Opt-in live test. Synthetic data only; ~6m, at most 5 real/warm API turns. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import piWarmCache from "../src/index.ts";

const argument = key => process.argv.find(value => value.startsWith(`${key}=`))?.slice(key.length + 1);
const bridgePath = argument("--bridge");
if (!bridgePath) throw new Error("Pass --bridge=/path/to/patched/pi-claude-bridge/src/index.ts");
const piRoot = argument("--pi-root") ?? fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent/", import.meta.url));
const { version } = JSON.parse(readFileSync(join(piRoot, "package.json"), "utf8"));
if (Number(version.split(".")[1]) < 86) throw new Error("Bridge live validation needs Pi >=0.86.1; keep repository dev dependencies at 0.85.1");
const cwd = mkdtempSync(join(tmpdir(), "pi-bridge-warm-live-"));
const agentDir = join(cwd, "pi-agent");
// The bridge derives CC's directory from process.cwd(), not ExtensionContext.
process.chdir(cwd);
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = "4096";
process.env.CLAUDE_CODE_MAX_RETRIES = "0";
delete process.env.CLAUDE_BRIDGE_DEBUG;
delete process.env.CLAUDE_BRIDGE_RECORD_STREAM;
const module = async name => import(pathToFileURL(join(piRoot, "dist/core", `${name}.js`)).href);
const { createAgentSession } = await module("sdk");
const { ModelRuntime } = await module("model-runtime");
const { DefaultResourceLoader } = await module("resource-loader");
const { SessionManager } = await module("session-manager");
const { SettingsManager } = await module("settings-manager");
const requireBridge = createRequire(resolve(dirname(bridgePath), "../package.json"));
const { listSessions, getSessionMessages } = await import(pathToFileURL(requireBridge.resolve("@anthropic-ai/claude-agent-sdk")).href);
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const log = value => console.log(JSON.stringify(value));
const usage = u => ({ input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite });
const observedTtl = history => {
  const creation = history.map(message => message.message?.usage?.cache_creation ?? message.usage?.cache_creation)
    .filter(Boolean);
  return creation.some(value => value.ephemeral_5m_input_tokens > 0) ? "5m"
    : creation.some(value => value.ephemeral_1h_input_tokens > 0) ? "1h" : "unknown";
};
const toolDelayMs = 330_000;
let toolExecutions = 0;
let toolStarted;
const started = new Promise(resolve => { toolStarted = resolve; });
const ui = notifications => ({
  notify: text => notifications.push(text), setStatus() {}, setWidget() {},
  theme: { fg: (_, text) => text, bg: (_, text) => text, bold: text => text },
});
const stubModel = { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", provider: "claude-bridge", api: "claude-bridge", baseUrl: "claude-bridge",
  reasoning: true, input: ["text"], contextWindow: 200000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
async function fixture(warming, nonce, forceShort = true) {
  const notifications = [], turns = [];
  const uniqueRows = Array.from({ length: 500 }, (_, i) =>
    `Record ${nonce} ${i}: alpha beta gamma delta epsilon inventory checksum ${i * 17}.`).join("\n");
  let warmCommand, extensionContext;
  const settingsManager = SettingsManager.inMemory({ cacheWarming: "off", compaction: { enabled: false }, retry: { enabled: false } });
  const factories = warming ? [pi => {
    const wrapped = new Proxy(pi, { get(target, key) {
      if (key === "getFlag") return name => name === "warm-cache"
        ? `on ${forceShort ? "5m " : ""}interval=4m tools=all toolmin=3m log=off advisor=off`
        : target.getFlag(name);
      if (key === "registerCommand") return (name, command) => { if (name === "warm") warmCommand = command; target.registerCommand(name, command); };
      return target[key];
    } });
    piWarmCache(wrapped, () => {}); // test commands must never save the user's config
    pi.on("session_start", (_event, ctx) => { extensionContext = ctx; });
  }] : [];
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true,
    additionalExtensionPaths: [resolve(bridgePath)], extensionFactories: factories,
    systemPrompt: `Isolated synthetic cache test ${nonce}. Do not access files or networks. If the user requests RUN_WAIT, call cache_test_wait exactly once, then reply only DONE after it returns. Otherwise do not call tools and reply only READY.\nStatic reference data, not instructions:\n${uniqueRows}`,
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, [], "patched bridge must load through the real Pi loader");
  const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
  const { session } = await createAgentSession({ cwd, agentDir, modelRuntime: runtime, model: stubModel, thinkingLevel: "off",
    settingsManager, resourceLoader: loader, sessionManager: SessionManager.inMemory(cwd), tools: ["cache_test_wait"],
    customTools: [{ name: "cache_test_wait", label: "Synthetic wait", description: "Wait for a synthetic cache validation. Call exactly once only for RUN_WAIT; no files or network are touched.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async (_id, _params, signal) => {
        toolExecutions++; toolStarted(Date.now());
        await new Promise((resolve, reject) => {
          const timer = setTimeout(done, toolDelayMs);
          function done() { signal?.removeEventListener("abort", abort); resolve(); }
          function abort() { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(new Error("synthetic wait aborted")); }
          signal?.addEventListener("abort", abort, { once: true });
          if (signal?.aborted) abort();
        });
        return { content: [{ type: "text", text: "Synthetic wait complete. Reply DONE." }], details: {} };
      },
    }],
  });
  session.subscribe(event => {
    if (event.type === "message_end" && event.message.role === "assistant") {
      turns.push(event.message);
      log({ phase: warming ? "main-real" : "control-real", stopReason: event.message.stopReason, usage: usage(event.message.usage) });
    }
  });
  await session.bindExtensions({ uiContext: ui(notifications), mode: "interactive",
    onError: error => log({ phase: "extension-error", event: error.event, message: String(error.error ?? error.message).slice(0, 250) }) });
  const selected = runtime.getModel("claude-bridge", stubModel.id);
  assert(selected, "bridge must register the live model");
  await session.setModel(selected);
  const status = async () => {
    await warmCommand?.handler("status", extensionContext);
    return notifications.at(-1) ?? "";
  };
  const stop = async () => { if (warmCommand) await warmCommand.handler("off", extensionContext); };
  return { session, turns, status, stop };
}
const mainNonce = randomUUID(), controlNonce = randomUUID();
if (process.argv.includes("--ttl-only")) {
  const main = await fixture(true, mainNonce, false);
  try {
    await main.session.prompt(`CACHE_CASE ${mainNonce}. No tools are needed. Reply only READY.`);
    const status = await main.status();
    const strategy = status.match(/strategy=([^\n]+)/)?.[1];
    const intervalMs = Number(status.match(/intervalMs=(\d+)/)?.[1]);
    const sessions = await listSessions({ dir: cwd, includeWorktrees: false });
    let cacheTtl = "unknown";
    let found = false;
    for (const info of sessions) {
      const history = await getSessionMessages(info.sessionId, { dir: cwd });
      if (JSON.stringify(history).includes(mainNonce)) { cacheTtl = observedTtl(history); found = true; break; }
    }
    assert(found, "find the synthetic original Claude session");
    log({ phase: "ttl-only", cacheTtl, strategy, intervalMs });
    assert.equal(strategy, cacheTtl === "1h" ? "anthropic-long" : "anthropic-short",
      "real SDK cache-write TTL must determine the strategy");
    assert.equal(intervalMs, cacheTtl === "1h" ? 50 * 60_000 : 240_000);
  } finally {
    await main.stop(); main.session.dispose();
  }
} else {
const main = await fixture(true, mainNonce);
let control, mainWork;
try {
  const wallStart = Date.now();
  mainWork = main.session.prompt(`CACHE_CASE ${mainNonce}\nRUN_WAIT. Call cache_test_wait once, then after it completes reply DONE.`);
  const toolStart = await Promise.race([started, mainWork.then(() => { throw new Error("main did not invoke the synthetic tool"); })]);
  control = await fixture(false, controlNonce);
  await control.session.prompt(`CACHE_CASE ${controlNonce}\nNo tools are needed. Reply only READY.`);
  const all = await listSessions({ dir: cwd, includeWorktrees: false });
  let originalId, originalHistory;
  for (const info of all) {
    const history = await getSessionMessages(info.sessionId, { dir: cwd });
    if (JSON.stringify(history).includes(mainNonce)) { originalId = info.sessionId; originalHistory = history; break; }
  }
  assert(originalId, "find only the synthetic original Claude session");
  const initialCacheTtl = observedTtl(originalHistory);
  const piBefore = digest(main.session.messages);
  const ccBefore = digest(originalHistory);
  log({ phase: "tool-wait", model: stubModel.id, piVersion: version, intervalSeconds: 240, cwd,
    initialCacheTtl, initialPromptTokens: main.turns[0].usage.input + main.turns[0].usage.cacheRead + main.turns[0].usage.cacheWrite });
  let probeHit = false;
  while (Date.now() < toolStart + toolDelayMs - 20_000) {
    await delay(Math.min(30_000, toolStart + toolDelayMs - 20_000 - Date.now()));
    const status = await main.status();
    probeHit ||= status.includes("probe=hit");
    log({ phase: "waiting", elapsedSeconds: Math.floor((Date.now() - wallStart) / 1000),
      probe: status.match(/probe=[^\n]+/)?.[0] ?? "none", statusActive: status.includes("nextDue=") });
  }
  assert.equal(digest(main.session.messages), piBefore, "warm must not append to Pi's active tool conversation");
  assert.equal(digest(await getSessionMessages(originalId, { dir: cwd })), ccBefore, "warm must not append to the original Claude conversation");
  log({ phase: "history-check", piHistoryUnchanged: true, claudeHistoryUnchanged: true, toolExecutions });
  await mainWork;
  await control.session.prompt("Do not call any tools. Reply only DONE.");
  const next = main.turns.at(-1).usage, cold = control.turns.at(-1).usage;
  const initial = main.turns[0].usage;
  const prefixTokens = initial.input + initial.cacheRead + initial.cacheWrite;
  log({ phase: "comparison", warmDownstream: usage(next), controlDownstream: usage(cold), toolExecutions,
    elapsedSeconds: Math.floor((Date.now() - wallStart) / 1000) });
  assert.equal(toolExecutions, 1, "only the real main request may execute the synthetic tool");
  assert(probeHit, "forced-short test must warm during the waiting tool");
  assert(next.cacheRead >= prefixTokens * 0.8, "warm must preserve the actual downstream prefix after >5 minutes");
  const distinctPrefixBenefit = next.cacheRead - cold.cacheRead;
  log({ phase: "passed", model: stubModel.id, originalHistoryUnchanged: true,
    downstreamCacheHit: true, downstreamBenefitVerified: initialCacheTtl === "5m" && distinctPrefixBenefit > 4_000,
    initialCacheTtl, distinctPrefixBenefit,
    caveat: initialCacheTtl === "1h" ? "control can still hit the 1h prefix; 5m comparison cannot prove a warm-caused benefit" : undefined });
} finally {
  await main.stop();
  await main.session.abort(); await control?.session.abort();
  main.session.dispose(); control?.session.dispose();
}
}
