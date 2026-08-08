// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Azure Monitor–specific initialization that runs alongside the main setup.
 * SDK Stats, Browser SDK Loader, and Live Metrics SDK prefix are
 * Azure Monitor concerns — not part of the generic OTel lifecycle.
 */

import type { InternalConfig } from "../shared/config.js";
import type { SdkStatsFeatures } from "../types.js";
import { BrowserSdkLoader } from "./browserSdkLoader/browserSdkLoader.js";
import { setSdkPrefix } from "./metrics/quickpulse/utils.js";
import { Logger } from "../shared/logging/index.js";

/**
 * Check whether Azure Monitor has a usable connection string available
 * (from config or the APPLICATIONINSIGHTS_CONNECTION_STRING env var).
 *
 * @internal
 */
export function hasAzureMonitorConnectionString(config: InternalConfig): boolean {
  return (
    !!config.azureMonitorExporterOptions?.connectionString ||
    !!process.env["APPLICATIONINSIGHTS_CONNECTION_STRING"]
  );
}

/**
 * Validate Azure Monitor prerequisites and log a warning when the
 * connection string is missing. Returns true when Azure Monitor can proceed.
 *
 * @internal
 */
export function validateAzureMonitorConfig(config: InternalConfig): boolean {
  if (hasAzureMonitorConnectionString(config)) {
    return true;
  }
  Logger.getInstance().warn(
    "Azure Monitor was enabled but no connection string was provided. " +
      "Set the APPLICATIONINSIGHTS_CONNECTION_STRING environment variable or pass " +
      "azureMonitor.azureMonitorExporterOptions.connectionString. " +
      "Azure Monitor will be disabled.",
  );
  return false;
}

/**
 * Compute Azure Monitor–specific SDK Stats features from the config.
 * Does not write to the env var — the caller consolidates all features.
 *
 * @internal
 */
export function getAzureMonitorSdkStatsFeatures(config: InternalConfig): SdkStatsFeatures {
  return {
    browserSdkLoader: config.browserSdkLoaderOptions.enabled,
    aadHandling: !!config.azureMonitorExporterOptions?.credential,
    diskRetry: !config.azureMonitorExporterOptions?.disableOfflineStorage,
    // Only report this when the AKS resource detector itself populated the AKS cluster
    // attributes, which requires the customer to have configured access to the
    // aks-cluster-metadata ConfigMap (RBAC + env var or mounted ConfigMap).
    aksResourceDetectorPopulation: config.aksResourceDetectorPopulated,
  };
}

/**
 * Set up Azure Monitor–specific components (browser SDK loader,
 * live-metrics SDK prefix). Returns a dispose callback for shutdown.
 *
 * @internal
 */
export function setupAzureMonitorComponents(config: InternalConfig): () => void {
  // ── Browser SDK Loader ────────────────────────────────────────────
  let browserSdkLoader: BrowserSdkLoader | undefined;
  if (config.browserSdkLoaderOptions.enabled) {
    browserSdkLoader = new BrowserSdkLoader(config);
  }

  // ── Live Metrics SDK prefix ───────────────────────────────────────
  setSdkPrefix();

  // Return dispose callback for shutdown
  return () => {
    browserSdkLoader?.dispose();
  };
}
