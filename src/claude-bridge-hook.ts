/**
 * Optional producer installed in pi-claude-bridge, NOT a replacement provider.
 * The bridge supplies its official SDK query and inert MCP-server factory.
 * All request options stay inside the bridge closure; no credentials or prompt
 * text are emitted on the event bus, logged, or inserted in Pi's conversation.
 */
import { createHash, randomUUID } from "node:crypto";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { payloadObject, type PayloadObject } from "./capability.ts";
import { CLAUDE_BRIDGE_WARM_CONTROL, type BridgeWarmControl, type BridgeWarmLease } from "./claude-bridge.ts";
import type { WarmCacheConfig } from "./types.ts";

export interface BridgeSdkQuery extends AsyncIterable<unknown> { close(): void }
export interface BridgeCacheTool { name: string; description: string; inputSchema: unknown }
export interface BridgeSdkMcpServer { type: "sdk"; name: string; instance: object }
/** SDK options used by the stock bridge; other extension shapes are refused. */
export interface BridgeSdkOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  tools?: unknown[];
  settings?: PayloadObject;
  systemPrompt?: unknown;
  extraArgs?: Record<string, string | null>;
  effort?: string;
  thinking?: { type: string; budgetTokens?: number };
  maxThinkingTokens?: number;
  mcpServers?: Record<string, BridgeSdkMcpServer>;
  resume?: string;
  forkSession?: boolean;
  persistSession?: boolean;
  maxTurns?: number;
  includePartialMessages?: boolean;
  abortController?: AbortController;
  promptSuggestions?: boolean;
  agentProgressSummaries?: boolean;
  permissionMode?: string;
  hooks?: object;
  canUseTool?: () => Promise<{ behavior: "deny"; message: string }>;
  pathToClaudeCodeExecutable?: string;
  stderr?: (text: string) => void;
  debug?: boolean;
  debugFile?: string;
  agents?: object;
  agent?: string;
  plugins?: unknown[];
  outputFormat?: object;
  sessionStore?: object;
  sessionId?: string;
  continue?: boolean;
  resumeSessionAt?: string;
}
export interface BridgeCacheDependencies {
  query(prompt: string, options: BridgeSdkOptions): BridgeSdkQuery;
  /** Must build fresh SDK MCP servers, with no reference to Pi execution. */
  inertMcpServers(tools: BridgeCacheTool[]): Record<string, BridgeSdkMcpServer> | undefined;
}
export interface BridgeCacheCapture {
  start(): void;
  observe<Message>(message: Message): void;
  invalidate(): void;
}
const hash = <Value>(value: Value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Only an actual cache write identifies the SDK route's TTL. Mixed writes
 * require short cadence; cache reads alone do not reveal the expiry time. */
function cacheTtlFromUsage<Usage>(value: Usage): "1h" | "5m" | undefined {
  const usage = payloadObject(value);
  const creation = payloadObject(usage?.cache_creation);
  const short = Number(creation?.ephemeral_5m_input_tokens ?? 0);
  const long = Number(creation?.ephemeral_1h_input_tokens ?? 0);
  if (Number.isFinite(short) && short > 0) return "5m";
  if (Number.isFinite(long) && long > 0) return "1h";
  return undefined;
}

/** Only first-party, Pi-tools-only requests have this safety contract. */
export function bridgeCacheRefusal(options: BridgeSdkOptions): string | null {
  const env = payloadObject(options.env) ?? {};
  if (!Array.isArray(options.tools) || options.tools.length !== 0 ||
      !Object.hasOwn(payloadObject(options.extraArgs) ?? {}, "strict-mcp-config")) {
    return "claude-bridge warming requires tools:[] and strict MCP configuration";
  }
  if (env.ANTHROPIC_BASE_URL || env.CLAUDE_CODE_USE_BEDROCK || env.CLAUDE_CODE_USE_VERTEX ||
      env.CLAUDE_CODE_USE_FOUNDRY || env.CLAUDE_CODE_EXTRA_BODY) {
    return "claude-bridge warming cannot verify custom routes or EXTRA_BODY overrides";
  }
  if (options.agents || options.agent || options.plugins || options.outputFormat || options.sessionStore ||
      options.sessionId || options.continue || options.resumeSessionAt || options.settings?.autoMemoryEnabled === true) {
    return "claude-bridge warming cannot isolate custom agents, plugins, output formats, or session stores";
  }
  return null;
}

/** Observe SDK messages while leaving the bridge's real query untouched. */
export function createClaudeBridgeCacheHook(pi: Pick<ExtensionAPI, "events">, dependencies: BridgeCacheDependencies) {
  const subscribers = new Map<string, BridgeWarmControl["receive"]>();
  const unsubscribe = pi.events.on(CLAUDE_BRIDGE_WARM_CONTROL, <Value>(value: Value) => {
    const body = payloadObject(value);
    // A versioned inter-extension boundary: unknown versions fail closed.
    // oxlint-disable-next-line anti-slop/no-runtime-typeof
    if (body?.version !== 1 || typeof body.sessionId !== "string" || typeof body.receive !== "function") return;
    // SAFETY: the version, session key, and callback have been checked at the bus boundary.
    const control = value as BridgeWarmControl;
    if (control.attach === true) {
      subscribers.set(control.sessionId, control.receive);
      control.receive({ kind: "available" });
    } else if (subscribers.get(control.sessionId) === control.receive) subscribers.delete(control.sessionId);
  });
  return {
    dispose(): void { unsubscribe(); subscribers.clear(); },
    capture(model: Model<any>, sessionId: string | null, realOptions: BridgeSdkOptions, tools: BridgeCacheTool[]): BridgeCacheCapture | undefined {
      const receive = sessionId ? subscribers.get(sessionId) : undefined;
      if (!receive || model.provider !== "claude-bridge" || model.api !== "claude-bridge") return;
      const refusal = bridgeCacheRefusal(realOptions);
      if (refusal) { receive({ kind: "unavailable", reason: refusal }); return; }
      // Freeze prompt/tool/settings identity. Do not carry normal MCP handlers,
      // callbacks, AbortSignals, or mutable real output into a background fork.
      const inertTools = structuredClone(tools);
      const options: BridgeSdkOptions = { ...realOptions,
        env: { ...realOptions.env },
        settings: structuredClone(realOptions.settings ?? {}),
        extraArgs: { ...realOptions.extraArgs },
        systemPrompt: structuredClone(realOptions.systemPrompt),
      };
      const identity = hash({ system: options.systemPrompt, tools: inertTools,
        effort: options.effort, thinking: options.thinking, settings: options.settings,
        model: payloadObject(options.extraArgs)?.model });
      let ccSessionId = String(options.resume ?? "");
      let lease: BridgeWarmLease | undefined;
      let valid = false;
      let requestStartedAt = Date.now();
      const capture: BridgeCacheCapture = {
        start() {
          valid = false;
          const token = randomUUID();
          requestStartedAt = Date.now();
          valid = true;
          const next: BridgeWarmLease = {
            metadata: { bridgeAnchor: token, continuity: hash([ccSessionId, identity]), ready: false, cacheTtl: "unknown" },
            modelId: model.id, requestStartedAt,
            release() { if (lease === next) valid = false; },
            complete(config, signal) {
              if (!valid || lease !== next || !next.metadata.ready || !ccSessionId || signal.aborted) {
                return Promise.reject(new Error("claude-bridge fork superseded or unavailable"));
              }
              return completeBridgeFork(model, ccSessionId, options, inertTools, config, signal, dependencies);
            },
          };
          lease = next;
          receive({ kind: "start", lease: next });
        },
        observe(value) {
          // Observability must never make a working real provider fail.
          try {
            const message = payloadObject(value);
            if (message?.type === "system" && message.subtype === "init" && message.session_id) {
              ccSessionId = String(message.session_id);
            }
            const event = payloadObject(message?.event);
            const usage = payloadObject(event?.message)?.usage ?? event?.usage ??
              payloadObject(message?.message)?.usage ?? message?.usage;
            const ttl = cacheTtlFromUsage(usage);
            if (ttl && lease && valid) {
              lease.metadata.cacheTtl = ttl === "5m" || lease.metadata.cacheTtl === "5m" ? "5m" : "1h";
            }
            if (message?.type === "stream_event" && event?.type === "message_stop" && lease && valid) {
              lease.metadata = { ...lease.metadata, continuity: hash([ccSessionId, identity]), ready: Boolean(ccSessionId) };
              receive({ kind: "anchor", lease });
            }
          } catch { /* An unavailable capture must not interrupt a real turn. */ }
        },
        invalidate() {
          valid = false;
          receive({ kind: "unavailable", reason: "claude-bridge request aborted; waiting for next real turn" });
        },
      };
      capture.start();
      return capture;
    },
  };
}

function number<Value>(value: Value): number { return Number.isFinite(value) && Number(value) >= 0 ? Number(value) : 0; }

/** Public SDK fork; never pass this request through streamClaudeAgentSdk. */
export async function completeBridgeFork(
  model: Model<any>, ccSessionId: string, realOptions: BridgeSdkOptions, tools: BridgeCacheTool[],
  config: WarmCacheConfig, signal: AbortSignal, dependencies: BridgeCacheDependencies,
): Promise<AssistantMessage> {
  const refusal = bridgeCacheRefusal(realOptions);
  if (refusal || !ccSessionId || signal.aborted) throw new Error(refusal ?? "claude-bridge fork unavailable");
  const env = { ...realOptions.env };
  const thinking = payloadObject(realOptions.thinking);
  // CC derives its thinking budget from the output ceiling when thinking is
  // implicit. Lowering this env var silently changes cache identity. Only an
  // explicitly disabled/fixed budget can safely use our own output ceiling.
  const disabled = thinking?.type === "disabled" || realOptions.maxThinkingTokens === 0 ||
    env.MAX_THINKING_TOKENS === "0" || env.CLAUDE_CODE_DISABLE_THINKING === "1";
  const fixedThinking = thinking?.type === "enabled" ? number(thinking.budgetTokens)
    : number(realOptions.maxThinkingTokens);
  const maxOutput = disabled || fixedThinking > 0
    ? Math.max(1, config.maxOutputTokens, fixedThinking + 1) : undefined;
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const timer = setTimeout(abort, 60_000);
  const options: BridgeSdkOptions = {
    ...realOptions,
    // Both are essential: fork isolates the source, false prevents saving the
    // keepalive prompt/output. The original session remains the resume target.
    resume: ccSessionId, forkSession: true, persistSession: false,
    maxTurns: 1, includePartialMessages: true, abortController: controller,
    tools: [], mcpServers: dependencies.inertMcpServers(structuredClone(tools)),
    promptSuggestions: false, agentProgressSummaries: false,
    settings: { ...payloadObject(realOptions.settings), disableAllHooks: true },
    hooks: {}, canUseTool: async () => ({ behavior: "deny", message: "Cache keepalive never executes tools" }),
    // Do not lower effort/thinking. Output controls are not cache identity.
    env: maxOutput === undefined ? { ...env, CLAUDE_CODE_MAX_RETRIES: "0" }
      : { ...env, CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(maxOutput), CLAUDE_CODE_MAX_RETRIES: "0" },
    stderr: () => {}, debug: false, debugFile: undefined,
  };
  let query: BridgeSdkQuery | undefined;
  const close = () => { try { query?.close(); } catch { /* already closed */ } };
  controller.signal.addEventListener("abort", close, { once: true });
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  let sawUsage = false;
  let stopReason: AssistantMessage["stopReason"] = "stop";
  const observeUsage = <Usage>(value: Usage) => {
    const u = payloadObject(value);
    if (!u) return;
    if (u.input_tokens !== undefined) { usage.input = Math.max(usage.input, number(u.input_tokens)); sawUsage = true; }
    if (u.output_tokens !== undefined) usage.output = Math.max(usage.output, number(u.output_tokens));
    if (u.cache_read_input_tokens !== undefined) usage.cacheRead = Math.max(usage.cacheRead, number(u.cache_read_input_tokens));
    if (u.cache_creation_input_tokens !== undefined) usage.cacheWrite = Math.max(usage.cacheWrite, number(u.cache_creation_input_tokens));
  };
  const finish = (): AssistantMessage => {
    usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
    return { role: "assistant", api: model.api, provider: model.provider, model: model.id,
      content: [], stopReason, timestamp: Date.now(), usage };
  };
  try {
    query = dependencies.query(config.warmSuffix, options);
    for await (const value of query) {
      if (controller.signal.aborted) throw new Error("claude-bridge fork aborted or timed out");
      const message = payloadObject(value);
      const event = payloadObject(message?.event);
      if (message?.type === "stream_event") {
        if (event?.type === "message_start") observeUsage(payloadObject(event.message)?.usage);
        if (event?.type === "message_delta") {
          observeUsage(event.usage);
          if (payloadObject(event.delta)?.stop_reason === "max_tokens") stopReason = "length";
        }
        // The first API reply is now complete and its cache counters are known.
        // Close here: CC treats max_tokens as an error and may try to recover;
        // a keepalive must never start a second generation or tool loop.
        if (event?.type === "message_stop" && sawUsage) return finish();
      }
      if (message?.type === "assistant") observeUsage(payloadObject(message.message)?.usage);
      if (message?.type === "result") {
        observeUsage(message.usage);
        if (!sawUsage || (message.subtype !== "success" && message.subtype !== "error_max_turns")) {
          throw new Error(`claude-bridge fork result: ${String(message.subtype ?? "error")}`);
        }
        return finish();
      }
    }
    throw new Error(controller.signal.aborted ? "claude-bridge fork aborted or timed out" : "claude-bridge fork ended without usage");
  } finally {
    close(); clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    controller.signal.removeEventListener("abort", close);
  }
}
