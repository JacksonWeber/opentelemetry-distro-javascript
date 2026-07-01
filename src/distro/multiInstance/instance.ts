// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Meter, Tracer } from "@opentelemetry/api";
import type { Logger } from "@opentelemetry/api-logs";
import {
  type SpanProcessor,
  BatchSpanProcessor,
  SimpleSpanProcessor,
  ConsoleSpanExporter,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import type { LogRecordProcessor } from "@opentelemetry/sdk-logs";
import {
  LoggerProvider,
  SimpleLogRecordProcessor,
  ConsoleLogRecordExporter,
} from "@opentelemetry/sdk-logs";
import type { MetricReader, ViewOptions } from "@opentelemetry/sdk-metrics";
import {
  MeterProvider,
  ConsoleMetricExporter,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { registerInstrumentations } from "@opentelemetry/instrumentation";

import { InternalConfig } from "../../shared/config.js";
import { MetricHandler } from "../../azureMonitor/metrics/index.js";
import { TraceHandler } from "../../azureMonitor/traces/handler.js";
import { LogHandler } from "../../azureMonitor/logs/index.js";
import {
  hasAzureMonitorConnectionString,
  setupAzureMonitorComponents,
  validateAzureMonitorConfig,
} from "../../azureMonitor/index.js";
import { A365Configuration, Agent365Exporter, A365SpanProcessor } from "../../a365/index.js";
import { configureA365Logger } from "../../a365/logging.js";
import type { MicrosoftOpenTelemetryInstance, MicrosoftOpenTelemetryOptions } from "../../types.js";
import {
  _applyA365InstrumentationDefaults,
  createInstrumentations,
  createSampler,
  createViews,
} from "../instrumentations.js";
import { ensureGlobalSetup } from "./globalSetup.js";
import {
  registerInstance,
  setDefaultInstance,
  unregisterInstance,
  withInstance,
} from "./instanceRegistry.js";

let instanceCounter = 0;

/**
 * Build the child telemetry pipeline (providers + processors/readers +
 * instrumentations) for a single instance. Unlike the single-instance distro
 * path, this does NOT call `NodeSDK.start()` — the child providers are never
 * registered as the global providers. Instead they are registered with the
 * instance registry, the global parent (delegating) providers route to them,
 * and each instance's instrumentations are bound directly to its own providers.
 *
 * Binding instrumentations per instance is what allows a customer to register a
 * **different** set of OpenTelemetry instrumentations (and settings) for the
 * Azure Monitor exporter than for the A365 exporter in the same runtime: each
 * instrumentation emits to its instance's provider → its instance's exporter.
 */
class MicrosoftOpenTelemetryInstanceImpl implements MicrosoftOpenTelemetryInstance {
  readonly id: string;
  private readonly tracerProvider: NodeTracerProvider;
  private readonly meterProvider: MeterProvider;
  private readonly loggerProvider: LoggerProvider;
  private readonly disposers: Array<() => void | Promise<void>> = [];
  private readonly unloadInstrumentations?: () => void;
  private shutdownPromise?: Promise<void>;

  constructor(id: string, options?: MicrosoftOpenTelemetryOptions) {
    this.id = id;
    const config = new InternalConfig(options);

    const azureMonitorRequested =
      options?.azureMonitor?.enabled !== false &&
      (!!options?.azureMonitor || hasAzureMonitorConnectionString(config));
    const azureMonitorEnabled = azureMonitorRequested && validateAzureMonitorConfig(config);

    // ── A365 export ─────────────────────────────────────────────────
    const a365Config = new A365Configuration(options?.a365);
    if (a365Config.logLevel !== undefined) {
      configureA365Logger({ logLevel: a365Config.logLevel });
    }

    // When this instance targets A365 only (no Azure Monitor), default to
    // GenAI-focused telemetry by disabling non-GenAI instrumentations unless
    // the caller explicitly configured them — mirroring the single-instance
    // distro path. This is applied per instance, so an Azure Monitor instance
    // and an A365 instance in the same runtime keep independent instrumentation
    // sets.
    const applyA365Defaults = a365Config.enabled && !azureMonitorEnabled;
    _applyA365InstrumentationDefaults(
      config.instrumentationOptions,
      options?.instrumentationOptions,
      applyA365Defaults,
    );

    if (azureMonitorEnabled) {
      this.disposers.push(setupAzureMonitorComponents(config));
    }

    // ── Per-instance instrumentations & sampler ─────────────────────
    const instrumentations = createInstrumentations(config, {
      filterAzureMonitorRequests: azureMonitorEnabled,
    });
    const sampler = createSampler(config);

    // ── Azure Monitor handlers (only when enabled) ──────────────────
    let metricHandler: MetricHandler | undefined;
    let traceHandler: TraceHandler | undefined;
    let logHandler: LogHandler | undefined;
    if (azureMonitorEnabled) {
      metricHandler = new MetricHandler(config);
      traceHandler = new TraceHandler(config, metricHandler);
      logHandler = new LogHandler(config, metricHandler);
      this.disposers.push(() => metricHandler!.shutdown());
      this.disposers.push(() => traceHandler!.shutdown());
      // LogHandler owns no exporter of its own to dispose; its processors are
      // shut down with the LoggerProvider below.
    }

    // ── Compose pipelines (Azure Monitor + caller-supplied + A365) ──
    const spanProcessors: SpanProcessor[] = [
      ...(traceHandler ? [traceHandler.getAzureMonitorSpanProcessor()] : []),
      ...(options?.spanProcessors ?? []),
    ];

    // A365: enrich spans with baggage/telemetry.sdk attributes, then (when the
    // observability exporter is enabled) batch-export them to A365.
    if (a365Config.enabled) {
      spanProcessors.push(new A365SpanProcessor());
      if (a365Config.enableObservabilityExporter) {
        const a365Exporter = new Agent365Exporter({
          clusterCategory: a365Config.clusterCategory,
          domainOverride: a365Config.domainOverride,
          authScopes: a365Config.authScopes,
          tokenResolver: a365Config.tokenResolver,
          contextualTokenResolver: a365Config.contextualTokenResolver,
          useS2SEndpoint: a365Config.useS2SEndpoint,
          ...(a365Config.maxQueueSize !== undefined && {
            maxQueueSize: a365Config.maxQueueSize,
          }),
          ...(a365Config.scheduledDelayMilliseconds !== undefined && {
            scheduledDelayMilliseconds: a365Config.scheduledDelayMilliseconds,
          }),
          ...(a365Config.exporterTimeoutMilliseconds !== undefined && {
            exporterTimeoutMilliseconds: a365Config.exporterTimeoutMilliseconds,
          }),
          ...(a365Config.httpRequestTimeoutMilliseconds !== undefined && {
            httpRequestTimeoutMilliseconds: a365Config.httpRequestTimeoutMilliseconds,
          }),
          ...(a365Config.maxExportBatchSize !== undefined && {
            maxExportBatchSize: a365Config.maxExportBatchSize,
          }),
          ...(a365Config.maxPayloadBytes !== undefined && {
            maxPayloadBytes: a365Config.maxPayloadBytes,
          }),
        });
        spanProcessors.push(new BatchSpanProcessor(a365Exporter));
      }
    }

    if (traceHandler) {
      spanProcessors.push(traceHandler.getBatchSpanProcessor());
    }

    const logRecordProcessors: LogRecordProcessor[] = [
      ...(logHandler ? [logHandler.getAzureLogRecordProcessor()] : []),
      ...(options?.logRecordProcessors ?? []),
      ...(logHandler ? [logHandler.getBatchLogRecordProcessor()] : []),
    ];
    const metricReaders: MetricReader[] = [
      ...(metricHandler ? [metricHandler.getMetricReader()] : []),
      ...(options?.metricReaders ?? []),
    ];
    const views: ViewOptions[] = [
      ...(metricHandler ? metricHandler.getViews() : createViews(config)),
      ...(options?.views ?? []),
    ];

    // ── Console fallback when nothing else is configured ────────────
    const a365Exporting = a365Config.enabled && a365Config.enableObservabilityExporter;
    const hasCustomProcessors =
      (options?.spanProcessors?.length ?? 0) > 0 ||
      (options?.metricReaders?.length ?? 0) > 0 ||
      (options?.logRecordProcessors?.length ?? 0) > 0;
    const consoleEnabled =
      options?.enableConsoleExporters ??
      (!azureMonitorEnabled && !a365Exporting && !hasCustomProcessors);
    if (consoleEnabled) {
      spanProcessors.push(new SimpleSpanProcessor(new ConsoleSpanExporter()));
      metricReaders.push(
        new PeriodicExportingMetricReader({
          exporter: new ConsoleMetricExporter(),
          exportIntervalMillis: config.metricExportIntervalMillis,
        }),
      );
      logRecordProcessors.push(new SimpleLogRecordProcessor(new ConsoleLogRecordExporter()));
    }

    // ── Build child providers (NOT registered globally) ─────────────
    this.tracerProvider = new NodeTracerProvider({
      resource: config.resource,
      sampler,
      spanProcessors,
    });
    this.meterProvider = new MeterProvider({
      resource: config.resource,
      views,
      readers: metricReaders,
    });
    this.loggerProvider = new LoggerProvider({
      resource: config.resource,
      processors: logRecordProcessors,
    });

    // ── Bind this instance's instrumentations to its own providers ──
    // Each instrumentation is given THIS instance's providers, so the spans,
    // metrics, and logs it produces flow to this instance's exporter only.
    // Two instances with different `instrumentationOptions` therefore feed
    // their respective exporters with different instrumentation sets.
    if (instrumentations.length > 0) {
      this.unloadInstrumentations = registerInstrumentations({
        instrumentations,
        tracerProvider: this.tracerProvider,
        meterProvider: this.meterProvider,
        loggerProvider: this.loggerProvider,
      });
    }

    registerInstance(this.id, {
      tracerProvider: this.tracerProvider,
      meterProvider: this.meterProvider,
      loggerProvider: this.loggerProvider,
    });
  }

  getTracer(name: string, version?: string): Tracer {
    return this.tracerProvider.getTracer(name, version);
  }

  getMeter(name: string, version?: string): Meter {
    return this.meterProvider.getMeter(name, version);
  }

  getLogger(name: string, version?: string): Logger {
    return this.loggerProvider.getLogger(name, version);
  }

  runWithInstance<T>(fn: () => T): T {
    return withInstance(this.id, fn);
  }

  async forceFlush(): Promise<void> {
    await Promise.all([
      this.tracerProvider.forceFlush(),
      this.meterProvider.forceFlush(),
      this.loggerProvider.forceFlush(),
    ]);
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) {
      return this.shutdownPromise;
    }
    unregisterInstance(this.id);
    // Detach this instance's instrumentations so they stop emitting once it is
    // shut down. Other instances keep their own instrumentations registered.
    this.unloadInstrumentations?.();
    this.shutdownPromise = (async () => {
      // Wrap each disposer so a synchronous throw is captured and does not
      // abort the rest of shutdown.
      await Promise.allSettled(this.disposers.map((d) => Promise.resolve().then(d)));
      await Promise.allSettled([
        this.tracerProvider.shutdown(),
        this.meterProvider.shutdown(),
        this.loggerProvider.shutdown(),
      ]);
    })();
    return this.shutdownPromise;
  }
}

/**
 * Create an isolated Microsoft OpenTelemetry SDK instance.
 *
 * Unlike {@link useMicrosoftOpenTelemetry} (single, global default instance),
 * this can be called multiple times in the same Node.js runtime to run
 * independent, isolated pipelines side by side — for example an Azure Monitor
 * resource and an A365 exporter, each with its own set of OpenTelemetry
 * instrumentations and settings.
 *
 * The first instance created becomes the default for global API access; pass a
 * truthy `makeDefault` to override.
 */
export function createMicrosoftOpenTelemetryInstance(
  options?: MicrosoftOpenTelemetryOptions,
  config?: { makeDefault?: boolean },
): MicrosoftOpenTelemetryInstance {
  ensureGlobalSetup();
  const id = `microsoft-otel-instance-${++instanceCounter}`;
  const instance = new MicrosoftOpenTelemetryInstanceImpl(id, options);
  if (config?.makeDefault) {
    setDefaultInstance(id);
  }
  return instance;
}
