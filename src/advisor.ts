import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Context, Model, Api, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { SessionWarmer } from "./warmer.ts";
import { DEFAULT_CONFIG, type WarmCacheConfig } from "./types.ts";

// Pinned rpiv-advisor prompt. Unknown/custom prompts fail closed.
export const ADVISOR_PROMPT_SHA256 = "f15062e9fdc0e3950bcad23c1e4cfb79bce81e04bd8f83b9ed2dd4103a1ed926";
export const CODEX_ADVISOR_MAX_INTERVAL_MS = 3 * 60_000;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export function isAdvisorRequest(context: Context): boolean {
  return Array.isArray(context.tools) && context.tools.length === 0 &&
    digest(context.systemPrompt ?? "") === ADVISOR_PROMPT_SHA256;
}
type Complete = (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => Promise<AssistantMessage>;
interface Runtime { completeSimple: Complete }
const OWNER = Symbol.for("pi-warm-cache.advisor-owner");
type OwnedRuntime = Runtime & { [OWNER]?: AdvisorWarmer };
function runtimeFromRegistry<Registry>(registry: Registry): OwnedRuntime | undefined {
  // SAFETY: optional private runtime is capability-checked before use below.
  return (registry as { runtime?: OwnedRuntime } | null)?.runtime;
}

// Selection is persisted by rpiv-advisor. Never read/store its credentials.
function selectionStamp(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const root = xdg && isAbsolute(xdg) ? xdg : join(homedir(), ".config");
  try { return digest(readFileSync(join(root, "rpiv-advisor", "advisor.json"), "utf8")); }
  catch { return "unavailable"; }
}

/** Optional bridge for Pi 0.85.1's private runtime; no global provider patch. */
export class AdvisorWarmer {
  private config: WarmCacheConfig = { ...DEFAULT_CONFIG };
  private ctx?: ExtensionContext;
  private runtime?: OwnedRuntime;
  private original?: Complete;
  private wrapper?: Complete;
  private child?: SessionWarmer;
  private childApi?: Api;
  private tools = new Map<string, string>();
  private generation = 0;
  private busy = false;
  private detail = "off";

  private pi: ExtensionAPI;
  constructor(pi: ExtensionAPI) { this.pi = pi; }

  configure(config: WarmCacheConfig, ctx: ExtensionContext): void {
    this.config = { ...config };
    this.ctx = ctx;
    if (!config.enabled || !config.warmAdvisor) { this.dispose(); this.detail = "off"; return; }
    this.child?.setConfig(this.childConfig(config, this.childApi));
    if (this.runtime) return;
    let runtime: OwnedRuntime | undefined;
    try { runtime = runtimeFromRegistry(ctx.modelRegistry); }
    catch { this.detail = "unavailable: Pi runtime access failed"; return; }
    // Compatibility boundary for a private host API, not domain data.
    // oxlint-disable-next-line anti-slop/no-runtime-typeof
    if (!runtime || typeof runtime.completeSimple !== "function") {
      this.detail = "unavailable: Pi runtime.completeSimple missing";
      return;
    }
    if (runtime[OWNER] && runtime[OWNER] !== this) {
      this.detail = "unavailable: runtime already owned by another session";
      return;
    }
    const original = runtime.completeSimple;
    const wrapper: Complete = (model, context, options) => this.wrapper === wrapper
      ? this.call(runtime, original, model, context, options)
      : original.call(runtime, model, context, options);
    try {
      runtime[OWNER] = this;
      runtime.completeSimple = wrapper;
      this.runtime = runtime; this.original = original; this.wrapper = wrapper;
      this.detail = "waiting for a supported advisor request";
    } catch {
      if (runtime[OWNER] === this) delete runtime[OWNER];
      this.detail = "unavailable: runtime cannot be wrapped";
    }
  }

  toolStart(id: string, name: string): void {
    if (!this.config.enabled || !this.config.warmAdvisor) return;
    this.tools.set(id, name);
    if (name === "advisor") this.invalidate("advisor working");
  }
  toolEnd(id: string): void {
    if (this.tools.get(id) === "advisor" && this.detail === "advisor working") {
      this.detail = "unavailable: advisor request was not captured";
    }
    this.tools.delete(id);
  }
  invalidate(reason: string): void {
    this.generation++;
    this.child?.dispose(); this.child = undefined;
    this.childApi = undefined;
    this.detail = this.config.enabled && this.config.warmAdvisor ? reason : "off";
  }
  dispose(): void {
    this.invalidate("off");
    if (this.runtime && this.runtime.completeSimple === this.wrapper && this.original) this.runtime.completeSimple = this.original;
    if (this.runtime && this.runtime[OWNER] === this) delete this.runtime[OWNER];
    this.runtime = undefined; this.original = undefined; this.wrapper = undefined;
    this.tools.clear();
  }
  status(): string { return `Advisor warming: ${this.child ? this.child.getStatusText() : this.detail}`; }

  private async call(runtime: Runtime, original: Complete, model: Model<Api>, context: Context, options?: SimpleStreamOptions): Promise<AssistantMessage> {
    const ctx = this.ctx;
    if (!ctx || !this.config.enabled || !this.config.warmAdvisor || this.busy ||
        this.tools.size !== 1 || ![...this.tools.values()].includes("advisor") || !isAdvisorRequest(context)) {
      return original.call(runtime, model, context, options);
    }
    this.invalidate("advisor working");
    const revision = this.generation;
    if (options?.cacheRetention === "none") {
      this.detail = "unavailable: advisor disabled caching";
      return original.call(runtime, model, context, options);
    }
    // The stock runtime path does not override authentication. Replaying a
    // custom override through the registry could silently select another account.
    if (options?.apiKey || options?.headers || options?.env || options?.fetch) {
      this.detail = "unavailable: custom advisor authentication or fetch options";
      return original.call(runtime, model, context, options);
    }
    this.busy = true;
    const sessionId = options?.sessionId ?? `warm-advisor-${digest(`${ctx.sessionManager.getSessionId()}:${model.provider}:${model.id}`)}`;
    const stamp = selectionStamp();
    let payload: unknown;
    let requestModel = model;
    const requestOptions: SimpleStreamOptions = {
      ...options, sessionId,
      onPayload: async (body, resolvedModel) => {
        const replacement = await options?.onPayload?.(body, resolvedModel);
        // Observation must never make a working advisor call fail.
        try { payload = structuredClone(replacement === undefined ? body : replacement); requestModel = resolvedModel; }
        catch { payload = undefined; }
        return replacement;
      },
    };
    try {
      const response = await original.call(runtime, model, context, requestOptions);
      if (revision !== this.generation || options?.signal?.aborted) return response;
      if (!payload || response.stopReason === "error" || response.stopReason === "aborted" || selectionStamp() !== stamp) {
        this.detail = "unavailable: no successful current advisor payload";
        return response;
      }
      // A separate lifecycle/context, not the executor's model or busy state.
      const childContext = new Proxy(ctx, {
        get: (target, key) => {
          if (key === "model") return requestModel;
          if (key === "thinkingLevel") return options?.reasoning ?? "off";
          if (key === "hasUI") return false;
          if (key === "sessionManager") return new Proxy(target.sessionManager, {
            get: (manager, name) => {
              if (name === "getSessionId") return () => sessionId;
              // SAFETY: proxy forwards unchanged properties of the original manager.
              return manager[name as keyof typeof manager];
            },
          });
          if (key === "isIdle") return () => {
            if (selectionStamp() !== stamp || !this.pi.getActiveTools().includes("advisor")) {
              this.invalidate("advisor selection changed or disabled");
              return false;
            }
            return true;
          };
          // SAFETY: proxy forwards unchanged properties of the original context.
          return target[key as keyof ExtensionContext];
        },
      });
      try {
        // Replay through auth-aware registry completion, but keep the real
        // request's transport. Never carry its expired signal or real-turn
        // callbacks into a background probe.
        const child = new SessionWarmer(
          this.pi,
          (m, c, probeOptions) => ctx.modelRegistry.complete(m, c, Object.assign({}, probeOptions, {
            transport: options?.transport,
            timeoutMs: options?.timeoutMs,
            websocketConnectTimeoutMs: options?.websocketConnectTimeoutMs,
            maxRetries: options?.maxRetries,
            maxRetryDelayMs: options?.maxRetryDelayMs,
          })),
          { exactCodexReplay: true },
        );
        this.child = child;
        this.childApi = requestModel.api;
        child.setConfig(this.childConfig(this.config, requestModel.api));
        child.bindContext(childContext);
        child.onProviderRequestStart(payload, childContext);
        child.onAssistantMessageEnd(childContext);
        child.noteAssistantUsage(childContext, response.usage);
        child.reschedule();
        this.detail = "captured";
      } catch { this.invalidate("unavailable: advisor capture failed"); }
      return response;
    } catch (error) {
      if (revision === this.generation) this.detail = "advisor request failed; no warm scheduled";
      throw error;
    } finally { this.busy = false; }
  }

  private childConfig(config: WarmCacheConfig, api?: Api): WarmCacheConfig {
    const intervalMs = api === "openai-codex-responses"
      ? Math.min(config.intervalMs ?? Number.POSITIVE_INFINITY, CODEX_ADVISOR_MAX_INTERVAL_MS)
      : config.intervalMs;
    return { ...config, intervalMs, showWidget: false };
  }
}
