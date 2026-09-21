# Contributing

Thank you for helping improve pi-warm-cache.

## Development setup

Use Node.js 22 or newer and pnpm 10.

```bash
git clone https://github.com/diousk/pi-warm-cache.git
cd pi-warm-cache
pnpm install
```

Run the local checks before opening a pull request:

```bash
pnpm test
pnpm typecheck
pnpm lint
```

`pnpm lint` uses the local anti-slop plugin in `tools/oxlint/anti-slop/`.

The compatibility matrix covers Pi 0.85.1, 0.86.0, 0.86.1, and `latest`. Keep development
dependencies and the committed lockfile on 0.85.1. In a disposable checkout,
install all three Pi packages at the same target version and run the same checks:

```bash
pnpm add -D --save-exact @earendil-works/pi-ai@0.86.1 @earendil-works/pi-coding-agent@0.86.1 @earendil-works/pi-tui@0.86.1
pnpm test
pnpm typecheck
pnpm lint
```

`pnpm test` also runs `scripts/test-host-compat.mjs`, which loads the extension
through the installed Pi loader and exercises native CacheWarmer decisions on
hosts that expose it, including 0.86.1 and later releases. Hosts at 0.86 or newer
must expose the expected native module and transcript helpers; missing APIs fail
the test instead of silently skipping it. Provider responses are simulated; these tests need no credentials and
do not establish live cache reuse or monetary savings. Internal host imports
are confined to this compatibility test, not the published extension.

## Changes

Use a feature branch for each change.

Keep provider capability decisions explicit and fail closed for unknown routes.

Preserve exact provider payload replay.

Do not add provider credentials, prompt contents, or other private data to commits, tests, logs, or issue reports.

Update the README or the E2E guide when behavior, supported routes, configuration, or commands change.

Add regression coverage for provider strategy, payload shaping, diagnostics, or lifecycle changes.

## Pull requests

Explain the user-visible behavior and the affected provider routes.

Include the test and type-check commands that you ran.

Call out any live provider validation that was not possible in the local environment.

A maintainer will review the pull request before it is merged.
