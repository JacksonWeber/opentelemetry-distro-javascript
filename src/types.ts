// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { AzureMonitorOpenTelemetryOptions } from "@azure/monitor-opentelemetry";

/**
 * Configuration options for the Microsoft OpenTelemetry distro.
 *
 * Options are organized by scope:
 * - Top-level fields are **global** and apply regardless of backend.
 * - {@link azureMonitor} contains Azure Monitor-specific settings.
 * - {@link otlp} contains OTLP export-specific settings (planned).
 * - {@link a365} contains A365 agent observability settings (planned).
 */
export interface MicrosoftOpenTelemetryOptions {
    // ── Azure Monitor scoped ─────────────────────────────────────────────
    /**
     * Azure Monitor configuration.
     * When provided (or when the APPLICATIONINSIGHTS_CONNECTION_STRING
     * environment variable is set), Azure Monitor export is enabled.
     */
    azureMonitor?: AzureMonitorOpenTelemetryOptions;

    // ── OTLP scoped ────────────────────────────────────────────────────
    /**
     * OTLP export configuration.
     * When provided — or when any `OTEL_EXPORTER_OTLP_*` environment
     * variables are set — traces, metrics, and/or logs are exported via OTLP.
     */
    otlp?: OtlpOptions;

    // ── A365 scoped (planned) ────────────────────────────────────────────
    /**
     * A365 agent observability configuration.
     * When provided, the A365 exporter, Microsoft Agent Framework
     * instrumentation, and baggage extensions are enabled.
     *
     * @remarks Not yet implemented – reserved for Phase 6.
     */
    a365?: A365Options;
}

/**
 * OTLP export configuration.
 *
 * When no explicit values are provided, the standard OpenTelemetry
 * environment variables are used as fallback:
 *
 * | Option       | Environment variable                    |
 * | ------------ | --------------------------------------- |
 * | `endpoint`   | `OTEL_EXPORTER_OTLP_ENDPOINT`           |
 * | `protocol`   | `OTEL_EXPORTER_OTLP_PROTOCOL`           |
 * | `headers`    | `OTEL_EXPORTER_OTLP_HEADERS`            |
 *
 * Signal-specific endpoint overrides are also respected:
 * `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`,
 * `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`,
 * `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`.
 */
export interface OtlpOptions {
    /** OTLP endpoint URL. */
    endpoint?: string;

    /** OTLP transport protocol. */
    protocol?: "grpc" | "http/protobuf" | "http/json";

    /** Additional headers sent with every OTLP request. */
    headers?: Record<string, string>;

    /** Enable OTLP trace export. Defaults to true when otlp options are provided. */
    enableTraceExport?: boolean;

    /** Enable OTLP metric export. Defaults to true when otlp options are provided. */
    enableMetricExport?: boolean;

    /** Enable OTLP log export. Defaults to true when otlp options are provided. */
    enableLogExport?: boolean;
}

/**
 * A365 agent observability configuration (planned).
 *
 * @remarks Not yet implemented – reserved for Phase 6.
 */
export interface A365Options {
    /** A365 exporter endpoint. */
    endpoint?: string;

    /** Enable Microsoft Agent Framework instrumentation. */
    enableAgentFrameworkInstrumentation?: boolean;

    /** Enable A365 baggage extensions. */
    enableBaggageExtensions?: boolean;
}

export type { AzureMonitorOpenTelemetryOptions };
