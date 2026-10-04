import assert from "node:assert/strict";
import { FinalPayloadCapture } from "../src/payload-capture.ts";

const model = { provider: "openai-codex", id: "gpt-6-luna" };
const captured = [];
const runtime = { streamSimple: async (model, _context, options) => {
  const payload = { input: [{ role: "user", content: "unchanged" }], reasoning: { effort: "low" } };
  return (await options?.onPayload?.(payload, model)) ?? payload;
} };
const original = runtime.streamSimple;
const ctx = { model, modelRegistry: { runtime } };
const capture = new FinalPayloadCapture((payload) => captured.push(structuredClone(payload)));
assert(capture.install(ctx));
const wrapped = runtime.streamSimple;
assert(capture.install(ctx));
assert.equal(runtime.streamSimple, wrapped, "install must be idempotent");
const actual = await runtime.streamSimple(model, {}, { onPayload: async payload => {
  assert(capture.observe(ctx)); // warm-cache hook runs first
  await Promise.resolve();
  return { ...payload, service_tier: "priority" }; // later extension replaces object
} });
assert.deepEqual(captured, [actual]);
assert.equal(captured[0].service_tier, "priority");
await runtime.streamSimple(model, {}, { onPayload: payload => { capture.observe(ctx); payload.service_tier = "default"; } });
assert.equal(captured[1].service_tier, "default", "in-place mutation with undefined return");
await runtime.streamSimple(model, {}, { onPayload: payload => payload });
assert.equal(captured.length, 2, "probes/native/advisor calls without the real hook must be ignored");
await assert.rejects(runtime.streamSimple(model, {}, { onPayload: () => { capture.observe(ctx); throw new Error("hook failure"); } }));
assert.equal(captured.length, 2, "failed transforms cannot become anchors");
await Promise.all(["priority", "default"].map(service_tier => runtime.streamSimple(model, {}, {
  onPayload: async payload => { capture.observe(ctx); await new Promise(resolve => setImmediate(resolve)); return { ...payload, service_tier }; },
})));
assert.deepEqual(captured.slice(2).map(p => p.service_tier).sort(), ["default", "priority"]);
const laterWrapper = (...args) => wrapped(...args);
runtime.streamSimple = laterWrapper;
capture.dispose();
assert.equal(runtime.streamSimple, laterWrapper, "do not overwrite a later wrapper on dispose");
await runtime.streamSimple(model, {}, { onPayload: payload => { assert.equal(capture.observe(ctx), false); return payload; } });
assert.equal(captured.length, 4, "disposed wrapper must be inert");
assert.equal(capture.install({ modelRegistry: {} }), false);
runtime.streamSimple = original;
assert(capture.install(ctx));
capture.dispose();
assert.equal(runtime.streamSimple, original);
let unavailable = 0;
const brokenCapture = new FinalPayloadCapture(() => { throw new Error("observer failed"); }, () => unavailable++);
assert(brokenCapture.install(ctx));
const unchanged = await runtime.streamSimple(model, {}, { onPayload: payload => { brokenCapture.observe(ctx); return payload; } });
assert.equal(unchanged.input[0].content, "unchanged", "observability failure cannot fail a real request");
assert.equal(unavailable, 1);
await runtime.streamSimple({ ...model, id: "different-model" }, {}, { onPayload: payload => { brokenCapture.observe(ctx); return payload; } });
assert.equal(unavailable, 2, "a redirected model must invalidate rather than warm the selected route");
brokenCapture.dispose();
console.log("final payload capture: all assertions passed");
