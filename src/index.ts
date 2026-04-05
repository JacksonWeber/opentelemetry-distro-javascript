// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Microsoft OpenTelemetry distro package.
 *
 * Provides a single entry point for configuring OpenTelemetry with
 * Azure Monitor, OTLP-compatible backends, A365 agent observability,
 * and Microsoft-specific extensions.
 */

import { setupAzureMonitor, teardownAzureMonitor } from "./setup/azureMonitor.js";
import { setupOtlp, teardownOtlp } from "./setup/otlp.js";
import { setupA365, teardownA365 } from "./setup/a365.js";
import { isOtlpConfiguredViaEnvironment } from "./setup/otlpEnv.js";

export type {
    MicrosoftOpenTelemetryOptions,
    OtlpOptions,
    A365Options,
    AzureMonitorOpenTelemetryOptions,
} from "./types.js";

import type { MicrosoftOpenTelemetryOptions } from "./types.js";

/**
 * Initialize the Microsoft OpenTelemetry distro.
 *
 * Call this **before** importing any libraries you want instrumented.
 *
 * The function activates each backend whose configuration is provided:
 * 1. Azure Monitor – when {@link MicrosoftOpenTelemetryOptions.azureMonitor}
 *    is set or the `APPLICATIONINSIGHTS_CONNECTION_STRING` env var is present.
 * 2. OTLP export – when {@link MicrosoftOpenTelemetryOptions.otlp} is set
 *    or any `OTEL_EXPORTER_OTLP_*` environment variables are present.
 * 3. A365 agent observability – when {@link MicrosoftOpenTelemetryOptions.a365}
 *    is set (not yet implemented).
 */
export function useMicrosoftOpenTelemetry(
    options?: MicrosoftOpenTelemetryOptions,
): void {
    // 1. Azure Monitor
    if (
        options?.azureMonitor ||
        process.env["APPLICATIONINSIGHTS_CONNECTION_STRING"]
    ) {
        setupAzureMonitor(options?.azureMonitor);
    }

    // 2. OTLP export (Phase 4)
    if (options?.otlp || isOtlpConfiguredViaEnvironment()) {
        setupOtlp(options?.otlp ?? {});
    }

    // 3. A365 agent observability (Phase 6)
    if (options?.a365) {
        setupA365(options.a365);
    }
}

/**
 * Shut down the Microsoft OpenTelemetry distro, flushing any pending
 * telemetry across all active backends.
 */
export async function shutdownMicrosoftOpenTelemetry(): Promise<void> {
    await Promise.all([
        teardownAzureMonitor(),
        teardownOtlp(),
        teardownA365(),
    ]);
}
