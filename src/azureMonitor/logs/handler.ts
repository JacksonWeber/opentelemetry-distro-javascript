// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { AzureMonitorLogExporter } from "@azure/monitor-opentelemetry-exporter";
import type { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import type { InternalConfig } from "../../shared/config.js";
import type { MetricHandler } from "../metrics/handler.js";
import { AzureLogRecordProcessor } from "./logRecordProcessor.js";
import { AzureBatchLogRecordProcessor } from "./batchLogRecordProcessor.js";

/**
 * Azure Monitor OpenTelemetry Log Handler
 */
export class LogHandler {
  private _azureExporter: AzureMonitorLogExporter;
  private _azureLogRecordProcessor: AzureLogRecordProcessor;
  private _azureBatchLogRecordProcessor: AzureBatchLogRecordProcessor;
  private _metricHandler: MetricHandler;
  private _config: InternalConfig;

  /**
   * Initializes a new instance of the LogHandler class.
   *
   * Log instrumentations are not created here — they are created once by
   * `createInstrumentations` and registered with the NodeSDK. Creating them
   * here as well left a second, enabled copy of each instrumentation that the
   * SDK never wired up. For bunyan that is actively harmful: its instrumentation
   * appends an `OpenTelemetryBunyanStream` every time it is enabled and never
   * unwraps a previous patch, so every record was emitted twice.
   *
   * @param config - Microsoft OpenTelemetry configuration.
   * @param metricHandler - MetricHandler.
   */
  constructor(config: InternalConfig, metricHandler: MetricHandler) {
    this._config = config;
    this._metricHandler = metricHandler;
    this._azureExporter = new AzureMonitorLogExporter(config.azureMonitorExporterOptions);
    this._azureBatchLogRecordProcessor = new AzureBatchLogRecordProcessor(this._azureExporter, {
      enableTraceBasedSamplingForLogs: this._config.enableTraceBasedSamplingForLogs,
    });
    this._azureLogRecordProcessor = new AzureLogRecordProcessor(this._metricHandler);
  }

  public getAzureLogRecordProcessor(): AzureLogRecordProcessor {
    return this._azureLogRecordProcessor;
  }

  public getBatchLogRecordProcessor(): BatchLogRecordProcessor {
    return this._azureBatchLogRecordProcessor;
  }
}
