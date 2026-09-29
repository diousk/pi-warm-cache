# Claude Code bridge adapter (experimental)

This is a cooperating-provider integration for **pi-claude-bridge 0.9.0**,
using Claude Code's official Agent SDK. The stock npm bridge has no warming
interface: installing/updating warm-cache alone does **not** enable this route.
Do not rename the bridge API to `anthropic-messages` or replay through the
bridge's ordinary completion function. That function owns parked tool queries.

## Set up a source checkout

Keep the installed bridge unchanged while testing. In a separate checkout of
`https://github.com/elidickinson/pi-claude-bridge`, based on 0.9.0:

1. Make this warm-cache checkout available as a local package dependency, for
   example `pnpm add @diousk/pi-warm-cache@file:/absolute/path/to/pi-warm-cache`.
   The installed 0.2.1 npm package does not contain the new adapter module.
2. Apply `claude-bridge-v0.9.0.patch` to the bridge checkout with `git apply`.
3. Use Pi >=0.86.1 and load **only** that bridge checkout and this warm-cache
   checkout. Do not load stock npm copies as well: the bridge uses one active
   provider function per process, and duplicate warmers can compete.

Example (absolute paths, with no other extensions loaded):

```sh
pi --no-extensions \
  -e /absolute/path/to/pi-claude-bridge/src/index.ts \
  -e /absolute/path/to/pi-warm-cache/src/index.ts \
  --provider claude-bridge --model claude-haiku-4-5
```

Then use `/warm on tools=all`, make one normal request, and inspect
`/warm status`. The existing warm-cache configuration persistence still applies.
Claude Code manages authentication; this adapter never reads or copies tokens.
Session/model/effort changes and compaction invalidate the old lease.

## What the adapter guarantees

- A versioned Pi event-bus handshake scoped to the **Pi session ID**. A model
  name alone never permits warming; a stock/missing adapter fails closed.
- The bridge retains its actual CLI model (including `[1m]`), system prompt,
  effort, thinking settings, tool schemas, working directory and auth options
  in a private closure. Only opaque IDs/checksums and a probe callback are sent
  to warm-cache. Request prompts and credentials are not logged or emitted.
- A probe calls the official SDK directly with `resume`, `forkSession:true`
  and `persistSession:false`. It never enters the real bridge query/context,
  sends a Pi user message, or saves keepalive text to the original CC session.
- Native tools stay disabled. Fresh MCP servers expose the same definitions
  but contain only inert/denying handlers. User hooks are disabled for probes.
  No real Pi tool callback or parked tool-result resolver is reused.
- `maxTurns:1`, zero API retries, a 60-second timeout, and closure after the
  first complete API response prevent an SDK continuation/tool loop.
- The usual global concurrency gate, matching-tool policy, tool-runtime delay,
  probe limit, idle cutoff, 15-second UI tick and two-consecutive-miss stop
  remain in force. Real SDK usage can report 1-hour and 5-minute cache-write
  tokens. Only a real 1-hour-only write selects a 50-minute default cadence;
  mixed/5-minute writes or absent TTL evidence use at most 4 minutes. A
  non-default `/warm interval=` may shorten the 1-hour cadence; `/warm 5m`
  explicitly keeps the short cadence. The bridge cannot set the SDK's TTL.

This refreshes a **shared conversation prefix**, not an exact Messages API
endpoint. Fork-local keepalive text is never part of the next normal Pi turn.
Do not interpret a warm-only hit as proof of a downstream benefit.
The tested Claude Code login wrote a 1-hour cache entry. Its un-warmed control
still hit after five minutes, so a five-minute comparison cannot establish a
benefit from the extra probe on that route; the adaptive 50-minute cadence
avoids redundant default probes in this case.

## Output and quota caveat

Claude Code can derive an implicit thinking budget from its output ceiling.
Lowering `CLAUDE_CODE_MAX_OUTPUT_TOKENS` to 1 changed cache identity in the live
Haiku test (warm read=0); preserving the original ceiling restored a hit.
Therefore the adapter keeps the original ceiling for implicit/adaptive thinking.
An explicit disabled/fixed thinking configuration can use a legal bounded
ceiling, with fixed thinking budget preserved.

**Do not expect a 1-token or zero-output probe on this route.** A one-word
keepalive may still consume thinking/output tokens and Claude usage/quota.
Bridge model prices are zero placeholders, not evidence that warming is free.
`max_tokens:0` is not exposed by this SDK transport. This is experimental;
the cache benefit depends on the actual Claude Code route/account.

For safety, custom API routes/EXTRA_BODY overrides, non-strict MCP, native tools,
custom agents/plugins/output formats/session stores, and auto-memory are refused.
Independent rpiv-advisor calls are not covered by this session-scoped adapter.

## Live downstream validation

Use a disposable Pi >=0.86.1 dependency copy, keeping this repository's 0.85.1
development baseline pinned. Then explicitly opt in:

```sh
node --experimental-strip-types --no-warnings scripts/test-claude-bridge-live.mjs \
  --bridge=/absolute/path/to/patched/pi-claude-bridge/src/index.ts \
  --pi-root=/absolute/path/to/disposable/node_modules/@earendil-works/pi-coding-agent
```

Add `--ttl-only` for a quick real-provider check of the observed-TTL strategy
without waiting for the long-tool test. It expects `anthropic-long` and a
50-minute cadence only when that account's SDK actually reports 1-hour writes.

The test deliberately forces `/warm 5m` so it can exercise a probe during one
harmless 330-second waiting tool even on a 1-hour Claude Code route. It checks
the next real tool-continuation cache usage against an un-warmed session older
than five minutes, unchanged Pi and Claude conversation histories during the
probe, and exactly one real tool execution. For 1-hour writes it reports the
downstream hit but **does not claim a causal benefit** over the control. It
prints token counts/checks only, uses an isolated Pi config,
and never saves the user's warm-cache config. Expect about six minutes and
at most five model turns. Claude Code may retain the two synthetic normal
sessions; the probe itself is not persisted.
