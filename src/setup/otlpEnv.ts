// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Standard OpenTelemetry OTLP exporter environment variables.
 *
 * When any of these are set the distro treats OTLP export as enabled,
 * even if no explicit {@link OtlpOptions} were passed to
 * `useMicrosoftOpenTelemetry()`.
 *
 * @see https://opentelemetry.io/docs/languages/sdk-configuration/otlp-exporter/
 */
export const OTLP_ENV_VARS = [
    "OTEL_EXPORTER_OTLP_ENDPOINT",
    "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
    "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
    "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
] as const;

/**
 * Returns `true` when at least one standard OTLP environment variable
 * is set to a non-empty value.
 */
export function isOtlpConfiguredViaEnvironment(): boolean {
    return OTLP_ENV_VARS.some((v) => !!process.env[v]);
}
