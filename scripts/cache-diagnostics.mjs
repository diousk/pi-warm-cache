// Opt-in observer; never modifies provider payloads or user configuration.
import { createHash } from "node:crypto";

const hash = value => createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex");
const emit = (event, fields) => process.stderr.write(`${JSON.stringify({ diagnostic: "pi-cache", event, time: Date.now(), ...fields })}\n`);

export default function cacheDiagnostics(pi) {
  let request = 0;
  let previous;
  pi.on("session_start", () => { request = 0; previous = undefined; });
  pi.on("before_provider_request", event => {
    const { input = [], ...settings } = event.payload ?? {};
    const items = Array.isArray(input) ? input.map(hash) : [];
    emit("request", {
      request: ++request,
      settingsHash: hash(settings),
      cacheKeyHash: hash(settings.prompt_cache_key),
      items: items.length,
      previousPrefixPreserved: previous ? previous.every((item, i) => item === items[i]) : null,
    });
    previous = items;
  });
  pi.on("provider_stream_event", (event, ctx) => {
    if (event.data?.type !== "response.completed") return;
    const response = event.data.response;
    if (!response) return;
    const stats = globalThis[Symbol.for("pi-warm-cache.diagnostic-stats")]?.(ctx.sessionManager.getSessionId());
    emit("response", {
      request,
      inputTokens: response.usage?.input_tokens,
      cachedTokens: response.usage?.input_tokens_details?.cached_tokens,
      cacheWriteTokens: response.usage?.input_tokens_details?.cache_write_tokens,
      serviceTier: response.service_tier,
      model: response.model,
      comparisonType: response.prompt_cache_diagnostics?.type,
      comparisonReason: response.prompt_cache_diagnostics?.reason,
      transport: stats ? {
        requests: stats.requests,
        connectionsCreated: stats.connectionsCreated,
        connectionsReused: stats.connectionsReused,
        deltaRequests: stats.deltaRequests,
        fullContextRequests: stats.fullContextRequests,
        websocketFailures: stats.websocketFailures,
        sseFallbacks: stats.sseFallbacks,
      } : null,
    });
  });
}
