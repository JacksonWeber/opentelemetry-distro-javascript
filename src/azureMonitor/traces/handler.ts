// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { AzureMonitorTraceExporter } from "@azure/monitor-opentelemetry-exporter";
import type { BufferConfig } from "@opentelemetry/sdk-trace-base";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";

import type { InternalConfig } from "../../shared/config.js";
import type { MetricHandler } from "../metrics/handler.js";
import { AzureMonitorSpanProcessor } from "./spanProcessor.js";

/**
 * Azure Monitor OpenTelemetry Trace Handler
 */
export class TraceHandler {
  private _batchSpanProcessor: BatchSpanProcessor;
  private _azureSpanProcessor: AzureMonitorSpanProcessor;
  private _azureExporter: AzureMonitorTraceExporter;
  private _config: InternalConfig;
  private _metricHandler: MetricHandler;

  /**
   * Initializes a new instance of the TraceHandler class.
   *
   * Instrumentations are owned by `createInstrumentations`. Creating them here
   * too left an enabled copy the SDK never registered, which kept a no-op meter
   * and suppressed the HTTP duration metrics.
   *
   * @param config - Configuration.
   * @param metricHandler - MetricHandler.
   */
  constructor(config: InternalConfig, metricHandler: MetricHandler) {
    this._config = config;
    this._metricHandler = metricHandler;
    this._azureExporter = new AzureMonitorTraceExporter(this._config.azureMonitorExporterOptions);
    const bufferConfig: BufferConfig = {
      maxExportBatchSize: 512,
      scheduledDelayMillis: 5000,
      exportTimeoutMillis: 30000,
      maxQueueSize: 2048,
    };
    this._batchSpanProcessor = new BatchSpanProcessor(this._azureExporter, bufferConfig);
    this._azureSpanProcessor = new AzureMonitorSpanProcessor(this._metricHandler);
  }

  public getBatchSpanProcessor(): BatchSpanProcessor {
    return this._batchSpanProcessor;
  }

  public getAzureMonitorSpanProcessor(): AzureMonitorSpanProcessor {
    return this._azureSpanProcessor;
  }

  /**
   * Shutdown handler
   */
  public async shutdown(): Promise<void> {
    await this._batchSpanProcessor.shutdown();
    await this._azureSpanProcessor.shutdown();
    await this._azureExporter.shutdown();
  }
}
