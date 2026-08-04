// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { trace, context, isValidTraceId, isValidSpanId } from "@opentelemetry/api";
import type { LogRecord as APILogRecord } from "@opentelemetry/api-logs";
import { SeverityNumber, logs } from "@opentelemetry/api-logs";
import { ExportResultCode } from "@opentelemetry/core";
import { LoggerProvider } from "@opentelemetry/sdk-logs";
import { LogHandler } from "../../../../src/azureMonitor/logs/index.js";
import { MetricHandler } from "../../../../src/azureMonitor/metrics/index.js";
import { createInstrumentations } from "../../../../src/distro/instrumentations.js";
import { InternalConfig } from "../../../../src/shared/index.js";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { SemanticAttributes } from "@opentelemetry/semantic-conventions";
import type { BunyanInstrumentationConfig } from "@opentelemetry/instrumentation-bunyan";
import type { WinstonInstrumentationConfig } from "@opentelemetry/instrumentation-winston";
import type { MockInstance } from "vitest";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  assert,
} from "vitest";

describe("LogHandler", () => {
  let handler: LogHandler;
  let exportStub: MockInstance<(typeof handler)["_azureExporter"]["export"]>;
  let metricHandler: MetricHandler;
  let originalEnv: NodeJS.ProcessEnv;
  const _config = new InternalConfig();
  if (_config.azureMonitorExporterOptions) {
    _config.azureMonitorExporterOptions.connectionString =
      "InstrumentationKey=1aa11111-bbbb-1ccc-8ddd-eeeeffff3333";
  }

  beforeAll(() => {
    metricHandler = new MetricHandler(_config);
    handler = new LogHandler(_config, metricHandler);
    exportStub = vi.spyOn(handler["_azureExporter"], "export").mockImplementation(
      (_, resultCallback) =>
        new Promise((resolve) => {
          resultCallback({
            code: ExportResultCode.SUCCESS,
          });
          resolve();
        }),
    );
    const loggerProvider: LoggerProvider = new LoggerProvider({
      processors: [handler.getBatchLogRecordProcessor(), handler.getAzureLogRecordProcessor()],
    });
    logs.setGlobalLoggerProvider(loggerProvider);

    const tracerProvider = new NodeTracerProvider();
    tracerProvider.register();
  });

  beforeEach(() => {
    originalEnv = process.env;
  });

  afterEach(() => {
    process.env = originalEnv;
    exportStub.mockClear();
  });

  afterAll(() => {
    logs.disable();
    trace.disable();
  });

  describe("#logger", () => {
    it("export", async () => {
      // Generate exception Log record
      const logRecord: APILogRecord = {
        body: "testLog",
      };
      logs.getLogger("testLogger").emit(logRecord);
      await (logs.getLoggerProvider() as LoggerProvider).forceFlush();
      expect(exportStub).toHaveBeenCalledOnce();
      const args = exportStub.mock.calls[0];
      assert.strictEqual(args[0][0].body, "testLog");
    });

    it("tracing", async () => {
      await trace.getTracer("testTracer").startActiveSpan("test", async () => {
        // Generate Log record
        const logRecord: APILogRecord = {
          attributes: {},
          body: "testRecord",
        };
        logs.getLogger("testLogger").emit(logRecord);
        await (logs.getLoggerProvider() as LoggerProvider).forceFlush();
        expect(exportStub).toHaveBeenCalledOnce();
        const lgs = exportStub.mock.calls[0][0][0];
        const spanContext = trace.getSpanContext(context.active());
        assert.isTrue(isValidTraceId(lgs.spanContext!.traceId), "Valid trace Id");
        assert.isTrue(isValidSpanId(lgs.spanContext!.spanId), "Valid span Id");
        assert.deepStrictEqual(lgs.spanContext!.traceId, spanContext?.traceId);
        assert.deepStrictEqual(lgs.spanContext!.spanId, spanContext?.spanId);
      });
    });

    it("Exception standard metrics processed", async () => {
      // Generate exception Log record
      const logRecord: APILogRecord = {
        attributes: {
          "exception.type": "TestError",
        },
        body: "testErrorRecord",
      };
      logs.getLogger("testLogger").emit(logRecord);
      await (logs.getLoggerProvider() as LoggerProvider).forceFlush();
      expect(exportStub).toHaveBeenCalledOnce();
      const result = exportStub.mock.calls[0];
      assert.strictEqual(
        result[0][0].attributes["_MS.ProcessedByMetricExtractors"],
        "(Name:'Exceptions', Ver:'1.1')",
      );
    });

    it("Trace standard metrics processed", async () => {
      // Generate Log record
      const logRecord: APILogRecord = {
        attributes: {},
        body: "testRecord",
      };
      logs.getLogger("testLogger").emit(logRecord);
      await (logs.getLoggerProvider() as LoggerProvider).forceFlush();
      expect(exportStub).toHaveBeenCalledOnce();
      const result = exportStub.mock.calls[0];
      assert.strictEqual(
        result[0][0].attributes["_MS.ProcessedByMetricExtractors"],
        "(Name:'Traces', Ver:'1.1')",
      );
    });

    it("Trace standard metrics synthetic processed", async () => {
      // Generate Log record
      const logRecord: APILogRecord = {
        attributes: {
          // Shows that the record is synthetic
          [SemanticAttributes.HTTP_USER_AGENT]: "AlwaysOn",
        },
        body: "testRecord",
      };
      logs.getLogger("testLogger").emit(logRecord);
      await (logs.getLoggerProvider() as LoggerProvider).forceFlush();
      expect(exportStub).toHaveBeenCalledOnce();
      const result = exportStub.mock.calls[0];
      assert.strictEqual(
        result[0][0].attributes["_MS.ProcessedByMetricExtractors"],
        "(Name:'Traces', Ver:'1.1')",
      );
      assert.strictEqual(result[0][0].attributes["operation/synthetic"], "True");
    });

    it("should add bunyan instrumentation", () => {
      const config = new InternalConfig();
      config.azureMonitorExporterOptions.connectionString =
        "InstrumentationKey=1aa11111-bbbb-1ccc-8ddd-eeeeffff3333";
      config.instrumentationOptions.bunyan = {
        enabled: true,
      };
      const instrumentations = createInstrumentations(config);
      assert.isDefined(
        instrumentations.find(
          (instrumentation) =>
            instrumentation.instrumentationName === "@opentelemetry/instrumentation-bunyan",
        ),
        "Bunyan instrumentation not added",
      );
    });

    it("should not create a second copy of the bunyan instrumentation", () => {
      const config = new InternalConfig();
      config.azureMonitorExporterOptions.connectionString =
        "InstrumentationKey=1aa11111-bbbb-1ccc-8ddd-eeeeffff3333";
      config.instrumentationOptions.bunyan = {
        enabled: true,
      };
      config.instrumentationOptions.winston = {
        enabled: true,
      };
      config.instrumentationOptions.console = {
        enabled: true,
      };
      // A second enabled BunyanInstrumentation appends another OpenTelemetry
      // stream to every logger, which duplicates every log record. Every
      // instrumentation must therefore be created exactly once.
      const names = createInstrumentations(config).map(
        (instrumentation) => instrumentation.instrumentationName,
      );
      assert.deepStrictEqual(
        names.filter((name, index) => names.indexOf(name) !== index),
        [],
        "createInstrumentations returned duplicate instrumentations",
      );

      // The handler must not hold instrumentations of its own, under any
      // property name — anything it constructs is enabled but never registered.
      const logHandler = new LogHandler(config, metricHandler);
      const held = Object.values(logHandler as unknown as Record<string, unknown>)
        .flatMap((value) => (Array.isArray(value) ? value : [value]))
        .filter(
          (value) => typeof value === "object" && value !== null && "instrumentationName" in value,
        );
      assert.deepStrictEqual(held, [], "LogHandler must not create instrumentations");
    });

    it("should add winston instrumentation", () => {
      const config = new InternalConfig();
      config.azureMonitorExporterOptions.connectionString =
        "InstrumentationKey=1aa11111-bbbb-1ccc-8ddd-eeeeffff3333";
      config.instrumentationOptions.winston = {
        enabled: true,
      };
      const instrumentations = createInstrumentations(config);
      assert.isDefined(
        instrumentations.find(
          (instrumentation) =>
            instrumentation.instrumentationName === "@opentelemetry/instrumentation-winston",
        ),
        "Winston instrumentation not added",
      );
    });

    it("should set bunyan log level with the APPLICATIONINSIGHTS_INSTRUMENTATION_LOGGING_LEVEL env var", () => {
      process.env.APPLICATIONINSIGHTS_INSTRUMENTATION_LOGGING_LEVEL = "DEBUG";
      const config = new InternalConfig();
      config.azureMonitorExporterOptions.connectionString =
        "InstrumentationKey=1aa11111-bbbb-1ccc-8ddd-eeeeffff3333";
      config.instrumentationOptions.bunyan = {
        enabled: true,
      };
      const bunyanInstrumentation = createInstrumentations(config).find(
        (instrumentation) =>
          instrumentation.instrumentationName === "@opentelemetry/instrumentation-bunyan",
      );
      assert.strictEqual(
        (bunyanInstrumentation!.getConfig() as BunyanInstrumentationConfig).logSeverity,
        SeverityNumber.DEBUG,
      );
    });

    it("should set winston log level with the APPLICATIONINSIGHTS_INSTRUMENTATION_LOGGING_LEVEL env var", () => {
      process.env.APPLICATIONINSIGHTS_INSTRUMENTATION_LOGGING_LEVEL = "ERROR";
      const config = new InternalConfig();
      config.azureMonitorExporterOptions.connectionString =
        "InstrumentationKey=1aa11111-bbbb-1ccc-8ddd-eeeeffff3333";
      config.instrumentationOptions.winston = {
        enabled: true,
      };
      const winstonInstrumentation = createInstrumentations(config).find(
        (instrumentation) =>
          instrumentation.instrumentationName === "@opentelemetry/instrumentation-winston",
      );
      assert.strictEqual(
        (winstonInstrumentation!.getConfig() as WinstonInstrumentationConfig).logSeverity,
        SeverityNumber.ERROR,
      );
    });
  });
});
