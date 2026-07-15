// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
// Vendored from microsoft/Agent365-nodejs packages/agents-a365-observability-extensions-langchain

import { context, trace, Span, SpanKind, SpanStatusCode, Tracer } from "@opentelemetry/api";
import { BaseTracer, Run } from "@langchain/core/tracers/base";
import { isTracingSuppressed } from "@opentelemetry/core";
import { diag } from "@opentelemetry/api";
import {
  ATTR_ERROR_MESSAGE,
  ATTR_ERROR_TYPE,
  ATTR_GEN_AI_CALLER_AGENT_NAME,
  ATTR_GEN_AI_PROVIDER_NAME,
} from "../../index.js";
import * as Utils from "./utils.js";

type RunWithSpan = { run: Run; span: Span; startTime: number; lastAccessTime: number };

/**
 * OpenTelemetry-based tracer for LangChain / LangGraph applications.
 *
 * Extends LangChain's `BaseTracer` callback handler so it can be injected into
 * the LangChain callback system (via `LangChainTraceInstrumentor`). Every
 * LangChain "run" (agent invocation, tool execution, or LLM call) is mapped to
 * an OTel span with GenAI semantic convention attributes.
 *
 * Key behaviors:
 * - Creates a span on `onRunCreate` and ends it on `_endTrace`.
 * - Maintains parent–child span relationships by tracking run IDs and walking
 *   up the parent chain to find the nearest span context.
 * - Skips LangChain-internal runs (tagged `langsmith:hidden`, `Branch*`, or
 *   unmapped run types) to avoid noisy traces.
 * - Guards against unbounded memory with a hard cap of {@link MAX_RUNS}.
 * - Content attributes (messages, tool args) are always recorded
 *   (aligned with Python/.NET SDKs).
 */
export class LangChainTracer extends BaseTracer {
  /** Hard cap on concurrent tracked runs to prevent memory leaks. */
  private static readonly MAX_RUNS = 10_000;
  /** Hard cap on parent-chain walk depth to guard against cycles. */
  private static readonly MAX_DEPTH = 1_000;
  private tracer: Tracer;
  /** Active runs keyed by LangChain run ID. */
  private runs = new Map<string, RunWithSpan>();
  /** Maps each run ID → its parent run ID for parent-span-context lookup. */
  private parentByRunId = new Map<string, string | undefined>();

  constructor(tracer: Tracer) {
    super();
    this.tracer = tracer;
  }

  name = "OpenTelemetryLangChainTracer";

  protected persistRun(_run: Run): Promise<void> {
    return Promise.resolve();
  }

  /**
   * Called by LangChain when a new run starts. Records the parent mapping
   * and opens a span via {@link startTracing}.
   */
  async onRunCreate(run: Run) {
    this.parentByRunId.set(run.id, run.parent_run_id);
    if (super.onRunCreate) await super.onRunCreate(run);
    this.startTracing(run);
  }

  /**
   * Opens an OTel span for the given run. The span name is derived from the
   * operation type (invoke_agent, execute_tool, chat) and the run/model name.
   * Internal or unknown runs are silently skipped.
   */
  protected startTracing(run: Run) {
    if (isTracingSuppressed(context.active())) {
      return;
    }

    // Idempotent: a span may already have been created for this run either by
    // the normal (backgrounded) callback or on demand via ensureSpanForRun.
    if (this.runs.has(run.id)) {
      return;
    }

    const operation = Utils.getOperationType(run);

    // Skip internal runs (LangSmith hidden, Branch nodes, unknown operations)
    if (
      run.tags?.includes("langsmith:hidden") ||
      run.name?.startsWith("Branch") ||
      operation === "unknown"
    ) {
      diag.debug(
        `[LangChainTracer] Skipping internal run: ${run.name} (parent: ${run.parent_run_id})`,
      );
      // Note: we intentionally KEEP this run's parentByRunId entry so the
      // parent-chain walk (getNearestParentSpan / resolveFetchParentSpan) can
      // traverse through skipped intermediate nodes to a recorded ancestor.
      // The entry is freed in _endTrace when the run finishes.
      return;
    }

    // Attach to parent span if one exists in the run hierarchy. We put the
    // actual parent Span (not just its SpanContext) into the context so that
    // span processors observing on_start of this span (e.g.
    // GenAIMainAgentSpanProcessor) can read attributes off the parent.
    const parentSpan = this.getNearestParentSpan(run);
    const activeContext = parentSpan
      ? trace.setSpan(context.active(), parentSpan)
      : context.active();

    // Build span name: "<operation> <name|model>"
    let spanName = run.name;
    let kind: SpanKind = SpanKind.INTERNAL;
    if (operation === "invoke_agent") {
      spanName = `${operation} ${run.name}`;
      // In-process agent orchestration (e.g. LangGraph) maps to the GenAI
      // "invoke agent internal span" (SpanKind.INTERNAL), not SERVER. The
      // Azure Monitor exporter turns SERVER spans into requests, which the
      // Application Insights "AI agents (preview)" experience does not treat
      // as agent calls; INTERNAL exports them as dependencies so they surface
      // correctly in the agents graph.
      kind = SpanKind.INTERNAL;
    } else if (operation === "execute_tool") {
      spanName = `${operation} ${run.name}`;
      // Tool execution runs in-process, so per the GenAI semantic conventions
      // "execute tool span" (and matching the Python distro) the span kind is
      // INTERNAL, not CLIENT — it is not an outbound/remote dependency.
      kind = SpanKind.INTERNAL;
    } else if (operation === "chat") {
      spanName = `${operation} ${Utils.getModel(run) || run.name}`.trim();
      kind = SpanKind.CLIENT;
    }

    if (this.runs.size >= LangChainTracer.MAX_RUNS) {
      diag.warn(`[LangChainTracer] Max runs (${LangChainTracer.MAX_RUNS}) reached, skipping span`);
      this.parentByRunId.delete(run.id);
      return;
    }

    const startTime = run.start_time ?? Date.now();
    const span = this.tracer.startSpan(
      spanName,
      {
        kind,
        startTime,
        attributes: { [ATTR_GEN_AI_PROVIDER_NAME]: "langchain" },
      },
      activeContext,
    );

    // Set identity attributes (operation, agent, session/conversation) BEFORE
    // any child run starts, so that span processors observing on_start of
    // child spans (e.g. GenAIMainAgentSpanProcessor) can read them from this
    // parent span. Output/usage/model attributes are still set at end time
    // because their values are not known yet.
    try {
      Utils.setOperationTypeAttribute(operation, span);
      Utils.setAgentAttributes(run, span);
      Utils.setSessionIdAttribute(run, span);
    } catch (error) {
      diag.debug(
        `[LangChainTracer] Failed to set start-time attributes for run ${run.name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    this.runs.set(run.id, { run, span, startTime, lastAccessTime: startTime });
  }

  /**
   * Called by LangChain when a run finishes. Sets status, enriches the span
   * with GenAI attributes, and ends it.
   */
  protected async _endTrace(run: Run) {
    if (isTracingSuppressed(context.active())) {
      // End any span that was started before suppression to avoid leaks.
      const suppressedEntry = this.runs.get(run.id);
      if (suppressedEntry) {
        suppressedEntry.span.end(run.end_time ?? undefined);
      }
      this.parentByRunId.delete(run.id);
      this.runs.delete(run.id);
      return;
    }

    const operation = Utils.getOperationType(run);
    if (
      run.tags?.includes("langsmith:hidden") ||
      run.name?.startsWith("Branch") ||
      operation === "unknown"
    ) {
      diag.debug(
        `[LangChainTracer] Skipping internal run: ${run.name} (parent: ${run.parent_run_id})`,
      );
      // These runs never get a span; free their parent mapping so it does not
      // accumulate (parentByRunId is not bounded by MAX_RUNS).
      this.parentByRunId.delete(run.id);
      return;
    }

    const entry = this.runs.get(run.id);
    if (!entry) {
      // No span was recorded for this run (e.g. suppressed or skipped);
      // ensure we do not leak its parent mapping.
      this.parentByRunId.delete(run.id);
      return;
    }

    const { span } = entry;
    try {
      entry.lastAccessTime = Date.now();

      if (run.error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        span.setAttribute(ATTR_ERROR_MESSAGE, String(run.error));
        const errorType =
          (run.error as { name?: string })?.name ??
          (run.error as { constructor?: { name?: string } })?.constructor?.name;
        if (typeof errorType === "string" && errorType.length > 0) {
          span.setAttribute(ATTR_ERROR_TYPE, errorType);
        }
      } else {
        span.setStatus({ code: SpanStatusCode.OK });
      }

      // Always-on attributes: operation type, agent info, model, provider, session, tokens.
      // Operation/agent/session are also set at span start so that
      // GenAIMainAgentSpanProcessor.onStart sees them on child spans; setting
      // them again here is idempotent and guarantees end-time corrections
      // (e.g. metadata that only becomes available mid-run) still land.
      Utils.setOperationTypeAttribute(operation, span);
      Utils.setAgentAttributes(run, span);
      if (operation === "invoke_agent") {
        const callerName = this.findCallerAgentName(run);
        if (callerName) {
          span.setAttribute(ATTR_GEN_AI_CALLER_AGENT_NAME, callerName);
        }
      }
      Utils.setModelAttribute(run, span);
      Utils.setChoiceCountAttribute(run, span);
      Utils.setResponseIdAttribute(run, span);
      Utils.setProviderNameAttribute(run, span);
      Utils.setSessionIdAttribute(run, span);
      Utils.setTokenAttributes(run, span);

      // Content attributes — always recorded (aligned with Python/.NET SDKs)
      Utils.setToolAttributes(run, span);
      Utils.setInputMessagesAttribute(run, span);
      Utils.setOutputMessagesAttribute(run, span);
      Utils.setSystemInstructionsAttribute(run, span);
    } catch (error) {
      diag.error(
        `[LangChainTracer] Error setting span attributes for run ${run.name}: ${error instanceof Error ? error.message : String(error)}`,
      );
      span.setStatus({ code: SpanStatusCode.ERROR });
    } finally {
      span.end(run.end_time ?? undefined);
      this.runs.delete(run.id);
      this.parentByRunId.delete(run.id);
      await super._endTrace(run);
    }
  }

  /**
   * Walks up the parent run chain to find the nearest ancestor that has an
   * active span, returning that Span so the new span can be linked as a
   * child and processors can read parent attributes.
   */
  private getNearestParentSpan(run: Run) {
    let pid = run.parent_run_id;

    while (pid) {
      const entry = this.runs.get(pid);
      if (entry) return entry.span;
      pid = this.parentByRunId.get(pid);
    }
    return undefined;
  }

  /**
   * Walk up the parent run chain to find the nearest ancestor that is an
   * invoke_agent run, returning its name as the caller agent name.
   */
  private findCallerAgentName(run: Run): string | undefined {
    let pid = run.parent_run_id;
    while (pid) {
      const entry = this.runs.get(pid);
      if (entry && Utils.getOperationType(entry.run) === "invoke_agent") {
        return entry.run.name;
      }
      pid = this.parentByRunId.get(pid);
    }
    return undefined;
  }

  /**
   * Resolve the OTel span an outgoing HTTP (fetch) client span should nest
   * under, given the LangChain run id active at fetch time. Used ONLY by the
   * legacy fetch context bridge fallback (for `@langchain/core` versions that
   * lack the native `wrapRunExecution` hook).
   *
   * Resolution is deliberately conservative to avoid mis-parenting under
   * concurrency: it returns the span for the exact `runId`, otherwise the
   * nearest recorded ancestor span (walking the parent chain). It does NOT
   * guess an active descendant LLM — with concurrent sibling LLM runs that
   * heuristic could attach a request to the wrong chat span (false telemetry).
   * Nesting under the enclosing agent is less precise but always correct.
   *
   * Returns `undefined` when nothing can be resolved, in which case the HTTP
   * span keeps its default (root) parent — no worse than without the bridge.
   */
  resolveFetchParentSpan(runId: string | undefined): Span | undefined {
    if (!runId) {
      return undefined;
    }
    let cur: string | undefined = runId;
    let hops = 0;
    while (cur && hops++ < LangChainTracer.MAX_DEPTH) {
      const entry = this.runs.get(cur);
      if (entry) return entry.span;
      cur = this.parentByRunId.get(cur);
    }
    return undefined;
  }

  /**
   * Return the OTel span for `runId`, creating it synchronously on demand if
   * the (backgrounded) span-creating callback has not run yet.
   *
   * The LangChain `CallbackManager` registers the run in this tracer's run map
   * *synchronously* — before it backgrounds the span-creating handler — to
   * avoid callback-ordering races. So even on the very first request we can
   * look up the run via {@link getRunById} and open its span immediately.
   * {@link startTracing} is idempotent, so this never double-creates a span.
   */
  ensureSpanForRun(runId: string): Span | undefined {
    const existing = this.runs.get(runId);
    if (existing) {
      return existing.span;
    }
    const run = this.getRunById(runId);
    if (!run) {
      return undefined;
    }
    if (!this.parentByRunId.has(run.id)) {
      this.parentByRunId.set(run.id, run.parent_run_id);
    }
    this.startTracing(run);
    return this.runs.get(runId)?.span;
  }

  /**
   * Native context-propagation hook invoked by `@langchain/core` (via
   * `BaseRunManager.withRunContext`) around the body of a run — e.g. a chat
   * model's network call or a tool's execution. Making the run's span active
   * here means lower-level client instrumentations (undici/`fetch`, DB
   * drivers) emit their spans nested under it instead of as orphan traces.
   *
   * This supersedes the fetch context bridge for `@langchain/core` versions
   * that support the hook: it is exact (no heuristic), race-free (via
   * {@link ensureSpanForRun}), and works for every run type — not just
   * `fetch`.
   */
  wrapRunExecution<T>(runId: string, fn: () => T): T {
    const span = this.ensureSpanForRun(runId);
    if (!span) {
      return fn();
    }
    return context.with(trace.setSpan(context.active(), span), fn);
  }
}
