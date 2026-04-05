// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Azure Monitor setup module.
 *
 * Currently delegates to the published `@azure/monitor-opentelemetry`
 * package.  Once the Azure Monitor code is fully migrated into this
 * repository (see azure-monitor-opentelemetry/ and PLANNING.md Phase 3),
 * this module will use the in-repo implementation directly.
 */

import {
    useAzureMonitor,
    shutdownAzureMonitor,
} from "@azure/monitor-opentelemetry";
import type { AzureMonitorOpenTelemetryOptions } from "@azure/monitor-opentelemetry";

/**
 * Set up Azure Monitor OpenTelemetry export.
 *
 * @param options - Azure Monitor configuration, or undefined when
 *   activation is driven solely by the environment variable.
 */
export function setupAzureMonitor(
    options: AzureMonitorOpenTelemetryOptions | undefined,
): void {
    useAzureMonitor(options);
}

/**
 * Shut down Azure Monitor, flushing pending telemetry.
 */
export async function teardownAzureMonitor(): Promise<void> {
    await shutdownAzureMonitor();
}
