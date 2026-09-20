# pi-warm-cache

Keeps supported provider prompt caches warm during long idle gaps in Pi sessions.

Large prompts often sit in a provider cache.
That cache expires if you leave the session idle.
The next turn then pays a cold read or a costly rewrite.
This extension sends a small keepalive probe before that is likely to happen.

It supports [Pi](https://github.com/earendil-works/pi) 0.85.1 and 0.86.0.
CI runs tests, type checks, and lint against both versions. Development dependencies
remain pinned to 0.85.1; newer Pi-only APIs are isolated behind a compatibility layer.

### Pi 0.86 native cache warming

When this extension is enabled on a verified route, it owns automatic warming
and returns `stop` from Pi's `cache_warming_decision` event. Ownership remains
with the extension when its spend, failure, tool, or retention policy pauses
probes, so native warming cannot bypass those limits. Pi 0.85.1 stores the
event handler without emitting it; its scheduling behavior is unchanged.

When the extension is disabled or the route is not verified, Pi 0.86 may warm
according to its own `cacheWarming` setting. `/warm off` only disables this
extension. To disable both warmers, also set `"cacheWarming": "off"` in Pi's
global settings. This extension never changes that setting. `/warm status`
shows who owns warming; ownership does not mean a probe is currently scheduled.

Native warming reuses the provider-request hook without starting an agent turn.
The extension fences requests following a native decision until the next real
turn, so native probes do not reset its anchor, idle cutoff, or spend ledger.
Pi uses the last decision override: another extension loaded later can override
our `stop`. Avoid competing decision handlers, or disable Pi's native warmer
explicitly when strict single-warmer ownership is required.

Advisor recognition resolves the effective prompt and tools through Pi 0.86's
transcript helpers when available, with the 0.85.1 fields as fallback. Custom
prompts and effective nonempty tool inventories still fail closed.

## How it works

The extension copies the last real provider request and replays it with a tiny output limit.
It does not rebuild the conversation.
It does not change your real turns.
It does not run tools.

Automatic keepalive runs only on verified routes.
After compaction, a model change, a thinking-level change, or a branch change, it waits for the next real turn before probing again.

Savings numbers use only the prices on the active model.
If those prices are missing, the status shows `n/a`.

## Install

```bash
pi install npm:@diousk/pi-warm-cache
```

Restart or reload Pi after install.

## Commands

Type `/warm ` (with a trailing space) to see the available commands and settings
with descriptions. Keep typing to filter the menu; duration and limit suggestions
can be edited before submitting.

```text
/warm                  # show status and savings
/warm config           # show effective runtime configuration and JSON file path
/warm status           # show warm statistics and status
/warm savings          # show only the savings summary
/warm on               # enable warming
/warm off              # disable warming
/warm now              # send one probe when the current route allows it
/warm resume           # clear a sticky automatic-warm block
/warm codex-on         # enable Codex timer warming
/warm codex-off        # disable Codex timer warming
/warm 5m               # Anthropic short cadence
/warm 1h               # Anthropic long cadence when the request already uses it
/warm auto             # follow the provider strategy
/warm log              # write a local diagnostic log
/warm nolog            # stop the diagnostic log
/warm interval=3.5m max=2 maxidle=2h spend=2.5
/warm tools=gradle toolmin=3m toolmax=6
```

You can also set this when Pi starts:

```bash
pi --warm-cache
pi --warm-cache=off
pi --warm-cache="1h interval=45m"
```

## What stays warm

Automatic keepalive is on for these registered routes:

| Route | What you get |
|---|---|
| Anthropic | Probe about every 4 minutes, or about every 48 minutes when the request already uses a 1-hour cache |
| OpenAI | Probe on the explicit or implicit cache window for that model |
| Azure OpenAI | Same OpenAI response strategy |
| OpenAI Codex | Codex timer policy; turn it off with `/warm codex-off` if output spikes |
| GitHub Copilot | Automatic warming for keyed Responses, Completions, and Anthropic models whose captured request contains cache markers |
| xAI Grok 4.5 | Best-effort probe about every 4 minutes when the request has a stable cache key |
| OpenCode Go (default setup) | Keepalive on short Anthropic and keyed Responses routes; no timer on Completions because that cache already lasts a long time |

`/warm now` is a one-shot probe.
It does not start a timer.

These routes allow `/warm now` only:

- Other first-party xAI models, when the captured request is safe to replay
- OpenRouter, on the registered OpenRouter endpoint
- Some non-default OpenCode Go retention settings

Unlisted proxies and other compatible APIs stay off.
The extension will not call the provider for those routes.

GitHub Copilot is registered as its own mixed-API provider. Responses models
must have a stable `prompt_cache_key`; Anthropic models must have on-wire
`cache_control` markers. Copilot models that fail either payload gate remain
off, as do Copilot-compatible custom endpoints. Available Copilot models still
depend on the user's Copilot plan and model policy. `/warm codex-on` applies
only to the separate OpenAI Codex provider; it does not control Copilot timers.

The built-in interval is **4 minutes** for eligible automatic warming routes.
Saved custom intervals are preserved. Set `intervalMs` to `null` in the JSON
configuration to use provider-specific automatic intervals instead. The TTL-based
intervals described below apply in that automatic mode; retention and safety
gates still take precedence over an interval setting.

Copilot Responses/Completions use a **best-effort 4-minute probe interval** by
default (an explicit `intervalMs` overrides it). This is not a guaranteed TTL,
including for non-OpenAI models served through OpenAI-compatible transports.
If the captured request asks for `prompt_cache_retention: "24h"`, automatic
probes are suppressed even with an interval override; this does not prove the
gateway honored retention. Anthropic uses its captured cache markers (about
4 minutes for short retention, 48 minutes for a 1-hour marker).

Copilot support has unit-test coverage, **not live cache-refresh validation**.
The internal `verified` route classification means registered replay eligibility,
not a live-tested TTL or a guarantee of savings. Pi 0.85.1's normalized usage
does not expose the Copilot SDK's `cacheExpiresAt`, so this extension does not
schedule from that SDK field. Existing miss and spend safeguards still apply.
See [Copilot SDK usage events](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/streaming-events)
and [Microsoft's Copilot caching article](https://code.visualstudio.com/blogs/2026/06/17/improving-token-efficiency-in-github-copilot).

xAI Grok 4.5 keepalive is best effort.
The 4-minute cadence is not a provider TTL promise.
If probes keep returning no cache read, warming stops until the next real turn.

OpenCode Go must use the registered endpoints: Anthropic at `https://opencode.ai/zen/go`, and OpenAI-style APIs at `https://opencode.ai/zen/go/v1`.

## When this helps

Use it when a supported route holds a large prompt and you often leave Pi idle long enough for the cache to expire.

It does not help when:

- The prompt is below the minimum cached-token threshold (default 512)
- The route is unsupported or manual-only (no timer)
- The model has no usable prices (savings show `n/a`)
- You just compacted, changed model, or changed thinking level (wait for the next real turn)

## Configuration

### Independent `@juicesharp/rpiv-advisor` warming (experimental)

`/warm advisor=on` opts in to warming the independent `advisor` tool provided by
`@juicesharp/rpiv-advisor`; `/warm advisor=off` disables it. This setting applies
only to that rpiv-advisor integration, not arbitrary subagents or advisor-like
tools. It persists as `warmAdvisor` in the usual configuration file and defaults
to `false`. `/warm status` includes a separate rpiv-advisor status. `/warm now`
still probes only the main agent, not rpiv-advisor.

This bridge targets Pi 0.85.1's private `modelRegistry.runtime.completeSimple`
path and the stock rpiv-advisor system prompt fingerprint. It does not modify
rpiv-advisor files. Unknown/custom prompts, ambiguous parallel tool executions,
legacy global completion paths, and unavailable runtimes are not captured.
Custom authentication/environment/fetch overrides are also skipped, rather than
silently replayed with different credentials or routing.
The normal rpiv-advisor response is preserved. The runtime wrapper is removed on
shutdown and is not installed twice on the same runtime.

For recognized requests, a missing session ID is supplied before dispatch, so
rpiv-advisor's real requests and probes share a stable cache identity distinct
from the executor. Existing IDs and explicit `cacheRetention: none` are respected.
This changes cache routing for opted-in requests, not their conversation content.
Each completed successful rpiv-advisor request supplies an independent payload
and timer. Codex rpiv-advisor warming caps the effective interval at three minutes because live
tests found the four-minute boundary could already miss; a shorter configured
interval is preserved. Other advisor routes use the configured interval.
Provider eligibility, idle cutoff, output,
failure, spend, and process-wide concurrency safeguards still apply. rpiv-advisor
probes do not enter session history and do not invoke advisor tools.
Probes preserve the chosen transport and timeout/retry settings, but use their
own cancellation signal and do not invoke callbacks belonging to the real call.
For Codex rpiv-advisor requests, probes replay the captured endpoint exactly
instead of appending the main-agent `OK` suffix. The stock rpiv-advisor prompt
already constrains its answer, and exact replay refreshes the endpoint future
rpiv-advisor calls extend.

The rpiv-advisor idle cutoff is measured from its own captured request, not
executor activity. Its timer is independent of the main agent's tool-batch probe
count. New rpiv-advisor executions, session changes, compaction, and shutdown
invalidate old captures. Changes to the persisted rpiv-advisor selection or an
inactive `advisor` tool are checked before a scheduled probe; they stop further
probes. Status is exposed through `/warm status`, without replacing the main
agent's widget.

Coverage includes simulated provider replay, stable identity, request isolation,
callbacks, cancellation fencing, selection changes, idle cutoffs, and cleanup.
An end-to-end Luna/Codex test with unmodified rpiv-advisor 2.10.1 verified that
an exact-replay probe at the three-minute cadence rebuilt the cache and the next
real advisor call read 4,864 cached tokens. The probe itself reported zero cache
reads in that run; that means it created a new cache entry, not that warming
failed. Provider reuse and net savings remain best-effort rather than guaranteed,
and the feature consumes additional model usage. Do not add API-only
`prompt_cache_options` or `prompt_cache_breakpoint` fields to this Codex route:
the tested endpoint rejects them.

Create `~/.pi/agent/warm-cache.json` to persist your preferred defaults:

```json
{
  "enabled": false,
  "warmAdvisor": false,
  "warmDuringTools": ["gradle"],
  "warmAllTools": false,
  "toolWarmMinRuntimeMs": 180000,
  "toolWarmMaxProbes": 6,
  "intervalMs": 240000,
  "maxIdleWarmMs": 1800000
}
```

Then use `/warm on` to enable warming with these settings and `/warm off`
to disable it. Settings commands preserve your tool policy and automatically
save the complete effective configuration to this file, including current CLI
and environment overrides. New sessions and subagents that load this extension
use the saved defaults; already-running sessions keep their current settings.

The file is read on `session_start` (including extension reload). Restart or
reload Pi after editing it. Precedence: built-in defaults, JSON, environment
debug flag, explicit `--warm-cache` tokens, then runtime `/warm` commands.
An absent file retains built-in behavior; an invalid/unreadable file disables
automatic warming and reports an error. Correct it and reload Pi.
Settings commands create the file if needed and replace it atomically. A save
failure reports a warning and keeps the change active for the current session.
Status/config/savings queries, `/warm now`, and `/warm resume` do not write the file.

JSON keys use the `WarmCacheConfig` field names in `src/types.ts`, not the
command aliases below. Durations are numbers in milliseconds; unknown fields,
invalid types and unsupported tool presets are rejected.

Useful tokens for `/warm` and `--warm-cache`:

| Token | Meaning | Default |
|---|---|---|
| `on` / `off` | Master switch | on |
| `5m` / `1h` / `auto` | Anthropic cadence | auto |
| `interval=` | Override probe delay | 4 minutes |
| `max=` | Max concurrent warm sessions | 3 |
| `maxidle=` | Stop after this idle time; `0` means no cutoff | about 30 minutes, or longer for 1-hour families |
| `spend=` | Probe-spend ceiling in USD; `0` means unlimited | $1.00 on OpenCode Go only |
| `log` / `nolog` | Local JSONL log | off |
| `tools=` | Tool policy: `all`, `gradle`, or `off` | all |
| `tools=all` | Allow all tool names and commands (`warmAllTools: true` in JSON) | on |
| `toolmin=` | Minimum matching-tool runtime before warming | 3 minutes |
| `toolmax=` | Maximum probes per uninterrupted tool batch | 6 |
| `advisor=on` / `advisor=off` | Warm the independent `@juicesharp/rpiv-advisor` tool (experimental) | off |

Warming during **all tools** is enabled by default (`"warmAllTools": true`).
An existing saved `"warmAllTools": false` remains respected; use `/warm tools=all`
to enable and save the new policy in an existing installation.
This overrides the `warmDuringTools` allowlist, including for parallel tools.
Use `/warm on` and `/warm off` as usual; the policy is preserved.
Use `/warm tools=all`; `/warm tools=gradle`
returns to Gradle-only and `/warm tools=off` disables tool warming but leaves
idle warming enabled if the master switch is on. All-tools mode does not
itself enable the master switch.

The minimum runtime, probe count, idle cutoff, spend/route gates and payload
revision fencing still apply. Tools must actually be executing; model
generation alone is not eligible. This mode also includes browser, custom
tools and subagents, which may themselves make network/model requests that
the parent extension cannot observe. Use `/warm tools=gradle` to narrow the policy
or `/warm tools=off` to disable tool warming. The extension never executes tool
calls returned by a warm probe.

The Gradle shell preset accepts a single `gradle`, `gradlew`, or `./gradlew`
command with plain arguments, optionally prefixed by `cd android &&` (or
another literal directory). Quoted arguments, substitutions, pipelines,
background jobs and trailing commands are deliberately rejected. For example,
`./gradlew build` is eligible but `./gradlew --version; sleep 3600` is not.
Changing `/warm` settings during a tool run preserves its lifecycle tracking.
When real work resumes, an outstanding probe is cancelled and any late result
is ignored; cancellation is not counted as a provider failure. Cancellation
cannot guarantee that the provider stops processing or billing the request.

The 1-hour Anthropic mode follows the cache retention already on the Pi request.
This extension does not add 1-hour markers to your real turns.

`/warm now` ignores the idle cutoff and the spend ceiling.

## Status and savings

`/warm config` shows the current effective settings, including startup JSON,
CLI and runtime overrides, not a fresh read of the config file. It also shows
the config file path. `null` values mean provider/default policy rather than
a resolved interval; use `/warm status` to inspect the resolved strategy.

`/warm status` and bare `/warm` are read-only equivalents:
they report lifecycle, route, tool policy, next probe, hits/misses, probe cost,
estimated savings, failure/deferral state and the last attempt. These commands
do not toggle warming, reset counters, change timers or send a probe.

`/warm` shows whether warming is active, the current route, the next probe time, and a savings summary.

The live widget shows `Cache warming active` and an integer minutes/seconds
countdown such as `Next refresh in 2m 45s`, updated every 15 seconds.
While the agent is working without an eligible tool-warming schedule, both the
widget and status line show `Cache warming standby · Agent working`. Warming
remains enabled and resumes automatically when eligible; cancelled countdowns
are removed from both surfaces.
During tools, standby explains why no refresh is scheduled: tool warming is off,
a tool (including a parallel sibling) is not eligible, the tool refresh limit
was reached, or the cache anchor changed. Changing `/warm tools=…` immediately
re-evaluates running tools without resetting their start time or refresh count.
After the first warming response, it shows `Cache hits: M · Misses: N` for
warming requests only; request errors are reported separately. Estimated
savings are omitted from the live widget and remain available in `/warm savings`.

`probeHits` and `probeMisses` count extension probes only, not your real turns.

OpenCode Go savings are subscription budget-dollars, not a card invoice.

Enable a local log with `/warm log` or `PI_WARM_CACHE_DEBUG=1`.
The file is `.pi/warm-cache.jsonl` in the working directory.
It stores route names, counts, and redacted fingerprints.
It does not store prompts or API keys.

## Common cases

- After compaction or a model change, wait for the next real turn.
- If the agent is busy at a tick, that probe is deferred.
- With `tools=gradle`, an exact captured request may be replayed while a matching `gradle`/`gradlew` shell command runs. Unallowlisted parallel sibling tools, a new provider request, compaction, branch/model changes, or the probe limit stop in-tool warming.
- Session resume waits for the first real turn.
- In print or RPC mode, warming can still run; the widget is hidden when there is no UI.
- Codex can pause automatic warming if probe output is repeatedly huge; use `/warm resume` or `/warm codex-off`.

## License

MIT

This repository is derived from [ribbons-digital/pi-warm-cache](https://github.com/ribbons-digital/pi-warm-cache). Original copyright and license notices are retained.
