import * as piAi from "@earendil-works/pi-ai";
import type { Context, Tool } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

interface TranscriptHelpers {
  normalizeContext?: (context: Context) => { messages: readonly { role: string }[] };
  getCurrentSystemPrompt?: (messages: readonly { role: string }[]) => string;
  getCurrentTools?: (messages: readonly { role: string }[]) => Tool[];
}

// SAFETY: optional exports are checked before use; 0.85.1 has no transcript helpers.
const transcript = piAi as TranscriptHelpers;

/** Resolve the effective prompt/tools without changing the original request. */
export function currentInstructions(context: Context) {
  if (transcript.normalizeContext && transcript.getCurrentSystemPrompt && transcript.getCurrentTools) {
    const { messages } = transcript.normalizeContext(context);
    return { prompt: transcript.getCurrentSystemPrompt(messages), tools: transcript.getCurrentTools(messages) };
  }
  return { prompt: context.systemPrompt ?? "", tools: context.tools };
}

export interface NativeWarmingDecision {
  type: "cache_warming_decision";
  action: "warm" | "stop";
  warmCost: number;
  missCost: number;
  continuationProbability: number;
}
type NativeDecisionHandler = (event: NativeWarmingDecision, ctx: ExtensionContext) => { action: "stop" } | undefined;

/** Both supported loaders store arbitrary event names; 0.85.1 never emits this one. */
export function onNativeWarmingDecision(pi: ExtensionAPI, handler: NativeDecisionHandler): void {
  // SAFETY: this exact event/result contract is implemented by Pi 0.86.0. The
  // 0.85.1 loader stores it inertly, despite its older TypeScript overload list.
  const events = pi as ExtensionAPI & { on(event: "cache_warming_decision", handler: NativeDecisionHandler): void };
  events.on("cache_warming_decision", handler);
}

/** Native refreshes reuse before_provider_request but do not emit turn_start. */
export class NativeWarmingCoordinator {
  private nativeRequest = false;

  decide(ownsRoute: boolean): { action: "stop" } | undefined {
    // Also fence a refresh if a later extension overrides our stop decision.
    // If no refresh occurs, the next real turn clears this marker.
    this.nativeRequest = true;
    return ownsRoute ? { action: "stop" } : undefined;
  }

  onRealTurn(): void { this.nativeRequest = false; }
  isNativeRequest(): boolean { return this.nativeRequest; }

  status(ownsRoute: boolean): string {
    return ownsRoute
      ? "Warming owner: pi-warm-cache (native warming veto on Pi 0.86+)"
      : "Warming owner: Pi policy on 0.86+; extension automatic warming inactive";
  }
}
