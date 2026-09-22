import { DEFAULT_CONFIG, type WarmCacheConfig } from "./types.ts";
import { readFileSync, mkdirSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function warmCacheConfigPath(): string {
  return join(homedir(), ".pi", "agent", "warm-cache.json");
}

/** Validate before atomically replacing the saved startup configuration. */
export function saveConfigJson(config: WarmCacheConfig, path = warmCacheConfigPath()): void {
  const serialized = `${JSON.stringify(config, null, 2)}\n`;
  parseConfigJson(serialized);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } finally {
    try { unlinkSync(temporary); } catch { /* Rename normally already removed the temporary file. */ }
  }
}

/** Strict, atomic validation: a bad field never silently enables a default. */
export function parseConfigJson(text: string): WarmCacheConfig {
  const parsed = JSON.parse(text);
  if (!parsed || Object.prototype.toString.call(parsed) !== "[object Object]") {
    throw new Error("configuration must be a JSON object");
  }
  const next = { ...DEFAULT_CONFIG, warmDuringTools: [...DEFAULT_CONFIG.warmDuringTools] };
  const booleans = new Set(["enabled", "showWidget", "logToFile", "allowCodexAutoWarm", "warmAllTools", "warmAdvisor"]);
  const positive = new Set(["maxConcurrentWarmSessions", "maxConsecutiveFailures", "maxOutputTokens", "toolWarmMaxProbes"]);
  const nonnegative = new Set(["minCachedTokens", "toolWarmMinRuntimeMs"]);
  for (const [key, value] of Object.entries(parsed)) {
    let valid = false;
    if (booleans.has(key)) valid = value === true || value === false;
    else if (positive.has(key)) valid = Number.isSafeInteger(value) && Number(value) >= 1;
    else if (nonnegative.has(key)) valid = Number.isSafeInteger(value) && Number(value) >= 0;
    else if (key === "intervalMs") valid = value === null || (Number.isSafeInteger(value) && Number(value) >= 1000);
    else if (key === "maxIdleWarmMs") valid = value === null || (Number.isSafeInteger(value) && Number(value) >= 0);
    else if (key === "warmSpendCeilingUsd") valid = value === null || (Number.isFinite(value) && Number(value) >= 0);
    else if (key === "anthropicTtl") valid = value === "auto" || value === "5m" || value === "1h";
    else if (key === "warmSuffix") valid = Object.prototype.toString.call(value) === "[object String]";
    else if (key === "warmDuringTools") {
      valid = Array.isArray(value) && value.every((item) =>
        Object.prototype.toString.call(item) === "[object String]" && isToolWarmName(item));
    }
    if (!valid) throw new Error(`invalid or unknown configuration field: ${key}`);
    Object.assign(next, { [key]: value });
  }
  return next;
}

interface LoadedConfig {
  config: WarmCacheConfig;
  error?: string;
}

export function loadConfigJson(path = warmCacheConfigPath()): LoadedConfig {
  try {
    return { config: parseConfigJson(readFileSync(path, "utf8")) };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { config: { ...DEFAULT_CONFIG, warmDuringTools: [] } };
    }
    return {
      config: { ...DEFAULT_CONFIG, enabled: false, warmDuringTools: [] },
      error: `${path}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** Tool names are single config tokens; command syntax belongs to the gradle preset. */
function isToolWarmName(value: string): boolean {
  return value.length > 0 && !/\s|,/.test(value);
}

export function parseConfigArgs(args: string, base: WarmCacheConfig = DEFAULT_CONFIG): WarmCacheConfig {
  const next = { ...base };
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return next;

  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (lower === "on" || lower === "enable" || lower === "enabled") {
      next.enabled = true;
      continue;
    }
    if (lower === "off" || lower === "disable" || lower === "disabled") {
      next.enabled = false;
      continue;
    }
    if (lower === "5m" || lower === "short") {
      next.anthropicTtl = "5m";
      continue;
    }
    if (lower === "1h" || lower === "long") {
      next.anthropicTtl = "1h";
      continue;
    }
    if (lower === "auto") {
      next.anthropicTtl = "auto";
      continue;
    }
    if (lower === "widget") {
      next.showWidget = true;
      continue;
    }
    if (lower === "nowidget" || lower === "hide") {
      next.showWidget = false;
      continue;
    }
    if (lower === "log" || lower === "debug") {
      next.logToFile = true;
      continue;
    }
    if (lower === "nolog" || lower === "nodebug") {
      next.logToFile = false;
      continue;
    }
    if (lower === "codex-on" || lower === "codexon") {
      next.allowCodexAutoWarm = true;
      continue;
    }
    if (lower === "codex-off" || lower === "codexoff") {
      next.allowCodexAutoWarm = false;
      continue;
    }

    const kv = token.match(/^([a-zA-Z_]+)=(.+)$/);
    if (!kv) continue;
    const key = kv[1]!.toLowerCase();
    const value = kv[2]!;
    if (key === "advisor") {
      const enabled = value.toLowerCase();
      if (enabled !== "on" && enabled !== "off") throw new Error("advisor must be on or off");
      next.warmAdvisor = enabled === "on";
      continue;
    }

    if (key === "interval" || key === "intervalms") {
      next.intervalMs = parseDurationMs(value);
      continue;
    }
    if (key === "maxidle") {
      // parseDurationMs("0") returns 1000ms (the 1s minimum). The literal 0 is
      // a dedicated opt-out that restores warm-until-failure, so it is
      // special-cased before delegating.
      if (value.trim() === "0") next.maxIdleWarmMs = 0;
      else next.maxIdleWarmMs = parseDurationMs(value);
      continue;
    }
    if (key === "spend") {
      // Negative/NaN spend tokens are silently ignored, matching the
      // max=/mincached= pattern. spend=0 means unlimited.
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) next.warmSpendCeilingUsd = n;
      continue;
    }
    if (key === "max" || key === "maxconcurrent") {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 1) next.maxConcurrentWarmSessions = Math.floor(n);
      continue;
    }
    if (key === "mincached" || key === "mintokens") {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) next.minCachedTokens = Math.floor(n);
      continue;
    }
    if (key === "tools" || key === "tool") {
      const requested = value.toLowerCase().split(",").map((item) => item.trim()).filter(Boolean);
      if (requested.some((item) => item === "off" || item === "none")) {
        next.warmDuringTools = [];
        next.warmAllTools = false;
      } else if (requested.length === 1 && requested[0] === "all") {
        next.warmAllTools = true;
      } else {
        next.warmAllTools = false;
        next.warmDuringTools = requested.filter(isToolWarmName);
      }
      continue;
    }
    if (key === "toolmin") {
      const parsed = parseDurationMs(value);
      if (parsed !== null) next.toolWarmMinRuntimeMs = parsed;
      continue;
    }
    if (key === "toolmax") {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 1) next.toolWarmMaxProbes = Math.floor(n);
      continue;
    }
    if (key === "ttl") {
      if (value === "5m" || value === "1h" || value === "auto") {
        next.anthropicTtl = value;
      }
      continue;
    }
    if (key === "log" || key === "debug") {
      next.logToFile = value !== "0" && value !== "false" && value !== "off";
    }
  }

  return next;
}

/** Parse "4m", "240s", "240000", "4.5m". */
export function parseDurationMs(raw: string): number | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Math.max(1_000, Math.floor(Number(s)));
  const m = s.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)$/);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2];
  if (!Number.isFinite(n) || n <= 0) return null;
  if (unit === "ms") return Math.floor(n);
  if (unit === "s") return Math.floor(n * 1_000);
  if (unit === "m") return Math.floor(n * 60_000);
  return Math.floor(n * 3_600_000);
}

export function formatDurationShort(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  const minutes = ms / 60_000;
  if (minutes < 10 && !Number.isInteger(minutes)) return `${minutes.toFixed(1)}m`;
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = minutes / 60;
  if (!Number.isInteger(hours) && hours < 10) return `${hours.toFixed(1)}h`;
  return `${Math.round(hours)}h`;
}

export function formatTokens(n: number): string {
  if (n < 1000) return `${Math.round(n)}`;
  if (n < 10_000) return `${(n / 1000).toFixed(1)}K`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}
