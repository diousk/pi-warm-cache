import { AsyncLocalStorage } from "node:async_hooks";
import type { Api, Context, Model, SimpleStreamOptions, AssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type Stream = (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;
interface Runtime { streamSimple: Stream }
interface RequestScope { ctx?: ExtensionContext }

/** Observe the result of the entire agent hook chain, not an intermediate hook payload.
 * The private runtime boundary is capability checked; unsupported hosts fail closed.
 */
export class FinalPayloadCapture {
  private scope = new AsyncLocalStorage<RequestScope>();
  private runtime?: Runtime;
  private original?: Stream;
  private wrapper?: Stream;

  private capture: <Payload>(payload: Payload, ctx: ExtensionContext) => void;
  private unavailable: (ctx: ExtensionContext) => void;
  constructor(capture: <Payload>(payload: Payload, ctx: ExtensionContext) => void,
    unavailable: (ctx: ExtensionContext) => void = () => {}) {
    this.capture = capture;
    this.unavailable = unavailable;
  }

  install(ctx: ExtensionContext): boolean {
    const runtime = runtimeFromRegistry(ctx.modelRegistry);
    if (this.runtime === runtime && this.wrapper) return true;
    this.dispose();
    // SAFETY: Pi's private runtime can be absent on an unsupported host.
    // oxlint-disable-next-line anti-slop/no-runtime-typeof
    if (!runtime || typeof runtime.streamSimple !== "function") return false;
    const original = runtime.streamSimple;
    const wrapper: Stream = (model, context, options) => {
      if (this.wrapper !== wrapper || !options?.onPayload) return original.call(runtime, model, context, options);
      const onPayload = options.onPayload;
      return original.call(runtime, model, context, {
        ...options,
        onPayload: (payload, requestModel) => {
          const scope: RequestScope = {};
          return this.scope.run(scope, async () => {
            const replacement = await onPayload(payload, requestModel);
            const observed = scope.ctx;
            if (this.wrapper === wrapper && observed) {
              if (observed.model?.provider === model.provider && observed.model.id === model.id) {
                try { this.capture(replacement === undefined ? payload : replacement, observed); }
                catch { this.unavailable(observed); }
              } else this.unavailable(observed);
            }
            return replacement;
          });
        },
      });
    };
    try {
      runtime.streamSimple = wrapper;
      this.runtime = runtime;
      this.original = original;
      this.wrapper = wrapper;
      return true;
    } catch { return false; }
  }

  /** Called only by real agent requests; probes and advisor calls do not mark a scope. */
  observe(ctx: ExtensionContext): boolean {
    const scope = this.scope.getStore();
    if (!scope) return false;
    scope.ctx = ctx;
    return true;
  }

  dispose(): void {
    if (this.runtime && this.runtime.streamSimple === this.wrapper && this.original) this.runtime.streamSimple = this.original;
    this.runtime = undefined;
    this.original = undefined;
    this.wrapper = undefined;
  }
}

function runtimeFromRegistry<Registry>(registry: Registry): Runtime | undefined {
  // SAFETY: optional private runtime is capability checked by install before use.
  return (registry as { runtime?: Runtime }).runtime;
}
