import { DEFAULT_CONFIG, type WarmMode, type WarmCacheConfig } from "./types.ts";
import { readFileSync, mkdirSync, writeFileSync, renameSync, unlinkSync, openSync, closeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function warmCacheConfigPath(): string {
  return join(homedir(), ".pi", "agent", "warm-cache.json");
}

/** Public v2 format: one phase policy and one tool selector. */
export function configDocument(config: WarmCacheConfig) {
  const { enabled: _enabled, mode: _mode, warmAllTools, warmDuringTools,
    intervalMs, maxIdleWarmMs, warmSpendCeilingUsd, ...rest } = config;
  return { schemaVersion: 2, mode: effectiveMode(config),
    tools: warmAllTools ? "all" : [...warmDuringTools],
    interval: intervalMs === null ? "auto" : `${intervalMs}ms`,
    maxIdle: maxIdleWarmMs === null ? "auto" : maxIdleWarmMs === 0 ? "unlimited" : `${maxIdleWarmMs}ms`,
    spend: warmSpendCeilingUsd === null ? "auto" : warmSpendCeilingUsd === 0 ? "unlimited" : warmSpendCeilingUsd,
    ...rest };
}

export function effectiveMode(config: WarmCacheConfig): WarmMode {
  return config.mode ?? (config.enabled ? "both" : "native");
}
export function withMode(config: WarmCacheConfig, mode: WarmMode): WarmCacheConfig {
  return { ...config, mode, enabled: mode !== "off" && mode !== "native" };
}

function writeConfig(config: WarmCacheConfig, path: string): void {
  const serialized = `${JSON.stringify(configDocument(config), null, 2)}\n`;
  parseConfigJson(serialized);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } finally {
    try { unlinkSync(temporary); } catch { /* Already renamed. */ }
  }
}

/** Synchronous, bounded lock: never steal a lock from another session. */
function locked<T>(path: string, action: () => T): T {
  mkdirSync(dirname(path), { recursive: true });
  const lock = `${path}.lock`;
  let fd: number;
  try { fd = openSync(lock, "wx", 0o600); }
  catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    throw new Error(`Configuration is busy (lock: ${lock}); retry after the other writer finishes. If it crashed, remove the stale lock.`);
  }
  try { return action(); }
  finally { closeSync(fd); unlinkSync(lock); }
}

export function saveConfigJson(config: WarmCacheConfig, path = warmCacheConfigPath()): void {
  locked(path, () => writeConfig(config, path));
}

/** Re-parse only this command against the latest saved values under the lock. */
export function saveConfigArgs(args: string, path = warmCacheConfigPath()): WarmCacheConfig {
  return locked(path, () => {
    const loaded = loadConfigJson(path);
    if (loaded.error) throw new Error(loaded.error);
    const next = parseConfigArgs(args, loaded.config);
    writeConfig(next, path);
    return next;
  });
}

/** Strict, atomic validation: a bad field never silently enables a default. */
export function parseConfigJson(text: string): WarmCacheConfig {
  let parsed = JSON.parse(text);
  if (!parsed || Object.prototype.toString.call(parsed) !== "[object Object]") {
    throw new Error("configuration must be a JSON object");
  }
  const modern = parsed.schemaVersion === 2;
  if (parsed.schemaVersion !== undefined && !modern) throw new Error("unsupported configuration schemaVersion");
  if (modern) {
    const { schemaVersion: _schemaVersion, mode = "both", tools = "all", interval = "auto", maxIdle = "auto", spend = "auto", ...rest } = parsed;
    if (["enabled", "warmAllTools", "warmDuringTools", "intervalMs", "maxIdleWarmMs", "warmSpendCeilingUsd"].some(key => key in rest)) {
      throw new Error("v2 config cannot mix legacy fields; use mode, tools, interval, maxIdle and spend");
    }
    if (!["off", "native", "idle", "tools", "both"].includes(mode)) throw new Error("invalid mode");
    if (tools !== "all" && !(Array.isArray(tools) && tools.every(item => Object.prototype.toString.call(item) === "[object String]" && isToolWarmName(item)))) throw new Error("tools must be all or an array of tool names");
    parsed = { ...rest, mode, enabled: mode !== "off" && mode !== "native",
      warmAllTools: tools === "all", warmDuringTools: tools === "all" ? [] : tools,
      intervalMs: interval === "auto" ? null : requiredDuration(String(interval)),
      maxIdleWarmMs: maxIdle === "auto" ? null : maxIdle === "unlimited" ? 0 : requiredDuration(String(maxIdle)),
      warmSpendCeilingUsd: spend === "auto" ? null : spend === "unlimited" ? 0 : spend };
  }
  const next = {
    ...DEFAULT_CONFIG,
    warmDuringTools: [...DEFAULT_CONFIG.warmDuringTools],
    warmModels: [...DEFAULT_CONFIG.warmModels],
  };
  const booleans = new Set(["enabled", "showWidget", "logToFile", "allowCodexAutoWarm", "warmAllTools", "warmAdvisor"]);
  const positive = new Set(["maxConcurrentWarmSessions", "maxConsecutiveFailures", "maxOutputTokens", "toolWarmMaxProbes"]);
  const nonnegative = new Set(["minCachedTokens", "toolWarmMinRuntimeMs"]);
  for (const [key, value] of Object.entries(parsed)) {
    let valid = false;
    let assignedValue: unknown = value;
    if (key === "mode") valid = modern && ["off", "native", "idle", "tools", "both"].includes(String(value));
    else if (booleans.has(key)) valid = value === true || value === false;
    else if (positive.has(key)) valid = Number.isSafeInteger(value) && Number(value) >= 1;
    else if (nonnegative.has(key)) valid = Number.isSafeInteger(value) && Number(value) >= 0;
    else if (key === "intervalMs") valid = value === null || (Number.isSafeInteger(value) && Number(value) >= 1000);
    else if (key === "maxIdleWarmMs") valid = value === null || (Number.isSafeInteger(value) && Number(value) >= 0);
    else if (key === "warmSpendCeilingUsd") valid = value === null || (Number.isFinite(value) && Number(value) >= 0);
    else if (key === "anthropicTtl") valid = value === "auto" || value === "5m" || value === "1h";
    else if (key === "codexWarmMode") valid = value === "auto" || value === "exact" || value === "suffix";
    else if (key === "warmSuffix") valid = Object.prototype.toString.call(value) === "[object String]";
    else if (key === "warmDuringTools") {
      valid = Array.isArray(value) && value.every((item) =>
        Object.prototype.toString.call(item) === "[object String]" && isToolWarmName(item));
    }
    else if (key === "warmModels") {
      valid = Array.isArray(value) && value.every((item) =>
        Object.prototype.toString.call(item) === "[object String]" && isWarmModelName(String(item)));
      if (valid) {
        // SAFETY: `valid` is true only after every array item passed the string and provider/model-id checks.
        const models = value as string[];
        assignedValue = models.map(normalizeWarmModelId);
      }
    }
    if (!valid) throw new Error(`invalid or unknown configuration field: ${key}`);
    Object.assign(next, { [key]: assignedValue });
  }
  if (!modern) {
    // Preserve pre-0.2.6 cadence and disabled => native delegation on upgrade.
    if (!("intervalMs" in parsed)) next.intervalMs = 240_000;
    if (!("warmAllTools" in parsed) && "warmDuringTools" in parsed) next.warmAllTools = false;
    return withMode(next, next.enabled ? "both" : "native");
  }
  return next;
}

interface LoadedConfig {
  config: WarmCacheConfig;
  error?: string;
  migration?: string;
}

export function loadConfigJson(path = warmCacheConfigPath()): LoadedConfig {
  try {
    const text = readFileSync(path, "utf8");
    const config = parseConfigJson(text);
    return { config, migration: JSON.parse(text).schemaVersion === 2 ? undefined
      : `Legacy settings loaded; saved on the next settings command. mode=${effectiveMode(config)} (old off delegates to Pi). Missing warmAllTools with an explicit allowlist now restricts tools. /warm off now stops native warming too; mode=native delegates.` };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { config: withMode({ ...DEFAULT_CONFIG, warmDuringTools: [], warmModels: [] }, "both") };
    }
    return {
      config: withMode({ ...DEFAULT_CONFIG, warmDuringTools: [], warmModels: [] }, "off"),
      error: `${path}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** Tool names are single config tokens; command syntax belongs to the gradle preset. */
function isToolWarmName(value: string): boolean {
  return value.length > 0 && !/\s|,/.test(value);
}

function isWarmModelName(value: string): boolean {
  const slash = value.indexOf("/");
  return slash > 0 && slash < value.length - 1 && !/\s|,/.test(value);
}

export function normalizeWarmModelId(model: string | { provider: string; id: string }): string {
  if (Object.prototype.toString.call(model) === "[object String]") return String(model).toLowerCase();
  // SAFETY: The public input is a string or the provider/id model reference object; the string branch returned above.
  const modelRef = model as { provider: string; id: string };
  const value = `${modelRef.provider}/${modelRef.id}`;
  return value.toLowerCase();
}

export function isWarmModelAllowed(
  warmModels: readonly string[] | undefined,
  model: { provider: string; id: string } | null | undefined,
): boolean {
  if (!warmModels || warmModels.length === 0) return true;
  if (!model) return false;
  const modelId = normalizeWarmModelId(model);
  return warmModels.some((selected) => normalizeWarmModelId(selected) === modelId);
}

export function parseConfigArgs(args: string, base: WarmCacheConfig = DEFAULT_CONFIG): WarmCacheConfig {
  const next = {
    ...base,
    warmDuringTools: [...base.warmDuringTools],
    warmModels: [...(base.warmModels ?? [])],
  };
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return next;

  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (lower === "on" || lower === "enable" || lower === "enabled") {
      next.mode = "both";
      next.enabled = true;
      continue;
    }
    if (lower === "off" || lower === "disable" || lower === "disabled") {
      next.mode = "off";
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
      next.intervalMs = null;
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
    if (lower === "resume") continue;
    if (!kv) throw new Error(`Unknown option: ${token}`);
    const key = kv[1]!.toLowerCase();
    const value = kv[2]!;
    if (key === "scope") {
      if (value !== "session" && value !== "saved") throw new Error("scope must be session or saved");
      continue;
    }
    if (key === "mode") {
      if (!["off", "native", "idle", "tools", "both"].includes(value)) throw new Error("mode must be off, native, idle, tools or both");
      // SAFETY: the preceding membership check accepts only WarmMode values.
      Object.assign(next, withMode(next, value as WarmMode));
      continue;
    }
    if (key === "advisor") {
      const enabled = value.toLowerCase();
      if (enabled !== "on" && enabled !== "off") throw new Error("advisor must be on or off");
      next.warmAdvisor = enabled === "on";
      continue;
    }
    if (key === "model" || key === "models") {
      const requested = value.toLowerCase().split(",").map((item) => item.trim()).filter(Boolean);
      if (requested.length === 1 && requested[0] === "all") {
        next.warmModels = [];
      } else {
        if (requested.includes("all")) throw new Error("model=all cannot be combined with model ids");
        if (requested.some((item) => !isWarmModelName(item))) {
          throw new Error("model must be all or a provider/model id from the selectable models");
        }
        for (const model of requested) {
          const normalized = normalizeWarmModelId(model);
          if (!next.warmModels.some((selected) => normalizeWarmModelId(selected) === normalized)) {
            next.warmModels.push(normalized);
          }
        }
      }
      continue;
    }
    if (key === "codex" || key === "codexmode" || key === "codexwarm") {
      const mode = value.toLowerCase();
      if (mode === "auto" || mode === "exact" || mode === "suffix") next.codexWarmMode = mode;
      else throw new Error("codex replay mode must be auto, exact, or suffix");
      continue;
    }

    if (key === "interval" || key === "intervalms") {
      next.intervalMs = value === "auto" ? null : requiredDuration(value);
      continue;
    }
    if (key === "maxidle") {
      // parseDurationMs("0") returns 1000ms (the 1s minimum). The literal 0 is
      // a dedicated opt-out that restores warm-until-failure, so it is
      // special-cased before delegating.
      if (value === "0" || value === "unlimited") next.maxIdleWarmMs = 0;
      else next.maxIdleWarmMs = value === "auto" ? null : requiredDuration(value);
      continue;
    }
    if (key === "spend") {
      if (value === "auto") next.warmSpendCeilingUsd = null;
      else if (value === "unlimited") next.warmSpendCeilingUsd = 0;
      else {
        const n = Number(value);
        if (!Number.isFinite(n) || n < 0) throw new Error("spend must be a nonnegative number, auto or unlimited");
        next.warmSpendCeilingUsd = n;
      }
      continue;
    }
    if (key === "max" || key === "maxconcurrent") {
      const n = Number(value);
      if (!Number.isSafeInteger(n) || n < 1) throw new Error("max must be a positive integer");
      next.maxConcurrentWarmSessions = n;
      continue;
    }
    if (key === "mincached" || key === "mintokens") {
      const n = Number(value);
      if (!Number.isSafeInteger(n) || n < 0) throw new Error("mincached must be a nonnegative integer");
      next.minCachedTokens = n;
      continue;
    }
    if (key === "tools" || key === "tool") {
      const requested = value.toLowerCase().split(",").map((item) => item.trim()).filter(Boolean);
      if (!requested.length || (requested.length > 1 && requested.some(item => ["all", "off", "none"].includes(item)))) throw new Error("tools requires all, off or tool names");
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
      next.toolWarmMinRuntimeMs = value === "0" ? 0 : requiredDuration(value);
      continue;
    }
    if (key === "toolmax") {
      const n = Number(value);
      if (!Number.isSafeInteger(n) || n < 1) throw new Error("toolmax must be a positive integer");
      next.toolWarmMaxProbes = n;
      continue;
    }
    if (key === "ttl") {
      if (value === "5m" || value === "1h" || value === "auto") {
        next.anthropicTtl = value;
      } else throw new Error("ttl must be auto, 5m or 1h");
      continue;
    }
    if (key === "log" || key === "debug") {
      if (!["0", "false", "off", "1", "true", "on"].includes(value)) throw new Error("log must be on or off");
      next.logToFile = ["1", "true", "on"].includes(value);
      continue;
    }
    throw new Error(`Unknown option: ${token}`);
  }

  // Same validation as disk input, before any caller applies the result.
  parseConfigJson(JSON.stringify(configDocument(next)));
  return next;
}

function requiredDuration(value: string): number {
  const ms = parseDurationMs(value);
  if (ms === null || !Number.isSafeInteger(ms) || ms < 1000) throw new Error("duration must be at least 1s (for example 4m)");
  return ms;
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
