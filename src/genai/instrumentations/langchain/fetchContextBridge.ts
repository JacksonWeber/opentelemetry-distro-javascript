// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { context, diag, Span, trace } from "@opentelemetry/api";
import { AsyncLocalStorageProviderSingleton } from "@langchain/core/singletons";
import { LangChainTracer } from "./tracer.js";

/**
 * Bridges LangChain's async execution context to the OpenTelemetry context so
 * that outgoing HTTP client spans (produced by `@opentelemetry/instrumentation-undici`
 * when the OpenAI SDK — or any fetch-based provider — issues a request) nest
 * under the LangChain LLM/agent span that triggered them.
 *
 * Why this is needed: the LangChain instrumentation is a passive callback
 * tracer. It reconstructs parent/child relationships among its own spans from
 * the LangChain run tree, but it never makes a span "active" in the OTel
 * context. The undici instrumentation, by contrast, parents its span purely
 * off `context.active()` at the moment `fetch()` runs. With no active span at
 * that point, each HTTP call becomes the root of its own, disconnected trace —
 * so the calls never show up under the agent/LLM in the trace view.
 *
 * The bridge patches the global `fetch` and, for calls made while a LangChain
 * run is active, activates the resolved parent span for the (synchronous)
 * duration of the `fetch()` call — which is when undici emits its
 * `undici:request:create` event and reads the active context. Calls made
 * outside a LangChain run are passed through unchanged.
 */

const PATCH_MARKER = Symbol.for("microsoft-otel-langchain-fetch-context-bridge");
const OTEL_LANGCHAIN_TRACER_NAME = "OpenTelemetryLangChainTracer";

type PatchedFetch = typeof globalThis.fetch & {
  [PATCH_MARKER]?: boolean;
  __originalFetch?: typeof globalThis.fetch;
};

/**
 * Resolve the OTel span that an outgoing fetch should nest under, using the
 * LangChain run config that is active in the AsyncLocalStorage at call time.
 */
function resolveActiveLangChainSpan(): Span | undefined {
  try {
    const config = AsyncLocalStorageProviderSingleton.getRunnableConfig();
    // `callbacks` is a CallbackManager whose handlers include our tracer and
    // whose `getParentRunId()` identifies the currently executing run.
    const callbacks = config?.callbacks as
      | {
          handlers?: unknown[];
          inheritableHandlers?: unknown[];
          getParentRunId?: () => string | undefined;
        }
      | undefined;
    if (!callbacks || typeof callbacks.getParentRunId !== "function") {
      return undefined;
    }

    const handlers = Array.isArray(callbacks.handlers)
      ? callbacks.handlers
      : callbacks.inheritableHandlers;
    if (!Array.isArray(handlers)) {
      return undefined;
    }

    const tracer = handlers.find(
      (h): h is LangChainTracer =>
        !!h &&
        (h as { name?: string }).name === OTEL_LANGCHAIN_TRACER_NAME &&
        typeof (h as LangChainTracer).resolveFetchParentSpan === "function",
    );
    if (!tracer) {
      return undefined;
    }

    return tracer.resolveFetchParentSpan(callbacks.getParentRunId());
  } catch {
    return undefined;
  }
}

/**
 * Patch the global `fetch` (idempotently) so LangChain-driven requests carry an
 * active parent span. No-op when there is no global `fetch` (older Node).
 */
export function installLangChainFetchContextBridge(): void {
  const currentFetch = globalThis.fetch as PatchedFetch | undefined;
  if (typeof currentFetch !== "function" || currentFetch[PATCH_MARKER]) {
    return;
  }

  const originalFetch = currentFetch;
  const patched = function (
    this: unknown,
    ...args: Parameters<typeof globalThis.fetch>
  ): ReturnType<typeof globalThis.fetch> {
    const span = resolveActiveLangChainSpan();
    if (span) {
      const ctx = trace.setSpan(context.active(), span);
      return context.with(ctx, () => originalFetch.apply(this, args));
    }
    return originalFetch.apply(this, args);
  } as PatchedFetch;

  patched[PATCH_MARKER] = true;
  patched.__originalFetch = originalFetch;
  globalThis.fetch = patched;
  diag.debug(
    "[LangChainTraceInstrumentor] Installed fetch context bridge so HTTP client spans nest under LangChain spans",
  );
}

/** Restore the original global `fetch` if the bridge was installed. */
export function uninstallLangChainFetchContextBridge(): void {
  const currentFetch = globalThis.fetch as PatchedFetch | undefined;
  if (typeof currentFetch === "function" && currentFetch[PATCH_MARKER]) {
    globalThis.fetch = currentFetch.__originalFetch ?? currentFetch;
  }
}
