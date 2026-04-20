// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { metrics, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import type { NodeSDKConfiguration } from "@opentelemetry/sdk-node";
import { NodeSDK } from "@opentelemetry/sdk-node";
import type { MetricReader, ViewOptions } from "@opentelemetry/sdk-metrics";
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { LogRecordProcessor } from "@opentelemetry/sdk-logs";

import { InternalConfig } from "../shared/config.js";
import { JsonConfig } from "../shared/jsonConfig.js";
import { MetricHandler } from "../azureMonitor/metrics/index.js";
import { TraceHandler } from "../azureMonitor/traces/handler.js";
import { LogHandler } from "../azureMonitor/logs/index.js";
import { AZURE_MONITOR_OPENTELEMETRY_VERSION } from "../types.js";
import { patchOpenTelemetryInstrumentationEnable } from "../azureMonitor/utils/opentelemetryInstrumentationPatcher.js";
import { parseResourceDetectorsFromEnvVar } from "../utils/common.js";
import { setupAzureMonitorComponents } from "../azureMonitor/index.js";
import { isOtlpEnabled, createOtlpComponents } from "../otlp/index.js";
import {
  ObservabilityManager,
  ObservabilityConfiguration,
} from "@microsoft/agents-a365-observability";
import type { IConfigurationProvider } from "@microsoft/agents-a365-runtime";
import type { MicrosoftOpenTelemetryOptions } from "../types.js";
import { MICROSOFT_OPENTELEMETRY_VERSION } from "../types.js";

process.env["AZURE_MONITOR_DISTRO_VERSION"] = AZURE_MONITOR_OPENTELEMETRY_VERSION;
process.env["MICROSOFT_OPENTELEMETRY_VERSION"] = MICROSOFT_OPENTELEMETRY_VERSION;

let sdk: NodeSDK;
let disposeAzureMonitor: (() => void) | undefined;

/**
 * Initialize Microsoft OpenTelemetry distribution.
 *
 * This is the primary entry point for the distro. It sets up OpenTelemetry
 * providers and instrumentations, then attaches the configured exporters:
 * - Azure Monitor (when `options.azureMonitor` is provided)
 * - OTLP HTTP (when `OTEL_EXPORTER_OTLP_ENDPOINT` is set)
 * - A365 (when `options.a365.enabled` is true or `ENABLE_A365_OBSERVABILITY_EXPORTER=true`)
 *
 * @param options - Microsoft OpenTelemetry configuration options
 */
export function useMicrosoftOpenTelemetry(options?: MicrosoftOpenTelemetryOptions): void {
  const config = new InternalConfig(options);
  patchOpenTelemetryInstrumentationEnable();

  // ── Azure Monitor components (statsbeat, browser SDK loader, etc.) ─
  disposeAzureMonitor = setupAzureMonitorComponents(config);

  // ── Register global providers ─────────────────────────────────────
  // Remove global providers in OpenTelemetry, these would be overridden if present
  metrics.disable();
  trace.disable();
  logs.disable();

  // Clear the entire OpenTelemetry API global state to avoid version conflicts.
  // The disable() calls above remove individual providers but leave the `version` field
  // on the global object intact. If a different version of @opentelemetry/api was loaded
  // first (e.g. by a VS Code extension host or another extension), the stale version
  // causes registerGlobal() in sdk.start() to fail with "All API registration versions
  // must match", resulting in Noop providers. Deleting the global object forces
  // registerGlobal() to create a fresh one with the correct version.
  const globalOpentelemetryApiKey = Symbol.for("opentelemetry.js.api.1");
  delete (globalThis as Record<symbol, unknown>)[globalOpentelemetryApiKey];

  // ── Azure Monitor handlers ────────────────────────────────────────
  const metricHandler = new MetricHandler(config);
  const traceHandler = new TraceHandler(config, metricHandler);
  const logHandler = new LogHandler(config, metricHandler);

  const instrumentations = traceHandler
    .getInstrumentations()
    .concat(logHandler.getInstrumentations());

  const resourceDetectorsList = parseResourceDetectorsFromEnvVar();

  // ── Merge user-provided processors / readers / views ──────────────
  // Clone caller-provided arrays to avoid mutating them when OTLP components are appended.
  const spanProcessors: SpanProcessor[] = [...(options?.spanProcessors || [])];
  const logRecordProcessors: LogRecordProcessor[] = [...(options?.logRecordProcessors || [])];
  const customViews: ViewOptions[] = [...(options?.views || [])];

  // Always include Azure Monitor metric reader
  const metricReaders: MetricReader[] = [
    metricHandler.getMetricReader(),
    ...(options?.metricReaders || []),
  ];

  // ── OTLP HTTP exporters (enabled via OTEL_EXPORTER_OTLP_ENDPOINT) ─
  if (isOtlpEnabled()) {
    const otlp = createOtlpComponents();
    if (otlp.spanProcessor) {
      spanProcessors.push(otlp.spanProcessor);
    }
    if (otlp.metricReader) {
      metricReaders.push(otlp.metricReader);
    }
    if (otlp.logRecordProcessor) {
      logRecordProcessors.push(otlp.logRecordProcessor);
    }
  }

  // ── A365 observability (enabled via env var, JSON config, or options) ──
  // Precedence: env vars > JSON config > programmatic options.
  const envExporterFlag = (process.env.ENABLE_A365_OBSERVABILITY_EXPORTER ?? "")
    .trim()
    .toLowerCase();
  const jsonA365 = JsonConfig.getInstance().a365;

  // Merge A365 options: programmatic < JSON config < env vars
  const mergedA365 = {
    enabled: options?.a365?.enabled,
    tokenResolver: options?.a365?.tokenResolver,
    clusterCategory: options?.a365?.clusterCategory,
    domainOverride: options?.a365?.domainOverride,
    authScopes: options?.a365?.authScopes,
    perRequestExport: options?.a365?.perRequestExport,
    // JSON config overrides programmatic options
    ...(jsonA365
      ? {
          ...(jsonA365.enabled !== undefined ? { enabled: jsonA365.enabled } : {}),
          ...(jsonA365.clusterCategory !== undefined
            ? { clusterCategory: jsonA365.clusterCategory }
            : {}),
          ...(jsonA365.domainOverride !== undefined
            ? { domainOverride: jsonA365.domainOverride }
            : {}),
          ...(jsonA365.authScopes !== undefined ? { authScopes: jsonA365.authScopes } : {}),
          ...(jsonA365.perRequestExport !== undefined
            ? { perRequestExport: jsonA365.perRequestExport }
            : {}),
          // tokenResolver cannot come from JSON — it's a function
        }
      : {}),
  };

  // Env var has highest precedence for enabled (tri-state: unset → fall through, true/false → override)
  let a365Enabled: boolean;
  if (envExporterFlag) {
    a365Enabled = ["true", "1", "yes", "on"].includes(envExporterFlag);
  } else {
    a365Enabled = mergedA365.enabled ?? false;
  }

  const views: ViewOptions[] = metricHandler.getViews().concat(customViews);

  // ── Create and start NodeSDK ──────────────────────────────────────
  const sdkConfig: Partial<NodeSDKConfiguration> = {
    autoDetectResources: true,
    metricReaders: metricReaders,
    views,
    instrumentations: instrumentations,
    logRecordProcessors: [
      logHandler.getAzureLogRecordProcessor(),
      ...logRecordProcessors,
      logHandler.getBatchLogRecordProcessor(),
    ],
    resource: config.resource,
    sampler: traceHandler.getSampler(),
    spanProcessors: [
      traceHandler.getAzureMonitorSpanProcessor(),
      ...spanProcessors,
      traceHandler.getBatchSpanProcessor(),
    ],
    resourceDetectors: resourceDetectorsList,
  };
  sdk = new NodeSDK(sdkConfig);
  // TODO: Enable auto-attach warning — see autoAttach.ts
  sdk.start();

  // ── A365: attach processors to the now-active global provider ─────
  // ObservabilityManager.start() detects the existing global TracerProvider
  // and adds its baggage-enricher + exporter processors without creating
  // a second NodeSDK instance.
  if (a365Enabled) {
    // Ensure the env var is set so the npm package's internal exporter check passes
    if (!process.env.ENABLE_A365_OBSERVABILITY_EXPORTER) {
      process.env.ENABLE_A365_OBSERVABILITY_EXPORTER = "true";
    }
    if (mergedA365.perRequestExport && !process.env.ENABLE_A365_OBSERVABILITY_PER_REQUEST_EXPORT) {
      process.env.ENABLE_A365_OBSERVABILITY_PER_REQUEST_EXPORT = "true";
    }
    if (mergedA365.domainOverride && !process.env.A365_OBSERVABILITY_DOMAIN_OVERRIDE) {
      process.env.A365_OBSERVABILITY_DOMAIN_OVERRIDE = mergedA365.domainOverride;
    }

    // Build a config provider if the caller specified domain override or auth scopes
    let configProvider: IConfigurationProvider<ObservabilityConfiguration> | undefined;
    if (mergedA365.domainOverride || mergedA365.authScopes) {
      const domainOverride = mergedA365.domainOverride ?? null;
      const authScopes = mergedA365.authScopes;
      configProvider = {
        getConfiguration: () =>
          new ObservabilityConfiguration({
            isObservabilityExporterEnabled: () => true,
            observabilityDomainOverride: () => domainOverride,
            ...(authScopes ? { observabilityAuthenticationScopes: () => authScopes } : {}),
          }),
      };
    }

    ObservabilityManager.start({
      tokenResolver: mergedA365.tokenResolver,
      clusterCategory: mergedA365.clusterCategory,
      configProvider,
    });
  }
}

/**
 * Shutdown Microsoft OpenTelemetry distribution.
 */
export function shutdownMicrosoftOpenTelemetry(): Promise<void> {
  disposeAzureMonitor?.();
  return sdk?.shutdown();
}

/**
 * Get the internal SDK instance for testing purposes
 * @internal
 */

export function _getSdkInstance(): NodeSDK | undefined {
  return sdk;
}
