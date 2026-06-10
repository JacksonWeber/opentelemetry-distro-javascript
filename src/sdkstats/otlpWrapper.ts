// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Network SDKStats wrappers for OTLP exporters.
 *
 * Decorates upstream OTLP HTTP exporters so the network SDKStats pipeline
 * can record per-export success/failure/retry/throttle/exception counts
 * and request duration per the Application Insights SDKStats Network
 * specification (`endpoint="otlp"`, per-host).
 *
 * ## Upstream signal availability
 *
 * The upstream `@opentelemetry/otlp-exporter-base` delegate only exposes
 * `ExportResult` (SUCCESS/FAILED) plus an optional `error`. For
 * non-retryable HTTP responses the error is an `OTLPExporterError`
 * carrying the HTTP `code`, so we can record `Request_Failure_Count`
 * with the actual status. For HTTP responses the OTLP/HTTP spec
 * classifies as retryable (429, 502, 503, 504) the upstream constructs
 * a synthetic error with no `code`, so the original status is lost; we
 * record `Retry_Count` with `statusCode="unknown"` in that case.
 * Network errors, timeouts, and other thrown exceptions are recorded as
 * `Exception_Count` with a bounded set of `exceptionType` labels.
 *
 * Mirrors `src/microsoft/opentelemetry/_sdkstats/_otlp_wrapper.py` from
 * the Python implementation (microsoft/opentelemetry-distro-python#144).
 */

import type { ExportResult } from "@opentelemetry/core";
import { ExportResultCode } from "@opentelemetry/core";
import type {
  AggregationTemporality,
  AggregationOption,
  InstrumentType,
  PushMetricExporter,
  ResourceMetrics,
} from "@opentelemetry/sdk-metrics";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import type { LogRecordExporter, ReadableLogRecord } from "@opentelemetry/sdk-logs";

import {
  recordSuccess,
  recordFailure,
  recordRetry,
  recordException,
  recordDuration,
  shortHost,
} from "./networkStats.js";
import {
  OTLP_ENDPOINT_CATEGORY,
  OTLP_UNKNOWN_STATUS,
  OTLP_HTTP_RETRYABLE_STATUSES,
  RETRYABLE_NETWORK_ERROR_CODES,
  EXC_TIMEOUT,
  EXC_NETWORK,
  EXC_CLIENT,
} from "./constants.js";

interface ErrorWithCode {
  code?: unknown;
  name?: unknown;
  message?: unknown;
}

function asErrorWithCode(err: unknown): ErrorWithCode | undefined {
  return typeof err === "object" && err !== null ? (err as ErrorWithCode) : undefined;
}

/**
 * Treat `error.code` as an HTTP status code only when it is an integer
 * in a plausible HTTP response range. Guards against arbitrary numeric
 * `code` fields on non-HTTP errors.
 */
function asHttpStatus(code: unknown): number | undefined {
  if (typeof code !== "number" || !Number.isInteger(code)) return undefined;
  if (code < 100 || code > 599) return undefined;
  return code;
}

function classifyExceptionType(error: unknown): string {
  const err = asErrorWithCode(error);
  if (!err) return EXC_CLIENT;
  const name = typeof err.name === "string" ? err.name : "";
  if (name === "AbortError" || name === "TimeoutError") return EXC_TIMEOUT;
  if (typeof err.message === "string" && err.message === "Request timed out") return EXC_TIMEOUT;
  if (name === "TypeError") return EXC_NETWORK;
  if (typeof err.code === "string" && RETRYABLE_NETWORK_ERROR_CODES.has(err.code)) {
    return EXC_NETWORK;
  }
  return EXC_CLIENT;
}

/**
 * Record the appropriate SDKStats counter for an OTLP export failure,
 * given the host and the error surfaced by the upstream delegate.
 *
 * See file-level "Upstream signal availability" comment for rationale.
 */
function recordOtlpFailure(host: string, error: unknown): void {
  const err = asErrorWithCode(error);
  const httpStatus = err ? asHttpStatus(err.code) : undefined;

  if (httpStatus !== undefined) {
    // The OTLP/HTTP "throttle" classification additionally requires a
    // Retry-After header that the upstream delegate does not expose to
    // us, so we conservatively bucket 429 as retry rather than throttle.
    if (OTLP_HTTP_RETRYABLE_STATUSES.has(httpStatus)) {
      recordRetry(OTLP_ENDPOINT_CATEGORY, host, httpStatus);
    } else {
      recordFailure(OTLP_ENDPOINT_CATEGORY, host, httpStatus);
    }
    return;
  }

  // Upstream delegate's synthetic message for HTTP retryable responses
  // (429/502/503/504) discards the status code. Record as retry with an
  // "unknown" status code so the dimension stays present per spec.
  if (
    err &&
    typeof err.message === "string" &&
    err.message === "Export failed with retryable status"
  ) {
    recordRetry(OTLP_ENDPOINT_CATEGORY, host, OTLP_UNKNOWN_STATUS);
    return;
  }

  recordException(OTLP_ENDPOINT_CATEGORY, host, classifyExceptionType(error));
}

/**
 * Resolve the short-host string for a given OTLP signal.
 *
 * The OTel HTTP exporters do not expose their endpoint on a stable public
 * field, so we read the same env-var precedence the exporters themselves
 * use ({@link https://opentelemetry.io/docs/specs/otel/protocol/exporter/}).
 * Falls back to `"unknown"` when no endpoint can be resolved (e.g. fully
 * programmatic config without env vars).
 */
function resolveShortHost(signal: "traces" | "metrics" | "logs"): string {
  const signalSpecific =
    signal === "traces"
      ? "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"
      : signal === "metrics"
        ? "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT"
        : "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT";

  const raw = process.env[signalSpecific] ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!raw) return "unknown";
  return shortHost(raw);
}

/**
 * Common bookkeeping for an export attempt.
 *
 * Records success/exception counters and request duration regardless of
 * outcome, per the SDKStats spec ("Request_Duration ... avg request
 * duration for all requests during the scheduled interval").
 */
function wrapExport<T>(
  host: string,
  inner: (resultCallback: (result: ExportResult) => void) => void,
  resultCallback: (result: ExportResult) => void,
  _items: T,
): void {
  const start = Date.now();
  let settled = false;
  const settle = (result: ExportResult): void => {
    if (settled) return;
    settled = true;
    recordDuration(OTLP_ENDPOINT_CATEGORY, host, Date.now() - start);
    if (result.code === ExportResultCode.SUCCESS) {
      recordSuccess(OTLP_ENDPOINT_CATEGORY, host);
    } else {
      recordOtlpFailure(host, result.error);
    }
    resultCallback(result);
  };

  try {
    inner(settle);
  } catch (err) {
    settle({
      code: ExportResultCode.FAILED,
      error: err instanceof Error ? err : new Error(String(err)),
    });
  }
}

/**
 * Span exporter decorator that records network SDKStats counts.
 */
export class NetworkStatsSpanExporter implements SpanExporter {
  private readonly host: string;

  constructor(private readonly inner: SpanExporter) {
    this.host = resolveShortHost("traces");
  }

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    wrapExport(this.host, (cb) => this.inner.export(spans, cb), resultCallback, spans);
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush?.() ?? Promise.resolve();
  }
}

/**
 * Metric exporter decorator that records network SDKStats counts.
 *
 * `selectAggregationTemporality` / `selectAggregation` are forwarded only
 * when the inner exporter defines them — preserving its preferences while
 * keeping our wrapper transparent to the SDK's default-aggregation logic
 * for exporters that don't.
 */
export class NetworkStatsMetricExporter implements PushMetricExporter {
  private readonly host: string;
  selectAggregationTemporality?: (instrumentType: InstrumentType) => AggregationTemporality;
  selectAggregation?: (instrumentType: InstrumentType) => AggregationOption;

  constructor(private readonly inner: PushMetricExporter) {
    this.host = resolveShortHost("metrics");
    if (inner.selectAggregationTemporality) {
      this.selectAggregationTemporality = (t) => inner.selectAggregationTemporality!(t);
    }
    if (inner.selectAggregation) {
      this.selectAggregation = (t) => inner.selectAggregation!(t);
    }
  }

  export(metrics: ResourceMetrics, resultCallback: (result: ExportResult) => void): void {
    wrapExport(this.host, (cb) => this.inner.export(metrics, cb), resultCallback, metrics);
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush();
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }
}

/**
 * Log exporter decorator that records network SDKStats counts.
 */
export class NetworkStatsLogExporter implements LogRecordExporter {
  private readonly host: string;

  constructor(private readonly inner: LogRecordExporter) {
    this.host = resolveShortHost("logs");
  }

  export(logs: ReadableLogRecord[], resultCallback: (result: ExportResult) => void): void {
    wrapExport(this.host, (cb) => this.inner.export(logs, cb), resultCallback, logs);
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush?.() ?? Promise.resolve();
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }
}
