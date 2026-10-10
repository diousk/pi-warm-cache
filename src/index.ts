/**
 * pi-warm-cache
 *
 * Keeps Anthropic / OpenAI prompt caches warm during long idle gaps in a Pi session.
 *
 * Core idea:
 * 1. Snapshot the provider payload after the complete `before_provider_request` chain.
 *    This hook is READ-ONLY. We never rewrite real user turns.
 * 2. After the agent settles, start a provider-specific timer (4m / 50m / 24m / ...).
 * 3. On tick, replay that payload with provider-legal output controls via
 *    `modelRegistry.complete({ onPayload })`: supported direct OpenAI Responses
 *    uses no-output prewarming; Codex exact replay has no hard output cap
 *    because its endpoint rejects one.
 * 4. Never use `sendUserMessage` for warming (would pollute the session and run tools).
 */

import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfigJson, normalizeWarmModelId, parseConfigArgs, saveConfigArgs, configDocument, effectiveMode, withMode, formatDurationShort, warmCacheConfigPath } from "./config.ts";
import type { WarmCacheConfig } from "./types.ts";
import { DEFAULT_CONFIG } from "./types.ts";
import { SessionWarmer } from "./warmer.ts";
import { AdvisorWarmer } from "./advisor.ts";
import { formatProbeCost } from "./savings.ts";
import { ClaudeBridgeTransport } from "./claude-bridge.ts";
import { NativeWarmingCoordinator, onNativeWarmingDecision, onRawProviderEvent } from "./compat.ts";
import { FinalPayloadCapture } from "./payload-capture.ts";
import { clearWarmUi, renderCapabilityNotice, renderIdleUi } from "./ui.ts";

/**
 * Resolve the notification level and failure label for a failed /warm now
 * result. A by-design refusal on a verified no-keepalive route (for example
 * the retained family, which never probes) is not an error: the route is
 * healthy and the refusal is the documented behavior, so it renders at
 * warning level with the refusal explanation. Real failures on verified
 * routes stay errors, and unverified route refusals keep the warning level.
 * Returns null for a successful result.
 */
export function resolveWarmNowFailure(args: {
  ok: boolean;
  unavailable?: boolean;
  capabilityState?: string;
  automaticWarm: boolean;
  xaiBestEffort: boolean;
}): { level: "warning" | "error"; failureLabel: string } | null {
  if (args.ok) return null;
  const deliberateRefusal =
    args.unavailable === true &&
    args.capabilityState === "verified" &&
    !args.automaticWarm;
  return {
    level: deliberateRefusal || args.capabilityState === "unverified" ? "warning" : "error",
    failureLabel: deliberateRefusal
      ? "Probe unavailable"
      : args.unavailable || args.capabilityState === "unsupported"
        ? `${args.xaiBestEffort ? "xAI best-effort probe" : "Probe"} unavailable`
        : `${args.xaiBestEffort ? "xAI best-effort probe" : "Probe"} failed`,
  };
}

export function formatWarmSettings(config: WarmCacheConfig, api?: string): string {
  const seconds = config.intervalMs === null ? null : Math.ceil(config.intervalMs / 1000);
  const interval = seconds === null ? "auto (provider default)"
    : seconds < 60 ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m${seconds % 60 ? ` ${seconds % 60}s` : ""}`;
  return [
    `mode=${effectiveMode(config)}`,
    `interval=${interval}`,
    ...(api === "anthropic-messages" ? [`Anthropic TTL=${config.anthropicTtl}`] : []),
    ...(api === "openai-codex-responses" ? [`codex replay=${config.codexWarmMode ?? "auto"}`] : []),
    `concurrency=${config.maxConcurrentWarmSessions} (warming requests per Pi process)`,
    `debug log=${config.logToFile ? "on" : "off"}`,
  ].join(" · ");
}

function describeWarmModel(model: Model<any>): string {
  const prices = [
    Number.isFinite(model.cost?.input) && model.cost.input > 0
      ? `input $${model.cost.input.toLocaleString("en-US", { maximumFractionDigits: 4 })}/MTok`
      : null,
    Number.isFinite(model.cost?.cacheRead) && model.cost.cacheRead > 0
      ? `cache read $${model.cost.cacheRead.toLocaleString("en-US", { maximumFractionDigits: 4 })}/MTok`
      : null,
  ].filter((value): value is string => value !== null);
  const modelName = model.name && model.name !== model.id ? `${model.name} · ` : "";
  return `${modelName}${prices.length > 0 ? prices.join(" · ") : "price not listed"}`;
}

function selectableWarmModels(ctx: ExtensionContext): Model<any>[] {
  try {
    const scoped = ctx.scopedModels?.map(({ model }) => model) ?? [];
    const models = scoped.length > 0 ? scoped : ctx.modelRegistry.getAvailable();
    return [...models].sort((left, right) =>
      `${left.provider}/${left.id}`.localeCompare(`${right.provider}/${right.id}`),
    );
  } catch {
    return [];
  }
}

export default function piWarmCache(pi: ExtensionAPI, saveConfig?: (config: WarmCacheConfig) => void) {
  const bridge = new ClaudeBridgeTransport(pi);
  const warmer = new SessionWarmer(pi, undefined, { transport: bridge });
  bridge.bind(warmer);
  const advisorWarmer = new AdvisorWarmer(pi);
  const nativeWarming = new NativeWarmingCoordinator();
  const captureUnavailable = (ctx: ExtensionContext) =>
    warmer.invalidateAnchor(ctx, "final provider payload unavailable · warming disabled for this request");
  const payloadCapture = new FinalPayloadCapture(
    (payload, ctx, transformHeaders) => warmer.onProviderRequestStart(payload, ctx, undefined, transformHeaders), captureUnavailable);
  onNativeWarmingDecision(pi, (_event, ctx) => nativeWarming.decide(warmer.ownsAutomaticWarming(ctx)));
  pi.on("turn_start", () => nativeWarming.onRealTurn());
  onRawProviderEvent(pi, event => {
    if (!nativeWarming.isNativeRequest()) warmer.onProviderStreamEvent(event.data, event.provider, event.model);
  });
  pi.on("after_provider_response", event => {
    if (!nativeWarming.isNativeRequest()) warmer.onProviderResponseHeaders(event.headers, event.status);
  });
  let config = { ...DEFAULT_CONFIG };
  let availableWarmModels: Model<any>[] = [];
  const refreshAvailableWarmModels = (ctx: ExtensionContext) => {
    availableWarmModels = selectableWarmModels(ctx);
  };
  let lastCapabilityNoticeKey: string | null = null;
  let configSource = "defaults";

  // Optional CLI: pi --warm-cache / pi --warm-cache=off
  pi.registerFlag("warm-cache", {
    description: "Enable or configure pi-warm-cache (true/false or config tokens)",
    type: "string",
    default: "",
  });

  pi.on("session_start", async (event, ctx) => {
    warmer.resetDiagnostics();
    refreshAvailableWarmModels(ctx);
    nativeWarming.onRealTurn();
    advisorWarmer.dispose();
    bridge.dispose();

    const loaded = loadConfigJson();
    config = loaded.config;
    configSource = "saved settings + defaults";
    if (loaded.migration) {
      if (ctx.hasUI) ctx.ui.notify(loaded.migration, "info");
      else process.stderr.write(`${loaded.migration}\n`);
    }
    if (loaded.error) {
      if (ctx.hasUI) ctx.ui.notify(`pi-warm-cache disabled: ${loaded.error}`, "warning");
      else process.stderr.write(`pi-warm-cache disabled: ${loaded.error}\n`);
    }

    // Opt-in file diagnostics. Never default-write into the project cwd.
    const envDebug = process.env.PI_WARM_CACHE_DEBUG;
    if (envDebug === "1" || envDebug === "true" || envDebug === "on") {
      config = { ...config, logToFile: true };
      configSource += " + environment override";
    }

    const flag = pi.getFlag("warm-cache");
    if (!loaded.error && Object.prototype.toString.call(flag) === "[object String]") {
      const value = String(flag);
      if (value) configSource += " + CLI override";
      try {
      if (value === "false" || value === "0" || value === "off") {
        config = withMode(config, "off");
      } else if (value === "true" || value === "1" || value === "on") {
        config = withMode(config, "both");
      } else {
        config = parseConfigArgs(value, config);
      }
      } catch (error) {
        config = withMode(config, "off");
        const message = `Invalid --warm-cache: ${error instanceof Error ? error.message : String(error)}. Warming stopped.`;
        if (ctx.hasUI) ctx.ui.notify(message, "warning");
        else process.stderr.write(`${message}\n`);
      }
    }

    bridge.configure(ctx, config);
    warmer.bindContext(ctx);
    warmer.setConfig(config);
    payloadCapture.install(ctx);
    advisorWarmer.configure(config, ctx);

    // Payload anchors are never restored across resume (turn-specific).
    // Stats persistence can be added later via appendEntry.

    if (config.enabled && ctx.hasUI) {
      const capability = warmer.getCapability();
      if (capability.state === "verified") {
        lastCapabilityNoticeKey = null;
        if (event.reason === "startup") {
          renderIdleUi(ctx, config, capability.automaticWarm
            ? "waiting for first cached turn"
            : "keepalive not needed");
        }
      } else {
        const noticeKey = `${capability.state}:${capability.reason}:${capability.manualProbe}`;
        if (noticeKey !== lastCapabilityNoticeKey) {
          renderCapabilityNotice(ctx, capability, config);
          lastCapabilityNoticeKey = noticeKey;
        }
      }
    }
  });

  pi.on("session_shutdown", async () => {
    payloadCapture.dispose();
    nativeWarming.onRealTurn();
    advisorWarmer.dispose();
    bridge.dispose();
    lastCapabilityNoticeKey = null;
    warmer.dispose();
  });

  pi.on("model_select", async (_event, ctx) => {
    refreshAvailableWarmModels(ctx);
    bridge.invalidate();
    bridge.configure(ctx, config);
    warmer.bindContext(ctx);
    warmer.onModelChange(ctx);
  });

  pi.on("thinking_level_select", async (_event, ctx) => {
    // Effort is part of many cache keys. Force re-anchor.
    bridge.invalidate();
    warmer.bindContext(ctx);
    warmer.onModelChange(ctx);
  });

  // Compaction changes the prompt prefix. Old payload must not be replayed.
  pi.on("session_compact", async (_event, ctx) => {
    bridge.invalidate();
    advisorWarmer.invalidate("compacted; waiting for advisor");
    warmer.invalidateAnchor(ctx, "compacted · waiting for next turn");
  });

  // Branch / tree navigation changes the active prefix.
  pi.on("session_tree", async (_event, ctx) => {
    bridge.invalidate();
    advisorWarmer.invalidate("branch changed; waiting for advisor");
    warmer.invalidateAnchor(ctx, "branch changed · waiting for next turn");
  });

  pi.on("agent_start", async (_event, ctx) => {
    nativeWarming.onRealTurn();
    warmer.bindContext(ctx);
    warmer.onAgentStart(ctx);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    warmer.bindContext(ctx);
    warmer.onAgentSettled(ctx);
  });

  pi.on("tool_execution_start", async (event, ctx) => {
    advisorWarmer.toolStart(event.toolCallId, event.toolName);
    warmer.onToolExecutionStart(event, ctx);
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    advisorWarmer.toolEnd(event.toolCallId);
    warmer.onToolExecutionEnd(event, ctx);
  });

  /**
   * CRITICAL PATH: capture the real serialized provider payload.
   * READ-ONLY - do not return a modified payload.
   * Rewriting real turns (e.g. forcing ttl:1h) can 400 unsupported routes
   * and silently doubles cache-write cost outside Pi's retention gates.
   */
  pi.on("before_provider_request", (_event, ctx) => {
    if (nativeWarming.isNativeRequest()) return;
    warmer.onProviderRequestPending(ctx);
    // Later extensions can replace the object. Capture after the full chain.
    if (!payloadCapture.observe(ctx)) {
      captureUnavailable(ctx);
    }
  });

  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return;
    warmer.onAssistantMessageEnd(ctx);
    const usage = event.message.usage;
    if (!usage) return;
    warmer.noteAssistantUsage(ctx, usage);
  });

  pi.registerCommand("warm", {
    getArgumentCompletions: (prefix) => {
      const options = [
        ["status", "Show warming status and statistics"],
        ["config", "Show current settings"],
        ["mode=both", "Warm while idle and during eligible tools"],
        ["mode=idle", "Warm only while idle"],
        ["mode=tools", "Warm only during eligible tools"],
        ["mode=off", "Stop extension and native session warming"],
        ["mode=native", "Delegate to Pi (no native warmer on 0.85.1)"],
        ["scope=session", "Apply this command only to the current session"],
        ["on", "Enable idle and tool warming"],
        ["off", "Stop extension and native session warming"],
        ["now", "Refresh cache once"],
        ["resume", "Clear the automatic warming block"],
        ["tools=gradle", "Warm during long Gradle builds"],
        ["tools=ask_user_question", "Warm during the named ask_user_question tool"],
        ["tools=all", "Warm during any long tool execution"],
        ["tools=off", "Warm only between agent turns"],
        ["model=all", "Warm every selectable model (default)"],
        ["toolmin=3m", "Wait 3 minutes before warming during tools"],
        ["toolmax=6", "Allow up to 6 refreshes per tool batch"],
        ["interval=auto", "Use the provider refresh interval (default)"],
        ["interval=4m", "Set refresh interval (editable duration)"],
        ["maxidle=30m", "Stop after 30 minutes without a real turn"],
        ["spend=unlimited", "Remove the warming spend ceiling"],
        ["maxidle=unlimited", "Remove the idle time limit"],
        ["spend=1", "Set warming spend ceiling to $1"],
        ["max=3", "Allow 3 concurrent warming sessions"],
        ["advisor=on", "Enable independent rpiv-advisor warming (experimental)"],
        ["advisor=off", "Disable independent advisor warming"],
        ["auto", "Reset to the provider refresh interval"],
        ["codex-on", "Enable Codex automatic warming"],
        ["codex-off", "Disable Codex automatic warming"],
        ["codex=auto", "Detect and avoid Codex suffix branch misses"],
        ["codex=exact", "Replay Codex requests exactly (uncapped output risk)"],
        ["codex=suffix", "Use the bounded Codex OK-suffix replay"],
        ["log", "Enable local diagnostic logging"],
        ["nolog", "Disable local diagnostic logging"],
        ["widget", "Show the warming widget"],
        ["nowidget", "Hide the warming widget"],
        ["savings", "Show estimated savings details"],
      ];
      const standalone = new Set(["status", "config", "now", "savings"]);
      const split = prefix.lastIndexOf(" ");
      const preceding = prefix.slice(0, split + 1);
      const query = prefix.slice(split + 1).toLowerCase();
      if (preceding.trim().split(/\s+/).some((token) => standalone.has(token.toLowerCase()))) return null;
      const items = options
        .filter(([value]) => value!.startsWith(query) && (!preceding || !standalone.has(value!)))
        .map(([value, description]) => ({ value: preceding + value, label: value!, description }));
      if (query.startsWith("model=")) {
        const modelQuery = query.slice("model=".length);
        const enteredModels = prefix.trim().split(/\s+/).slice(0, -1);
        let selectingAll = config.warmModels.length === 0;
        const selectedModels = new Set(config.warmModels.map(normalizeWarmModelId));
        for (const token of enteredModels) {
          const match = /^models?=(.+)$/i.exec(token);
          if (!match) continue;
          const requested = match[1]!.toLowerCase().split(",").map((item) => item.trim()).filter(Boolean);
          if (requested.length === 1 && requested[0] === "all") {
            selectingAll = true;
            selectedModels.clear();
            continue;
          }
          if (selectingAll) {
            selectingAll = false;
            selectedModels.clear();
          }
          for (const model of requested) selectedModels.add(normalizeWarmModelId(model));
        }
        const excluded = selectingAll ? new Set<string>() : selectedModels;
        for (const model of availableWarmModels) {
          const id = normalizeWarmModelId(model);
          if (excluded.has(id)) continue;
          if (modelQuery && !id.includes(modelQuery) && !model.name.toLowerCase().includes(modelQuery)) continue;
          items.push({
            value: `${preceding}model=${model.provider}/${model.id}`,
            label: `${model.provider}/${model.id}`,
            description: `Add model · ${describeWarmModel(model)}`,
          });
        }
      }
      return items.length > 0 ? items : null;
    },
    description:
      "Control prompt-cache warming. Usage: /warm [mode=both|mode=idle|mode=tools|mode=off|mode=native|scope=session|interval=auto|on|off|config|status|savings|now|resume|codex-on|codex-off|codex=auto|codex=exact|codex=suffix|5m|1h|auto|log|nolog|interval=4m|max=3|tools=gradle|tools=<tool-name>|tools=all|tools=off|model=all|model=<provider>/<model-id>|toolmin=3m|toolmax=6|advisor=on|advisor=off]",
    handler: async (args, ctx) => {
      refreshAvailableWarmModels(ctx);
      const trimmed = args.trim();
      if (trimmed.toLowerCase() === "config") {
        const current = warmer.getConfig();
        const idle = current.maxIdleWarmMs === null ? "auto (provider policy)" : current.maxIdleWarmMs === 0 ? "unlimited" : formatDurationShort(current.maxIdleWarmMs);
        const spend = current.warmSpendCeilingUsd === null ? "auto ($1 on OpenCode Go; unlimited elsewhere)" : current.warmSpendCeilingUsd === 0 ? "unlimited" : `$${current.warmSpendCeilingUsd}`;
        ctx.ui.notify(
          `Effective runtime configuration (not just file contents)\nConfig file: ${warmCacheConfigPath()}\n` +
          `Source: ${configSource}\n${formatWarmSettings(current, ctx.model?.api)}\n` +
          `${nativeWarming.status(warmer.ownsAutomaticWarming(ctx))}\n` +
          `Tools: ${current.warmAllTools ? "all" : current.warmDuringTools.join(", ") || "none"}; minimum runtime: ${formatDurationShort(current.toolWarmMinRuntimeMs)}\n` +
          `Idle limit: ${idle}\nSpend ceiling: ${spend} per provider per warming campaign (per process, not an account budget)\n` +
          `Display: ${current.showWidget ? "widget above input" : "hidden"}\n` +
          `${JSON.stringify(configDocument(current), null, 2)}\n` +
          `Resolved strategy and pause reason:\n${warmer.getStatusText()}`,
          "info",
        );
        return;
      }
      if (trimmed.toLowerCase() === "savings") {
        const summary = warmer.getSavingsSummaryText();
        ctx.ui.notify(warmer.isXaiRoute() ? `xAI best-effort ${summary}` : summary, "info");
        return;
      }
      if (trimmed.toLowerCase() === "stat") {
        ctx.ui.notify("Unknown command: stat. Use /warm status.", "warning");
        return;
      }
      if (!trimmed || trimmed.toLowerCase() === "status") {
        ctx.ui.notify(`${warmer.getStatusText()}\n${nativeWarming.status(warmer.ownsAutomaticWarming(ctx))}\n${advisorWarmer.status()}`, "info");
        return;
      }
      if (trimmed.toLowerCase() === "now") {
        if (!ctx.isIdle()) {
          ctx.ui.notify("Agent is busy. Try /warm now when idle.", "warning");
          return;
        }
        // Manual ping is allowed even when auto-warm is sticky-blocked.
        const result = await warmer.warmNow(ctx);
        const xaiBestEffort =
          result.provider === "xai" ||
          result.family === "xai-best-effort" ||
          /xai/i.test(result.capabilityReason ?? "");
        const route = `${result.provider ?? "unknown"}/${result.modelId ?? "unknown"} api=${result.api ?? "unknown"}`;
        const capability =
          `capability=${result.capabilityState ?? "unknown"} reason=${result.capabilityReason ?? "unknown"}`;
        const usage =
          `extensionProbe read=${result.cacheRead} write=${result.cacheWrite} in=${result.input} ` +
          `out=${result.output} cost=${formatProbeCost(result.api, result.costUsd)}`;
        const fingerprint = `pfp=${result.fingerprint ? result.fingerprint.slice(0, 8) : "none"}`;
        const strategy =
          `strategy=${result.family ?? "unknown"} cadence=${result.strategyLabel ?? "unknown"} ` +
          `intervalMs=${result.intervalMs ?? "none"}`;
        const cacheKey = `cacheKey=${result.cacheKeyFingerprint ?? "none"}`;
        const retry = `retry=${result.retryState ?? "none"}`;
        const activeWarmSessions = result.deferred
          ? `${result.deferred.activeWarmSessions}/${result.deferred.maxConcurrentWarmSessions}`
          : `${warmer.getActiveWarmSessions()}/${warmer.getConfig().maxConcurrentWarmSessions}`;
        const activeWarm = `activeWarmSessions=${activeWarmSessions}`;
        const manualOnly =
          result.capabilityState === "unverified" && warmer.getCapability().manualProbe;
        const manualOnlyWarning =
          result.capabilityState === "unverified"
            ? manualOnly
              ? `WARNING: ${xaiBestEffort ? "xAI best-effort " : ""}manual-only route; automatic warming is disabled, /warm now is the only probe path, and savings are n/a (unverified route). `
              : "WARNING: automatic warming is disabled for this unverified route; no safe manual probe is available. "
            : "";
        const savings =
          result.capabilityState === "unverified"
            ? "savingsSummary=n/a (unverified route)"
            : `savingsSummary=${warmer.getSavingsSummaryText()}`;
        const deferral = result.deferred
          ? `deferred=${result.deferred.reason} (${result.deferred.activeWarmSessions}/${result.deferred.maxConcurrentWarmSessions} slots used); `
          : "";
        const diagnostics =
          `${route}; ${capability}; ${strategy}; ${cacheKey}; ${usage}; ` +
          `source=extension-only; ${fingerprint}; ${retry}; ${activeWarm}; ${deferral}${savings}`;
        if (result.deferred) {
          ctx.ui.notify(`Probe deferred - ${result.deferred.reason} (${diagnostics})`, "warning");
          return;
        }
        if (!result.ok) {
          const refusal = resolveWarmNowFailure({
            ok: result.ok,
            unavailable: result.unavailable,
            capabilityState: result.capabilityState,
            automaticWarm: warmer.getCapability().automaticWarm,
            xaiBestEffort,
          });
          ctx.ui.notify(
            `${manualOnlyWarning}${refusal?.failureLabel ?? "Probe failed"}: ${result.error} (${diagnostics})`,
            refusal?.level ?? "error",
          );
          return;
        }
        if (result.capabilityState === "unverified") {
          ctx.ui.notify(
            `${manualOnlyWarning}${xaiBestEffort ? "xAI best-effort " : ""}unverified manual probe ${result.cacheHit ? "hit" : "miss"} (${diagnostics}). No active keepalive or verified savings claim.`,
            "warning",
          );
          return;
        }
        const probeLabel = xaiBestEffort
          ? "xAI best-effort extension probe"
          : "Extension probe";
        if (result.probeOutcome === "transient-miss") {
          ctx.ui.notify(
            `${probeLabel} miss (transient; retry scheduled) (${diagnostics})`,
            "info",
          );
          return;
        }
        if (result.probeOutcome === "payload-drift") {
          ctx.ui.notify(`${probeLabel} miss (payload drift; re-anchor required) (${diagnostics})`, "warning");
          return;
        }
        ctx.ui.notify(
          result.cacheHit
            ? `${probeLabel} hit (${diagnostics})`
            : `${probeLabel} miss (${diagnostics})`,
          result.cacheHit ? "info" : "warning",
        );
        return;
      }

      const lower = trimmed.toLowerCase();
      let candidate: WarmCacheConfig;
      try { candidate = parseConfigArgs(trimmed, warmer.getConfig()); }
      catch (error) {
        ctx.ui.notify(`Invalid settings: ${error instanceof Error ? error.message : String(error)}. Nothing changed.`, "warning");
        return;
      }
      const sessionOnly = lower.split(/\s+/).filter(token => token.startsWith("scope=")).at(-1) === "scope=session";
      const persistConfig = () => {
        advisorWarmer.configure(config, ctx);
        if (config.warmAdvisor) ctx.ui.notify(advisorWarmer.status(), "info");
        ctx.ui.notify(sessionOnly ? "Settings apply to this session only." : `Settings saved to ${warmCacheConfigPath()}; other running sessions keep their runtime settings until reload.`, "info");
      };
      const resumeRequested =
        lower === "resume" ||
        lower === "on" ||
        lower.split(/\s+/).includes("resume") ||
        lower.split(/\s+/).includes("on");

      if (lower === "resume") {
        warmer.bindContext(ctx);
        warmer.clearAutoWarmBlock("user /warm resume");
        ctx.ui.notify(
          `${warmer.isXaiRoute() ? "xAI best-effort " : "pi-warm-cache "}sticky block cleared. Timers resume if enabled (use /warm codex-off to disable Codex auto-warm).`,
          "info",
        );
        warmer.reschedule();
        return;
      }

      // Validate and persist before touching live schedulers. Replay the command
      // against the latest disk state; unrelated session/CLI overrides stay local.
      try {
        if (!sessionOnly) {
          if (saveConfig) saveConfig(candidate);
          else saveConfigArgs(trimmed);
        }
      } catch (error) {
        ctx.ui.notify(`Settings unchanged: ${error instanceof Error ? error.message : String(error)}`, "warning");
        return;
      }
      configSource = sessionOnly ? "runtime settings + session override (not saved)" : "runtime settings; last command saved (other overrides remain local)";
      if (/(?:^|\s)(?:5m|short|1h|long|ttl=\S+)(?:\s|$)/.test(lower)) {
        ctx.ui.notify("Legacy TTL preference retained; it does not change provider cache retention. Use interval=auto for provider cadence.", "info");
      }
      if (lower === "codex-on" || lower === "codex-off") {
        config = candidate;
        bridge.configure(ctx, config);
        warmer.bindContext(ctx);
        if (lower === "codex-on") {
          warmer.clearAutoWarmBlock("user /warm codex-on");
        }
        warmer.setConfig(config);
        persistConfig();
        ctx.ui.notify(
          lower === "codex-on"
            ? `Codex auto-warm enabled (replay=${config.codexWarmMode}). Sticky block still applies if out is huge.`
            : "Codex auto-warm disabled. /warm now still works for a one-shot probe.",
          "info",
        );
        warmer.reschedule();
        return;
      }

      config = candidate;
      bridge.configure(ctx, config);
      warmer.bindContext(ctx);
      if (resumeRequested && config.enabled) {
        warmer.clearAutoWarmBlock("user /warm on");
      }
      warmer.setConfig(config);
      persistConfig();

      if (!config.enabled) {
        clearWarmUi(ctx);
        ctx.ui.notify(effectiveMode(config) === "native"
          ? "Extension warming disabled; native Pi policy owns warming on 0.86+ (unavailable on 0.85.1)."
          : "Warming off: extension and native session warming stopped while this extension is loaded.", "info");
        return;
      }

      if (config.anthropicTtl === "1h" && ctx.model?.api === "anthropic-messages") {
        ctx.ui.notify(
          "1h mode follows Pi's on-wire long TTL. This extension does not rewrite real turns. Set Pi cache retention to long if you want 1h caches.",
          "info",
        );
      }

      const block = warmer.getAutoWarmBlockReason();
      ctx.ui.notify(
        `Cache warming on${warmer.isXaiRoute() ? " (xAI best-effort)" : ""} · ${formatWarmSettings(config, ctx.model?.api)}${block ? " · automatic warming blocked" : ""}`,
        "info",
      );
      warmer.reschedule();
    },
  });
}
