import { createHash } from "node:crypto";
import type { WarmLogEvent } from "./log.ts";

type Entry = Omit<WarmLogEvent, "ts"> & { event: string };
interface Route { sessionId: string; provider: string; modelId: string; api: string }
interface Snapshot { route: Route; settings: string; items: string[]; responseId: string | null }
interface Active { snapshot: Snapshot; request: number; previousResponseId: string | null;
  routeChanged: boolean | null; settingsChanged: boolean | null; prefixChanged: boolean | null; received: boolean }

// These are provider-boundary parsers, not assertions about arbitrary provider data.
// Optional provider fields have no universal schema; keep unknown confined to these parsers.
/* oxlint-disable anti-slop/no-unsafe-dictionary-type, anti-slop/no-runtime-typeof */
function object<Value>(value: Value): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  // SAFETY: non-null non-array object checked above; each property is parsed below.
  return value as Record<string, unknown>;
}
function text<Value>(value: Value): string | null { return typeof value === "string" ? value : null; }
function tokens<Value>(value: Value): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
/* oxlint-enable anti-slop/no-unsafe-dictionary-type, anti-slop/no-runtime-typeof */
const hash = <Value>(value: Value): string => createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex");

/** Main-agent observations only. Never changes requests or probe/cost accounting. */
export class CacheDiagnostics {
  private enabled = false;
  private sequence = 0;
  private previous?: Snapshot;
  private active?: Active;
  private write: (entry: Entry) => void;
  constructor(write: (entry: Entry) => void) { this.write = write; }

  configure(enabled: boolean): void {
    if (enabled !== this.enabled) this.reset();
    this.enabled = enabled;
  }
  reset(): void { this.previous = undefined; this.active = undefined; this.sequence = 0; }
  cancelPending(): void { this.active = undefined; }

  capture<Payload>(payload: Payload, route: Route): void {
    if (!this.enabled) return;
    if (this.previous?.route.sessionId !== route.sessionId) this.reset();
    const body = object(payload);
    if (!body) { this.active = undefined; this.previous = undefined; return; }
    const { input, messages, ...settings } = body;
    const content = Array.isArray(input) ? input : Array.isArray(messages) ? messages : [];
    const snapshot: Snapshot = { route, settings: hash(settings), items: content.map(hash), responseId: null };
    const prev = this.previous;
    const active: Active = {
      snapshot, request: ++this.sequence, previousResponseId: prev?.responseId ?? null, received: false,
      routeChanged: prev ? (["provider", "modelId", "api"] as const).some(key => prev.route[key] !== route[key]) : null,
      settingsChanged: prev ? prev.settings !== snapshot.settings : null,
      prefixChanged: prev ? !prev.items.every((item, index) => item === snapshot.items[index]) : null,
    };
    this.active = active;
    this.previous = snapshot;
    this.emit("cache_diagnostic_request", {
      settingsHash: snapshot.settings, cacheKeyHash: hash(body.prompt_cache_key),
      inputItems: snapshot.items.length,
    });
  }

  headers<Headers>(headers: Headers, status: number): void {
    if (!this.enabled || !this.active || this.active.received) return;
    const entry = Object.entries(object(headers) ?? {}).find(([key]) => key.toLowerCase() === "x-request-id");
    this.emit("cache_diagnostic_http", { status, requestId: text(entry?.[1]) });
  }

  stream<Data>(data: Data, provider: string, modelId: string): void {
    const active = this.active;
    if (!this.enabled || !active || active.received || active.snapshot.route.provider !== provider || active.snapshot.route.modelId !== modelId) return;
    const event = object(data);
    const terminal = text(event?.type);
    if (!terminal || !["response.completed", "response.incomplete", "response.failed"].includes(terminal)) return;
    const response = object(event?.response);
    if (!response) return;
    const usage = object(response.usage);
    const details = object(usage?.input_tokens_details);
    const cached = tokens(details?.cached_tokens);
    const reason = terminal !== "response.completed" ? "non_completed_response"
      : cached === null ? "raw_usage_missing_or_invalid"
      : cached > 0 ? "cache_read_reported"
      : active.routeChanged === null ? "no_prior_request"
      : active.routeChanged ? "route_changed"
      : active.settingsChanged ? "settings_changed"
      : active.prefixChanged ? "prefix_changed" : "provider_zero_cache_unknown_cause";
    active.snapshot.responseId = text(response.id);
    this.emit("cache_diagnostic_response", {
      responseId: active.snapshot.responseId, terminalEvent: terminal,
      inputTokens: tokens(usage?.input_tokens), cachedTokens: cached,
      cachedTokensPresent: details ? Object.hasOwn(details, "cached_tokens") : false,
      cacheWriteTokens: tokens(details?.cache_write_tokens),
      returnedModel: text(response.model), serviceTier: text(response.service_tier),
      reason,
    });
    active.received = true;
  }

  finish(): void {
    if (this.enabled && this.active && !this.active.received) {
      this.emit("cache_diagnostic_response", { reason: "raw_response_unavailable", cachedTokens: null, responseId: null });
    }
    this.active = undefined;
  }

  private emit(event: string, fields: Omit<Entry, "event">): void {
    const active = this.active;
    if (!active) return;
    this.write({ event, source: "real_turn", ...active.snapshot.route, request: active.request,
      previousResponseId: active.previousResponseId, routeChanged: active.routeChanged,
      settingsChanged: active.settingsChanged, prefixChanged: active.prefixChanged, ...fields });
  }
}
