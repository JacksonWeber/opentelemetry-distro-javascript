// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * OTLP export setup module (planned).
 *
 * This module will configure OTLP export for traces, metrics, and logs
 * when {@link OtlpOptions} are provided.
 *
 * @remarks Not yet implemented – reserved for Phase 4.
 */

import type { OtlpOptions } from "../types.js";

/**
 * Set up OTLP export for traces, metrics, and/or logs.
 *
 * @param _options - OTLP configuration.
 */
export function setupOtlp(_options: OtlpOptions): void {
    // Phase 4: Integrate OTLP exporters for traces, logs, and metrics.
    // This will attach OTLPTraceExporter, OTLPMetricExporter, and
    // OTLPLogExporter to the providers created during core setup.
}

/**
 * Shut down OTLP exporters, flushing pending telemetry.
 */
export async function teardownOtlp(): Promise<void> {
    // Phase 4: Flush and shut down OTLP exporters.
}
