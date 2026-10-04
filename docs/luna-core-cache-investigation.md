# Luna core-only cache investigation — 2026-10-04

## Scope

Pi 1.0.0, openai-codex/gpt-6-luna, reasoning low, synthetic 18k-token reference
and repeated read-only LICENSE tool calls. All functionality extensions were
disabled, and native warming was off in temporary project settings. Only a
diagnostic observer was loaded. Global settings and installed packages were not
changed. Each group used a fresh session and directory.

## Results

| Group | Requests | Hits after initial cold request | Transport evidence |
| --- | ---: | ---: | --- |
| auto | 15 | 14/14 | 1 connection, 14 delta requests, no failure/fallback |
| auto + comparison ID | 7 | 6/6 | 1 connection, 7 full requests, no failure/fallback |
| force reconnect before every request | 11 | 10/10 | 11 connections, 11 full requests, no failure/fallback |
| SSE | 15 | 14/14 | Explicit SSE setting; no WebSocket stats |

All 44 follow-up requests hit. Cached tokens ranged from 17,920 to 19,968.
Raw provider cached-token usage matched Pi's normalized usage. Returned model
and service tier remained `gpt-6-luna` and `default`. Every previous serialized
input prefix was preserved; ordinary request settings were stable within each
group (the comparison group intentionally injected a changing comparison ID).

The preload reads the debug statistics from the **CLI's bundled provider**.
Importing the separate pi-ai installation can observe a different module's empty
state, so a missing metric alone must not be interpreted as SSE or no connection.

## Diagnostic limitation

The Codex endpoint accepted `prompt_cache_options.comparison_response_id` in this
test but returned `prompt_cache_diagnostics.type=unavailable`, not a cause.
Ordinary auto requests also returned unavailable diagnostics after the first.
Changing the comparison ID disables Pi's delta optimization because its local
continuation comparison includes all non-input fields. Therefore that group is
not a transport-neutral observation of the auto group, even though all its
follow-up requests hit. Do not enable it by default as a proposed fix.

Official reference: https://developers.openai.com/api/docs/guides/prompt-caching/diagnostics

## What remains unresolved

The earlier core-only `hit → miss → hit` is real in the recorded Pi usage, but
was not reproduced in these 48 requests. This rules out a deterministic miss
after each tool call in this fixture. It does not rule out intermittent backend
availability, routing, or a transport failure absent from this sample. Reconnect
alone was not sufficient to produce a miss. SSE is not a proven fix.

Do not claim the final-payload capture fix explains the earlier core-only event.
A failing request with both raw usage and transport telemetry is still needed.
These short runs do not cover long idle periods, compaction, large tool outputs,
or the user's actual project extensions.

## Local evidence

- `/tmp/pi-luna-transport-auto-ChQndI/result.json`
- `/tmp/pi-luna-transport-compare-aw1guJ/result.json`
- `/tmp/pi-luna-transport-reconnect-lPGZT7/result.json`
- `/tmp/pi-luna-transport-sse-YTspDV/result.json`
- Harness: `/tmp/pi-luna-investigation-hdS3Tc/transport-run.cjs`

## Capture a future occurrence

From this repository, run the installed Pi with the optional read-only observer:

```sh
node --import ./scripts/cache-diagnostics-preload.mjs /opt/homebrew/bin/pi \
  -e ./scripts/cache-diagnostics.mjs 2> /tmp/pi-cache-diagnostics.jsonl
```

This does not enable warming, change transport/settings, inject diagnostic API
options, or store raw prompts/credentials. It logs full SHA-256 hashes, counts,
returned tier/model, and allowlisted connection statistics to stderr. Other Pi
stderr messages may appear in the redirected file; inspect before sharing.
The scripts are repository tools and are not included in the npm package.

Load the observer last when investigating other extensions. Its request hashes
describe the payload at its own hook position, not guaranteed wire-level bytes.
`transport: null` means telemetry unavailable (including SSE), not proof of no
transport error. This observer assumes sequential main-agent requests; do not
use its request numbering to correlate concurrent independent provider calls.
The preload is best-effort and supports the tested bundled Pi CLI layout.
