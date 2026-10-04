// Optional read-only telemetry from the exact bundled provider used by Pi's CLI.
// Usage: node --import ./scripts/cache-diagnostics-preload.mjs /path/to/pi ...
import { readdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

try {
  const chunks = join(dirname(realpathSync(process.argv[1])), "chunks");
  const matches = readdirSync(chunks).filter(name => /^openai-codex-responses-.*\.js$/.test(name));
  if (matches.length === 1) {
    const provider = await import(pathToFileURL(join(chunks, matches[0])).href);
    globalThis[Symbol.for("pi-warm-cache.diagnostic-stats")] = provider.getOpenAICodexWebSocketDebugStats;
  }
} catch {
  // Other Pi distributions do not expose this debug API. Usage observation still works.
}
