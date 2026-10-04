import assert from "node:assert/strict";
import diagnostics from "./cache-diagnostics.mjs";

const handlers = new Map();
diagnostics({ on: (name, handler) => handlers.set(name, handler) });
const output = [];
const write = process.stderr.write;
const statsKey = Symbol.for("pi-warm-cache.diagnostic-stats");
const originalStats = globalThis[statsKey];
process.stderr.write = text => { output.push(JSON.parse(text)); return true; };
try {
  const payload = { input: [{ role: "user", content: "private fixture text" }], prompt_cache_key: "private session key", tools: [] };
  const before = structuredClone(payload);
  assert.equal(handlers.get("before_provider_request")({ payload }), undefined);
  assert.deepEqual(payload, before);
  handlers.get("before_provider_request")({ payload: { ...payload, input: [...payload.input, { role: "user", content: "next" }] } });
  assert.equal(output[1].previousPrefixPreserved, true);
  globalThis[statsKey] = () => ({ requests: 2, connectionsCreated: 1, connectionsReused: 1, deltaRequests: 1, fullContextRequests: 1, websocketFailures: 0, sseFallbacks: 0, lastWebSocketError: "must not log errors verbatim" });
  handlers.get("provider_stream_event")({ data: { type: "response.completed", response: {
    model: "gpt-6-luna", service_tier: "default", usage: { input_tokens: 2000, input_tokens_details: { cached_tokens: 1792, cache_write_tokens: 0 } },
  } } }, { sessionManager: { getSessionId: () => "session" } });
  assert.equal(output[2].cachedTokens, 1792);
  assert.equal(output[2].transport.connectionsReused, 1);
  const serialized = JSON.stringify(output);
  for (const secret of ["private fixture text", "private session key", "must not log errors verbatim"]) assert(!serialized.includes(secret));
  handlers.get("session_start")();
  handlers.get("before_provider_request")({ payload });
  assert.equal(output[3].request, 1);
  assert.equal(output[3].previousPrefixPreserved, null);
} finally {
  process.stderr.write = write;
  if (originalStats === undefined) delete globalThis[statsKey];
  else globalThis[statsKey] = originalStats;
}
console.log("cache diagnostics: all assertions passed");
