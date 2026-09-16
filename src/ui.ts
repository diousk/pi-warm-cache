import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { bestEffortFamilyLabel } from "./provider.ts";
import type {
  CacheAnchor,
  ProviderCapability,
  StrategyPlan,
  WarmCacheConfig,
  WarmDeferralState,
} from "./types.ts";

const WIDGET_ID = "pi-warm-cache";
const STATUS_ID = "pi-warm-cache";

export function clearWarmUi(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  ctx.ui.setWidget(WIDGET_ID, undefined);
  ctx.ui.setStatus(STATUS_ID, undefined);
}

/** Keep a manual-only route visible without implying that a timer is active. */
export function renderManualOnlyUi(
  ctx: ExtensionContext,
  config: Pick<WarmCacheConfig, "showWidget">,
  capability: ProviderCapability,
  probeReady = false,
): void {
  if (!ctx.hasUI) return;

  const xai = /xai/i.test(capability.reason);
  const routeLabel = xai
    ? "xAI best-effort"
    : capability.reason.startsWith("OpenRouter")
      ? "OpenRouter"
      : capability.reason.startsWith("OpenCode Go")
        ? "OpenCode Go"
        : "Cache-warm";
  const probeLine = probeReady
    ? "Safe /warm now probe ready · savings n/a (unverified route)"
    : "Waiting for a safe captured payload · savings n/a (unverified route)";
  const lines = [
    ctx.ui.theme.fg("warning", `⚠ ${routeLabel} · MANUAL ONLY`),
    ctx.ui.theme.fg("dim", "Automatic warming disabled · no timer will start"),
    ctx.ui.theme.fg("dim", probeLine),
  ];

  if (config.showWidget) {
    ctx.ui.setWidget(WIDGET_ID, lines);
  } else {
    ctx.ui.setWidget(WIDGET_ID, undefined);
  }
  ctx.ui.setStatus(
    STATUS_ID,
    ctx.ui.theme.fg(
      "warning",
      `${xai ? "xAI best-effort " : ""}warm · manual only${probeReady ? " · /warm now ready" : " · waiting for payload"}`,
    ),
  );
}

/** Explain a rejected route and keep an eligible manual-only route visible. */
export function renderCapabilityNotice(
  ctx: ExtensionContext,
  capability: ProviderCapability,
  config: Pick<WarmCacheConfig, "showWidget"> = { showWidget: true },
): void {
  if (!ctx.hasUI) return;
  const xai = /xai/i.test(capability.reason);
  const routeLabel = xai ? "xAI best-effort" : "pi-warm-cache";
  if (capability.state === "unverified") {
    if (capability.manualProbe) {
      renderManualOnlyUi(ctx, config, capability);
    } else {
      clearWarmUi(ctx);
    }
    const mode = capability.manualProbe ? "manual-only route" : "unverified route";
    const probe = capability.manualProbe
      ? "Use /warm now for one safe captured-payload probe."
      : "No safe manual probe is available for this captured route.";
    ctx.ui.notify(
      `${routeLabel} ${mode}: ${capability.reason}. Automatic warming is disabled. ${probe} Savings are n/a (unverified route).`,
      "warning",
    );
    return;
  }
  clearWarmUi(ctx);
  ctx.ui.notify(
    `${xai ? "xAI best-effort inactive" : "pi-warm-cache inactive"} (unsupported route): ${capability.reason}. Automatic and manual warming are disabled.`,
    "info",
  );
}

export function renderWaitingUi(
  ctx: ExtensionContext,
  config: WarmCacheConfig,
  anchor: CacheAnchor,
  plan: StrategyPlan,
  nextDueAt: number,
  deferral?: WarmDeferralState | null,
): void {
  if (!ctx.hasUI) return;

  const remainingMs = Math.max(0, nextDueAt - Date.now());
  const waitLabel = formatDurationShort(remainingMs);
  const ratio = formatProbeRatio(anchor);
  const label = bestEffortFamilyLabel(plan.family);
  const waitDetail = deferral
    ? deferral.reason === "concurrency limit"
      ? `deferred - ${deferral.activeWarmSessions}/${deferral.maxConcurrentWarmSessions} slots used`
      : `deferred - ${formatDeferralStatus(deferral)}`
    : ratio;
  // showWidget controls the editor widget only. The status line remains available
  // as the compact extension surface when the widget is hidden.
  const lines = [
    ctx.ui.theme.fg(
      "accent",
      label
        ? `⚡ ${label} · Cache warming active · Next refresh in ${waitLabel}`
        : `⚡ Cache warming active · Next refresh in ${waitLabel}`,
    ),
    ...(waitDetail ? [ctx.ui.theme.fg("dim", waitDetail)] : []),
  ];

  if (config.showWidget) {
    ctx.ui.setWidget(WIDGET_ID, lines);
  } else {
    ctx.ui.setWidget(WIDGET_ID, undefined);
  }
  ctx.ui.setStatus(
    STATUS_ID,
    ctx.ui.theme.fg(
      "dim",
      `${label ? `${label} · ` : ""}Cache warming active · Next refresh in ${waitLabel}${waitDetail ? ` · ${waitDetail}` : ""}`,
    ),
  );
}

export function formatDeferralStatus(deferral: WarmDeferralState): string {
  if (deferral.reason === "concurrency limit") {
    return `${deferral.reason} (${deferral.activeWarmSessions}/${deferral.maxConcurrentWarmSessions} slots used)`;
  }
  return deferral.reason;
}

export function renderWarmHitUi(
  ctx: ExtensionContext,
  config: WarmCacheConfig,
  anchor: CacheAnchor,
  plan: StrategyPlan,
  cacheRead: number,
): void {
  if (!ctx.hasUI) return;

  const tokens = formatStatusTokens(cacheRead || anchor.cachedTokens);
  const ratio = formatProbeRatio(anchor);
  const label = bestEffortFamilyLabel(plan.family);
  const nextLabel =
    label === "xAI best-effort"
      ? `Next refresh in ${formatDurationShort(plan.intervalMs ?? 0)} · no fixed xAI cache lifetime promised.`
      : label !== null
        ? `Next refresh in ${formatDurationShort(plan.intervalMs ?? 0)} · no fixed cache lifetime promised.`
        : `Next refresh in ${formatDurationShort(plan.intervalMs ?? 0)}`;
  const lines = [
    ctx.ui.theme.fg(
      "success",
      `⚡ ${label ? `${label} · ` : ""}Cache refreshed · Cache hit · ~${tokens}`,
    ),
    ctx.ui.theme.fg("dim", nextLabel),
    ...(ratio ? [ctx.ui.theme.fg("dim", ratio)] : []),
  ];

  if (config.showWidget) {
    ctx.ui.setWidget(WIDGET_ID, lines);
  } else {
    ctx.ui.setWidget(WIDGET_ID, undefined);
  }
  ctx.ui.setStatus(
    STATUS_ID,
    ctx.ui.theme.fg(
      "success",
      `${label ? `${label} · ` : ""}Cache refreshed · ${nextLabel}${ratio ? ` · ${ratio}` : ""}`,
    ),
  );
}

/**
 * Neutral idle/info state (not an error).
 * Used for waiting-for-first-turn, disabled, unsupported, prefix-too-small.
 *
 * label is the best-effort family label ("xAI best-effort", "OpenCode Go
 * best-effort", or null). The isXaiText sniff applies only when label is
 * null: an explicit non-xai label always wins over "xai" in detail text.
 */
export function renderIdleUi(
  ctx: ExtensionContext,
  config: WarmCacheConfig,
  reason: string,
  detail?: string,
  label: string | null = null,
): void {
  if (!ctx.hasUI) return;

  const xai = label === "xAI best-effort" || (label === null && (isXaiText(reason) || isXaiText(detail)));
  const title = `${xai ? "xAI best-effort · " : ""}Cache warming`;
  const state = reason === "disabled" ? "off"
    : reason === "agent working" ? `standby · ${detail ?? "Agent working"}`
    : reason.includes("prefix <") ? "Prompt too short for warming"
    : reason === "idle cutoff reached" ? "Paused after inactivity"
    : /waiting for (next|first)/i.test(reason) ? "Waiting for your next message"
    : `Paused · ${compactUiText(reason)}`;
  if (config.showWidget) {
    const lines = [
      ctx.ui.theme.fg("dim", `⚡ ${title}${reason === "agent working" ? " " : " · "}${state}`),
    ];
    if (reason !== "agent working" && detail && detail.length > 0) {
      lines.push(ctx.ui.theme.fg("dim", compactUiText(detail)));
    }
    ctx.ui.setWidget(WIDGET_ID, lines.slice(0, 2));
  } else {
    ctx.ui.setWidget(WIDGET_ID, undefined);
  }

  ctx.ui.setStatus(
    STATUS_ID,
    ctx.ui.theme.fg("dim", `${title}${reason === "agent working" ? " " : " · "}${state}`),
  );
}

/**
 * Non-alarming state shown after a hard invalidation.
 * No extension probe is allowed until the next real turn captures a new payload.
 */
export function renderReanchorUi(
  ctx: ExtensionContext,
  config: WarmCacheConfig,
  reason: string,
  label: string | null = null,
): void {
  if (!ctx.hasUI) return;

  const xai = label === "xAI best-effort" || (label === null && isXaiText(reason));
  const prefix = xai ? "xAI best-effort " : "";
  const cause = reanchorCause(reason);
  if (config.showWidget) {
    ctx.ui.setWidget(WIDGET_ID, [
      ctx.ui.theme.fg("accent", `⚡ ${prefix}cache-warm paused · re-anchoring ${cause}`),
      ctx.ui.theme.fg("dim", `${xai ? "xAI best-effort extension probes paused" : "Waiting for next real turn. Extension probes paused."}`),
    ]);
  } else {
    ctx.ui.setWidget(WIDGET_ID, undefined);
  }
  ctx.ui.setStatus(STATUS_ID, ctx.ui.theme.fg("dim", `${prefix}warm · re-anchoring`));
}

/**
 * Quiet retry state for the first implicit-cache no-read/no-write response.
 * This is intentionally neutral rather than an error notification.
 */
export function renderProbeRetryUi(
  ctx: ExtensionContext,
  config: WarmCacheConfig,
  detail: string,
  nextDueAt?: number,
  label: string | null = null,
): void {
  if (!ctx.hasUI) return;

  const xai = label === "xAI best-effort" || (label === null && isXaiText(detail));
  const retryLine =
    nextDueAt !== undefined && nextDueAt > Date.now()
      ? `Next refresh in ${formatDurationShort(nextDueAt - Date.now())}.`
      : "Retrying cache refresh.";
  if (config.showWidget) {
    ctx.ui.setWidget(WIDGET_ID, [
      ctx.ui.theme.fg(
        "warning",
        `⚡ ${xai ? "xAI best-effort " : "Cache-warm "}retry · extension probe transient miss`,
      ),
      ctx.ui.theme.fg("dim", `${compactUiText(detail)} · ${retryLine}`),
    ]);
  } else {
    ctx.ui.setWidget(WIDGET_ID, undefined);
  }
  ctx.ui.setStatus(STATUS_ID, ctx.ui.theme.fg("dim", `${xai ? "xAI best-effort " : ""}warm · retrying probe`));
}

/**
 * Real failure / retry panel. Keep visible so a dead loop never looks healthy.
 * Always show retry timing when nextDueAt is in the future.
 */
export function renderFailureUi(
  ctx: ExtensionContext,
  config: WarmCacheConfig,
  reason: string,
  detail?: string,
  nextDueAt?: number,
  label: string | null = null,
): void {
  if (!ctx.hasUI) return;

  const xai = label === "xAI best-effort" || (label === null && (isXaiText(reason) || isXaiText(detail)));
  const blocked = /blocked/i.test(reason);
  const retryLine = blocked
    ? `${xai ? "xAI best-effort auto-warm stays off" : "Auto-warm stays off"} until /warm resume.`
    : nextDueAt !== undefined && nextDueAt > Date.now()
      ? `Next refresh in ${formatDurationShort(nextDueAt - Date.now())}.`
      : "Warming stopped until the next real turn or /warm now.";
  const error = /error|failed|no model/i.test(reason);
  const title = error ? "Cache-warm error" : "Cache-warm warning";
  const statusKind = error ? "error" : "warning";
  const prefix = xai ? "xAI best-effort " : "";

  if (config.showWidget) {
    const lines = [
      ctx.ui.theme.fg(statusKind, `⚡ ${prefix}${title} · ${shortProblem(reason)}`),
    ];
    if (detail && detail.length > 0) {
      lines.push(ctx.ui.theme.fg("dim", compactUiText(detail)));
    }
    lines.push(ctx.ui.theme.fg("dim", retryLine));
    ctx.ui.setWidget(WIDGET_ID, lines.slice(0, 3));
  } else {
    ctx.ui.setWidget(WIDGET_ID, undefined);
  }

  ctx.ui.setStatus(
    STATUS_ID,
    ctx.ui.theme.fg(
      statusKind,
      `${prefix}warm · ${error ? "error" : "warning"}: ${shortProblem(reason)}`,
    ),
  );
}

function formatDurationShort(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes > 0 ? `${minutes}m${remainder ? ` ${remainder}s` : ""}` : `${seconds}s`;
}

function formatProbeRatio(anchor: Pick<CacheAnchor, "probeHitCount" | "probeMissCount">): string {
  const total = anchor.probeHitCount + anchor.probeMissCount;
  return total > 0 ? `Cache hits: ${anchor.probeHitCount} · Misses: ${anchor.probeMissCount}` : "";
}

function formatStatusTokens(tokens: number): string {
  if (tokens < 1000) return `${Math.round(tokens)}`;
  if (tokens < 1_000_000) return `${Math.round(tokens / 1000)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}m`;
}

function reanchorCause(reason: string): string {
  const lower = reason.toLowerCase();
  if (lower.includes("compact")) return "after compaction";
  if (lower.includes("branch") || lower.includes("tree")) return "after branch change";
  if (lower.includes("model") || lower.includes("thinking")) {
    return "after model or thinking-level change";
  }
  if (lower.includes("prompt_cache_key")) return "after cache-key change";
  if (lower.includes("payload") || lower.includes("prefix") || lower.includes("drift")) {
    return "after prefix drift";
  }
  return "after session change";
}

function shortProblem(reason: string): string {
  const lower = reason.toLowerCase();
  if (lower.includes("too many failures")) return "too many probe failures";
  if (lower.includes("codex") && lower.includes("blocked")) return "Codex auto-warm blocked";
  if (lower.includes("codex") && lower.includes("output")) return "Codex probe output high";
  if (lower.includes("payload") && lower.includes("re-anchor")) return "probe payload drift";
  if (lower.includes("probe miss")) return "extension probe miss";
  if (lower.includes("probe error")) return "extension probe error";
  return compactUiText(reason, 48);
}

function compactUiText(value: string, max = 72): string {
  const compact = value.trim().replace(/\s+/g, " ");
  if (compact.length <= max) return compact;
  return `${compact.slice(0, Math.max(1, max - 3)).trimEnd()}...`;
}

function isXaiText(value: string | undefined): boolean {
  return value !== undefined && /xai/i.test(value);
}
