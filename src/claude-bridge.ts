import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatDurationShort } from "./config.ts";
import { payloadObject } from "./capability.ts";
import type { StrategyResolution } from "./provider.ts";
import { DEFAULT_CONFIG, type ProviderCapability, type WarmCacheConfig } from "./types.ts";
import type { SessionWarmer, WarmReplayTransport } from "./warmer.ts";

/** Explicit cooperation, not a patch of the bridge's private query/session state. */
export const CLAUDE_BRIDGE_WARM_CONTROL = "claude-bridge:cache-warm:v1";

export interface BridgeAnchorMetadata {
  bridgeAnchor: string;
  continuity: string;
  ready: boolean;
  /** Observed on the real SDK response, never inferred from the model name. */
  cacheTtl: "1h" | "5m" | "unknown";
}
export interface BridgeWarmLease {
  metadata: BridgeAnchorMetadata;
  modelId: string;
  requestStartedAt: number;
  complete(config: WarmCacheConfig, signal: AbortSignal): Promise<AssistantMessage>;
  release(): void;
}
export type BridgeWarmNotice =
  | { kind: "available" }
  | { kind: "unavailable"; reason: string }
  | { kind: "start" | "anchor"; lease: BridgeWarmLease };
export interface BridgeWarmControl {
  version: 1;
  sessionId: string;
  receive: (notice: BridgeWarmNotice) => void;
  attach: boolean;
}

/** The standard scheduler/gate/UI is shared with native API warming. */
export class ClaudeBridgeTransport implements WarmReplayTransport {
  private ctx?: ExtensionContext;
  private warmer?: SessionWarmer;
  private available = false;
  private reason = "claude-bridge needs the cache-warm v1 adapter; stock 0.9.0 is not supported";
  private lease?: BridgeWarmLease;
  private sessionId?: string;
  private continuity?: string;
  private observedCacheTtl: BridgeAnchorMetadata["cacheTtl"] = "unknown";
  private pi: ExtensionAPI;
  private receive = (notice: BridgeWarmNotice) => this.onNotice(notice);

  constructor(pi: ExtensionAPI) { this.pi = pi; }
  bind(warmer: SessionWarmer): void { this.warmer = warmer; }

  configure(ctx: ExtensionContext, config: WarmCacheConfig): void {
    if (!this.supports(ctx.model) || !config.enabled) { this.dispose(); return; }
    const sessionId = ctx.sessionManager.getSessionId();
    if (this.sessionId && this.sessionId !== sessionId) this.dispose();
    this.ctx = ctx;
    this.sessionId = sessionId;
    this.pi.events.emit(CLAUDE_BRIDGE_WARM_CONTROL, {
      version: 1, sessionId, receive: this.receive, attach: true,
    } satisfies BridgeWarmControl);
  }

  invalidate(): void { this.lease?.release(); this.lease = undefined; }
  dispose(): void {
    if (this.sessionId) {
      this.pi.events.emit(CLAUDE_BRIDGE_WARM_CONTROL, {
        version: 1, sessionId: this.sessionId, receive: this.receive, attach: false,
      } satisfies BridgeWarmControl);
    }
    this.invalidate();
    this.ctx = undefined; this.sessionId = undefined; this.available = false;
    this.continuity = undefined; this.observedCacheTtl = "unknown";
  }

  supports(model: ExtensionContext["model"]): boolean {
    return model?.provider === "claude-bridge" && model.api === "claude-bridge" && model.baseUrl === "claude-bridge";
  }
  capability<Payload>(payload?: Payload): ProviderCapability {
    const supported = this.available && (payload === undefined || this.isCurrent(payload));
    return {
      state: supported ? "verified" : "unsupported",
      reason: supported ? "claude-bridge cache-warm v1: isolated SDK fork (prefix-based)" : this.reason,
      automaticWarm: supported,
      manualProbe: supported,
    };
  }
  strategy(config: WarmCacheConfig): StrategyResolution {
    // Claude Code does not expose cache_control options, but its actual usage
    // reports the write TTL. Never claim 1h from a preference alone or when a
    // mixed 5m/1h response still needs short-cadence refreshing.
    const long = this.observedCacheTtl === "1h" && config.anthropicTtl !== "5m";
    const shortMs = 240_000;
    const longMs = 50 * 60_000;
    const customInterval = config.intervalMs !== DEFAULT_CONFIG.intervalMs && config.intervalMs !== null;
    const intervalMs = long
      ? Math.max(1_000, Math.min(customInterval ? config.intervalMs! : longMs, longMs))
      : Math.max(1_000, Math.min(config.intervalMs ?? shortMs, shortMs));
    return {
      capability: this.capability(), family: long ? "anthropic-long" : "anthropic-short",
      cacheRetention: long ? "long" : "short",
      intervalMs, ttlLabel: long ? "Claude Code observed 1h cache TTL" :
        this.observedCacheTtl === "5m" ? "Claude Code observed 5m/mixed cache TTL" :
          this.observedCacheTtl === "1h" ? "Claude Code observed 1h cache TTL (short cadence requested)" :
            "Claude Code cache TTL unknown (conservative 5m cadence)",
      waitLabel: formatDurationShort(intervalMs), automaticWarm: true, manualProbe: true,
      longTtlDegradedReason: config.anthropicTtl === "1h" && !long
        ? "claude-bridge has no 1h-only usage evidence; using at most 4m cadence" : null,
    };
  }
  private isCurrent<Payload>(payload: Payload): boolean {
    return Boolean(this.lease && payloadObject(payload)?.bridgeAnchor === this.lease.metadata.bridgeAnchor);
  }
  isSafe<Payload>(payload: Payload): boolean { return this.isCurrent(payload) && this.lease?.metadata.ready === true; }
  isContinuation<Previous, Next>(previous: Previous, next: Next): boolean {
    const prior = payloadObject(previous)?.continuity;
    return Boolean(prior && prior === payloadObject(next)?.continuity);
  }
  complete<Payload>(payload: Payload, config: WarmCacheConfig, signal: AbortSignal): Promise<AssistantMessage> {
    if (!this.isSafe(payload) || !this.lease) return Promise.reject(new Error("claude-bridge anchor unavailable or superseded"));
    return this.lease.complete(config, signal);
  }

  private onNotice(notice: BridgeWarmNotice): void {
    if (!this.ctx || !this.sessionId) return;
    if (notice.kind === "available") { this.available = true; return; }
    if (notice.kind === "unavailable") {
      this.invalidate(); this.available = false; this.reason = notice.reason;
      if (this.supports(this.ctx.model)) this.warmer?.invalidateAnchor(this.ctx, notice.reason);
      return;
    }
    const { lease } = notice;
    if (!this.supports(this.ctx.model) || lease.modelId !== this.ctx.model?.id) { lease.release(); return; }
    if (this.continuity !== lease.metadata.continuity) {
      this.continuity = lease.metadata.continuity;
      this.observedCacheTtl = "unknown";
    }
    if (lease.metadata.cacheTtl !== "unknown") this.observedCacheTtl = lease.metadata.cacheTtl;
    this.available = true;
    if (this.lease !== lease) this.lease?.release();
    this.lease = lease;
    if (notice.kind === "start") {
      this.warmer?.onProviderRequestStart(lease.metadata, this.ctx, lease.requestStartedAt);
    } else {
      // Publish before Pi's message_end, which supplies the normal usage and
      // clears the provider-in-flight flag. Never count a warm result as real.
      this.warmer?.capturePayload(lease.metadata, this.ctx, lease.requestStartedAt);
    }
  }
}
