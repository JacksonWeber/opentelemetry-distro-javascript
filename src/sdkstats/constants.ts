// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Shared constants for the SDKStats Network pipeline.
 *
 * Centralizes the wire-format metric names, HTTP status-code buckets,
 * endpoint category labels, and bounded `exceptionType` strings used by
 * the network statsbeat accumulator ({@link ../networkStats.ts}), the
 * OTLP exporter wrapper ({@link ../otlpWrapper.ts}), and the A365
 * exporter ({@link ../../a365/exporter/Agent365Exporter.ts}).
 *
 * Ideally the wire-format metric names would be imported directly from
 * the `StatsbeatCounter` enum in `@azure/monitor-opentelemetry-exporter`
 * so we have a single source of truth. That package, however, only
 * publishes the enum at
 * `dist/{esm,commonjs}/export/statsbeat/types.{js,d.ts}` and its
 * `package.json#exports` field restricts subpath imports to `.` and
 * `./package.json`, so the enum is not part of its public surface. We
 * mirror the values here and keep them in lockstep with the upstream
 * enum — sending envelopes under any other name returns HTTP 200 but
 * the AzMon SDKStats backend doesn't index them.
 */

// ---------------------------------------------------------------------------
// Wire-format metric names. Must match the `StatsbeatCounter` enum in
// `@azure/monitor-opentelemetry-exporter/dist/{esm,commonjs}/export/statsbeat/types.js`.
// ---------------------------------------------------------------------------

export const REQUEST_SUCCESS_NAME = "Request_Success_Count";
export const REQUEST_FAILURE_NAME = "Request_Failure_Count";
export const REQUEST_DURATION_NAME = "Request_Duration";
export const RETRY_COUNT_NAME = "Retry_Count";
export const THROTTLE_COUNT_NAME = "Throttle_Count";
export const EXCEPTION_COUNT_NAME = "Exception_Count";

/**
 * Names of registered network SDKStats metrics, in registration order.
 *
 * @internal
 */
export const NETWORK_METRIC_NAMES = [
  REQUEST_SUCCESS_NAME,
  REQUEST_FAILURE_NAME,
  REQUEST_DURATION_NAME,
  RETRY_COUNT_NAME,
  THROTTLE_COUNT_NAME,
  EXCEPTION_COUNT_NAME,
] as const;

export type NetworkMetricName = (typeof NETWORK_METRIC_NAMES)[number];

// ---------------------------------------------------------------------------
// HTTP status-code buckets per the Application Insights SDKStats Network
// specification. Used by `classifyStatusCode` and by exporter wrappers that
// need a defensive secondary classification.
// ---------------------------------------------------------------------------

export const RETRY_STATUSES: ReadonlySet<number> = new Set([
  401, 403, 408, 429, 500, 502, 503, 504,
]);
export const THROTTLE_STATUSES: ReadonlySet<number> = new Set([402, 439]);
// 206 is handled by the caller (per-envelope breakdown). 307/308 are
// followed by the HTTP client transparently and are not reported.
export const IGNORED_STATUSES: ReadonlySet<number> = new Set([206, 307, 308]);

/**
 * Per the OTLP/HTTP response specification, retryable HTTP status codes
 * are 429, 502, 503, and 504. The upstream OTLP delegate normally routes
 * these through its `retryable` branch (no status code surfaced), but
 * wrappers classify defensively for the rare case the failure branch
 * still carries a retryable code (e.g. retries exhausted).
 */
export const OTLP_HTTP_RETRYABLE_STATUSES: ReadonlySet<number> = new Set([429, 502, 503, 504]);

// ---------------------------------------------------------------------------
// Endpoint category labels. Per spec, `endpoint` is a category label, not
// the destination URL.
// ---------------------------------------------------------------------------

export const OTLP_ENDPOINT_CATEGORY = "otlp";
export const A365_ENDPOINT_CATEGORY = "a365";

/**
 * Sentinel `statusCode` dimension used when the upstream OTLP delegate
 * has discarded the original HTTP status code (currently the retryable
 * 429/502/503/504 path). Keeps the dimension present per spec.
 */
export const OTLP_UNKNOWN_STATUS = "unknown";

// ---------------------------------------------------------------------------
// Bounded set of `exceptionType` labels for `Exception_Count`.
// Cardinality must stay bounded so the SDKStats backend can index it.
// ---------------------------------------------------------------------------

export const EXC_TIMEOUT = "Timeout exception";
export const EXC_NETWORK = "Network exception";
export const EXC_CLIENT = "Client exception";

/**
 * Node socket error codes that we treat as transient network failures
 * when classifying an exception into the `Network exception` bucket.
 */
export const RETRYABLE_NETWORK_ERROR_CODES: ReadonlySet<string> = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENOTFOUND",
  "ENETUNREACH",
  "EHOSTUNREACH",
]);
