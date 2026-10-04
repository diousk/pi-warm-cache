# Final request capture and Luna miss investigation

Integration update: merged into local main on top of the upstream 0.2.6 release,
together with the earlier oversized adaptive-replay fallback. All merged tests,
typecheck, and lint pass. The version remains 0.2.6; no new npm release was made.

## Confirmed defect and fix

Pi runs `before_provider_request` handlers sequentially. Each handler can return
a new payload, so cloning inside warm-cache's handler captures only an intermediate
request. A later extension such as pi-usage-fast can add `service_tier` without
any user settings changing during the task.

The extension now wraps the session runtime's `streamSimple` payload callback and
captures its result after the complete hook chain finishes. The hook only marks
real agent requests and fences concurrent warming. Async-local request scopes
keep concurrent callbacks separate. Unmarked probes, advisor requests, and native
refreshes do not replace the main anchor. No real request is rewritten.

The private runtime API is checked before use. If capture is unavailable or the
request is redirected to a different model, the old anchor is invalidated rather
than replayed. Shutdown restores the runtime method only if we still own it;
wrappers retained by another extension become inert. A failure to capture does
not fail the real provider request.

## Verification

- Full unit suite, Pi 0.85.1 host compatibility, typecheck, and lint passed.
- Regression tests cover later replacement objects, async hooks, in-place edits,
  concurrent requests, unmarked probes, callback errors, redirected models,
  unsupported runtimes, repeated installation, and chained-wrapper cleanup.
- Actual Pi 1.0.0 / openai-codex / gpt-6-luna / low test: a later async hook
  returned a new payload containing `service_tier=default`. Both real request
  captures included that tier. An isolated 3-second warm interval was used.
- Fresh synthetic request: cacheRead=0. Warm probe: cacheRead=17,920.
  Next real user request: cacheRead=17,920, confirmed by raw provider usage.
  Local evidence: `/tmp/pi-final-payload-live-ZycUzg/result.json`.
- Repeated against the final source: the warm probe and next real request again
  both read 17,920 cached tokens. Evidence: `/tmp/pi-final-payload-live-f4Km7s/result.json`.
- No installed package or global configuration was changed. The repository is
  0.2.5 while the installed extension is 0.2.6; this is not a release or upgrade.

## Remaining uncertainty

An earlier core-only test (no warm-cache extension) produced cacheRead
`0, 17920, 0, 17920, 17920, 17920, 18944` while serialized prefixes and request
settings remained stable. Therefore the defect above is not a demonstrated
explanation for that miss. No evidence establishes a Pi rule forcing a miss
after every tool call, nor proves that switching transport eliminates it.

Determining that remaining cause requires a failing request with raw usage and
provider/transport diagnostics. Do not describe this fix as guaranteeing hits or
as proof of provider eviction. Public Responses API diagnostic availability
does not establish support on the separate Codex OAuth endpoint.
