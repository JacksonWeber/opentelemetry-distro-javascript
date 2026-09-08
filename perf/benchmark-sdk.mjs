// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export async function startBenchmarkSdk(packageRoot) {
  const requireFromPackage = createRequire(join(packageRoot, "package.json"));
  const { metrics, trace } = requireFromPackage("@opentelemetry/api");
  const { logs } = requireFromPackage("@opentelemetry/api-logs");
  const { MetricReader } = requireFromPackage("@opentelemetry/sdk-metrics");
  const distroEntryPoint = pathToFileURL(join(packageRoot, "dist", "esm", "index.js")).href;

  process.env.MICROSOFT_OTEL_SDKSTATS_DISABLED = "true";

  class NonExportingMetricReader extends MetricReader {
    onForceFlush() {
      return Promise.resolve();
    }

    onShutdown() {
      return Promise.resolve();
    }
  }

  const logRecordProcessor = {
    enabled: () => true,
    forceFlush: () => Promise.resolve(),
    onEmit: () => {},
    shutdown: () => Promise.resolve(),
  };
  const spanProcessor = {
    forceFlush: () => Promise.resolve(),
    onEnd: () => {},
    onStart: () => {},
    shutdown: () => Promise.resolve(),
  };
  const { shutdownMicrosoftOpenTelemetry, useMicrosoftOpenTelemetry } = await import(
    distroEntryPoint
  );

  useMicrosoftOpenTelemetry({
    azureMonitor: { enabled: false },
    enableConsoleExporters: false,
    instrumentationOptions: {
      azureSdk: { enabled: false },
      bunyan: { enabled: false },
      console: { enabled: false },
      http: { enabled: false },
      langchain: { enabled: false },
      mongoDb: { enabled: false },
      mySql: { enabled: false },
      openaiAgents: { enabled: false },
      postgreSql: { enabled: false },
      redis: { enabled: false },
      redis4: { enabled: false },
      winston: { enabled: false },
    },
    logRecordProcessors: [logRecordProcessor],
    metricReaders: [new NonExportingMetricReader()],
    samplingRatio: 1,
    spanProcessors: [spanProcessor],
    tracesPerSecond: 0,
  });

  const tracer = trace.getTracer("performance-test");
  const probeSpan = tracer.startSpan("benchmark-probe");
  if (!probeSpan.isRecording()) {
    throw new Error(`Benchmark tracer for ${packageRoot} is not backed by a recording provider`);
  }
  probeSpan.end();

  const counter = metrics.getMeter("performance-test").createCounter("benchmark-counter");
  const logger = logs.getLogger("performance-test");
  const scenarios = [
    {
      category: "span",
      name: "span",
      test: "span_creation",
      operation: () => {
        tracer.startSpan("benchmark-span").end();
      },
    },
    {
      category: "span",
      name: "span_with_attribute",
      test: "span_creation_with_attribute",
      operation: () => {
        const span = tracer.startSpan("benchmark-span");
        span.setAttribute("benchmark.attribute", 1);
        span.end();
      },
    },
    {
      category: "metric",
      name: "counter_add",
      test: "metric_counter_add",
      operation: () => {
        counter.add(1);
      },
    },
    {
      category: "log",
      name: "logger_emit",
      test: "log_emit",
      operation: () => {
        logger.emit({ body: "benchmark-log" });
      },
    },
  ];

  return {
    scenarios,
    shutdown: shutdownMicrosoftOpenTelemetry,
  };
}
