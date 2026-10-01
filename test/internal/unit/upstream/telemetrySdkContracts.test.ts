// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  context,
  defaultTextMapGetter,
  defaultTextMapSetter,
  SpanKind,
  SpanStatusCode,
  trace,
  TraceFlags,
} from "@opentelemetry/api";
import { SeverityNumber } from "@opentelemetry/api-logs";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { describe, expect, it } from "vitest";

describe("OpenTelemetry SDK contracts used by the distro", () => {
  it("exports completed spans with attributes, events, links, status, and exceptions", async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    const tracer = provider.getTracer("upstream-contracts", "1.0.0");
    const linkedContext = {
      traceId: "0123456789abcdef0123456789abcdef",
      spanId: "0123456789abcdef",
      traceFlags: TraceFlags.SAMPLED,
      isRemote: true,
    };

    const span = tracer.startSpan("dependency-operation", {
      attributes: { component: "contract-test" },
      kind: SpanKind.CLIENT,
      links: [{ context: linkedContext, attributes: { relationship: "dependency" } }],
    });
    span.addEvent("request.sent", { attempt: 1 });
    span.recordException(new Error("expected failure"));
    span.setStatus({ code: SpanStatusCode.ERROR, message: "failed" });
    span.end();
    await provider.forceFlush();

    const [exported] = exporter.getFinishedSpans();
    expect(exported).toMatchObject({
      attributes: { component: "contract-test" },
      kind: SpanKind.CLIENT,
      name: "dependency-operation",
      status: { code: SpanStatusCode.ERROR, message: "failed" },
    });
    expect(exported.instrumentationScope).toMatchObject({
      name: "upstream-contracts",
      version: "1.0.0",
    });
    expect(exported.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "request.sent", attributes: { attempt: 1 } }),
        expect.objectContaining({
          name: "exception",
          attributes: expect.objectContaining({
            "exception.message": "expected failure",
            "exception.type": "Error",
          }),
        }),
      ]),
    );
    expect(exported.links).toEqual([
      {
        context: linkedContext,
        attributes: { relationship: "dependency" },
      },
    ]);

    await provider.shutdown();
  });

  it("collects counter and histogram measurements with attributes", async () => {
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const reader = new PeriodicExportingMetricReader({
      exporter,
      exportIntervalMillis: 60_000,
    });
    const provider = new MeterProvider({ readers: [reader] });
    const meter = provider.getMeter("upstream-contracts", "1.0.0");
    const counter = meter.createCounter("requests", { unit: "{request}" });
    const histogram = meter.createHistogram("request.duration", { unit: "ms" });

    counter.add(2, { route: "/orders" });
    histogram.record(125, { route: "/orders" });
    await provider.forceFlush();

    const metrics = exporter
      .getMetrics()
      .flatMap((resourceMetrics) => resourceMetrics.scopeMetrics)
      .flatMap((scopeMetrics) => scopeMetrics.metrics);
    expect(metrics.map((metric) => metric.descriptor.name)).toEqual(
      expect.arrayContaining(["requests", "request.duration"]),
    );
    for (const metric of metrics) {
      expect(metric.dataPoints).toEqual([
        expect.objectContaining({ attributes: { route: "/orders" } }),
      ]);
    }

    await provider.shutdown();
  });

  it("exports structured log records with severity, body, and attributes", async () => {
    const exporter = new InMemoryLogRecordExporter();
    const provider = new LoggerProvider({
      processors: [new SimpleLogRecordProcessor({ exporter })],
    });
    const logger = provider.getLogger("upstream-contracts", "1.0.0");

    logger.emit({
      attributes: { component: "checkout" },
      body: { orderId: "order-42" },
      severityNumber: SeverityNumber.INFO,
      severityText: "INFO",
    });
    await provider.forceFlush();

    expect(exporter.getFinishedLogRecords()).toEqual([
      expect.objectContaining({
        attributes: { component: "checkout" },
        body: { orderId: "order-42" },
        instrumentationScope: expect.objectContaining({
          name: "upstream-contracts",
          version: "1.0.0",
        }),
        severityNumber: SeverityNumber.INFO,
        severityText: "INFO",
      }),
    ]);

    await provider.shutdown();
  });

  it("round-trips sampled W3C trace context through text-map propagation", () => {
    const propagator = new W3CTraceContextPropagator();
    const spanContext = {
      traceId: "0123456789abcdef0123456789abcdef",
      spanId: "0123456789abcdef",
      traceFlags: TraceFlags.SAMPLED,
    };
    const carrier: Record<string, string> = {};
    const sourceContext = trace.setSpanContext(context.active(), spanContext);

    propagator.inject(sourceContext, carrier, defaultTextMapSetter);
    const extractedContext = propagator.extract(context.active(), carrier, defaultTextMapGetter);

    expect(carrier).toEqual({
      traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
    });
    expect(trace.getSpanContext(extractedContext)).toEqual({
      ...spanContext,
      isRemote: true,
    });
  });

  it.each([
    "",
    "not-a-traceparent",
    "00-00000000000000000000000000000000-0123456789abcdef-01",
    "00-0123456789abcdef0123456789abcdef-0000000000000000-01",
  ])("rejects invalid W3C traceparent value %j", (traceparent) => {
    const propagator = new W3CTraceContextPropagator();
    const extractedContext = propagator.extract(
      context.active(),
      { traceparent },
      defaultTextMapGetter,
    );

    expect(trace.getSpanContext(extractedContext)).toBeUndefined();
  });
});
