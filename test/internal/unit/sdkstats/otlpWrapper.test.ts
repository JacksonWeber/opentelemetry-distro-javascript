// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExportResult } from "@opentelemetry/core";
import { ExportResultCode } from "@opentelemetry/core";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import type { PushMetricExporter, ResourceMetrics } from "@opentelemetry/sdk-metrics";
import type { LogRecordExporter, ReadableLogRecord } from "@opentelemetry/sdk-logs";

import {
  NetworkStatsLogExporter,
  NetworkStatsMetricExporter,
  NetworkStatsSpanExporter,
} from "../../../../src/sdkstats/otlpWrapper.js";
import {
  EXCEPTION_COUNT_NAME,
  REQUEST_DURATION_NAME,
  REQUEST_FAILURE_NAME,
  REQUEST_SUCCESS_NAME,
  RETRY_COUNT_NAME,
  _resetAllForTest,
  drain,
} from "../../../../src/sdkstats/networkStats.js";

// `shortHost("https://collector.example.com:4318")` strips the first
// path component, so the dimension value the wrappers record is just
// "collector". `endpoint` is the category label ("otlp").
const HOST = "collector";
const ENDPOINT = "otlp";

function setEndpointEnv(): void {
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = `https://collector.example.com:4318`;
}

function clearEndpointEnv(): void {
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  delete process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT;
  delete process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
}

function makeFakeSpanExporter(result: ExportResult): SpanExporter & { exported: number } {
  return {
    exported: 0,
    export(_spans: ReadableSpan[], cb: (r: ExportResult) => void): void {
      this.exported++;
      cb(result);
    },
    shutdown(): Promise<void> {
      return Promise.resolve();
    },
    forceFlush(): Promise<void> {
      return Promise.resolve();
    },
  };
}

describe("sdkstats/otlpWrapper", () => {
  beforeEach(() => {
    _resetAllForTest();
    setEndpointEnv();
  });

  afterEach(() => {
    _resetAllForTest();
    clearEndpointEnv();
  });

  describe("NetworkStatsSpanExporter", () => {
    it("records success on SUCCESS", async () => {
      const inner = makeFakeSpanExporter({ code: ExportResultCode.SUCCESS });
      const wrapper = new NetworkStatsSpanExporter(inner);

      await new Promise<void>((resolve) =>
        wrapper.export([], (result) => {
          expect(result.code).toBe(ExportResultCode.SUCCESS);
          resolve();
        }),
      );
      expect(inner.exported).toBe(1);

      const success = drain(REQUEST_SUCCESS_NAME);
      expect([...success.entries()]).toEqual([[[ENDPOINT, HOST], 1]]);
    });

    it("records an exception on FAILED result with no error, and records duration", async () => {
      const inner = makeFakeSpanExporter({ code: ExportResultCode.FAILED });
      const wrapper = new NetworkStatsSpanExporter(inner);
      await new Promise<void>((resolve) => wrapper.export([], () => resolve()));

      expect(drain(REQUEST_SUCCESS_NAME).size).toBe(0);

      const exceptions = drain(EXCEPTION_COUNT_NAME);
      expect(exceptions.size).toBe(1);
      const [key, count] = [...exceptions.entries()][0];
      expect(key).toEqual([ENDPOINT, HOST, "Client exception"]);
      expect(count).toBe(1);

      // Duration is recorded regardless of outcome.
      expect(drain(REQUEST_DURATION_NAME).size).toBe(1);
    });

    it("records Request_Failure_Count with the HTTP status code when the error carries one", async () => {
      const httpError = Object.assign(new Error("Bad Request"), {
        name: "OTLPExporterError",
        code: 400,
      });
      const inner = makeFakeSpanExporter({ code: ExportResultCode.FAILED, error: httpError });
      const wrapper = new NetworkStatsSpanExporter(inner);
      await new Promise<void>((resolve) => wrapper.export([], () => resolve()));

      expect(drain(REQUEST_SUCCESS_NAME).size).toBe(0);
      expect(drain(EXCEPTION_COUNT_NAME).size).toBe(0);
      const failures = drain(REQUEST_FAILURE_NAME);
      expect([...failures.entries()]).toEqual([[[ENDPOINT, HOST, "400"], 1]]);
    });

    it("records Retry_Count when the HTTP status code is a retryable OTLP code (429/502/503/504)", async () => {
      for (const status of [429, 502, 503, 504]) {
        _resetAllForTest();
        const httpError = Object.assign(new Error(""), {
          name: "OTLPExporterError",
          code: status,
        });
        const inner = makeFakeSpanExporter({
          code: ExportResultCode.FAILED,
          error: httpError,
        });
        const wrapper = new NetworkStatsSpanExporter(inner);
        await new Promise<void>((resolve) => wrapper.export([], () => resolve()));
        const retries = drain(RETRY_COUNT_NAME);
        expect([...retries.entries()]).toEqual([[[ENDPOINT, HOST, String(status)], 1]]);
        expect(drain(REQUEST_FAILURE_NAME).size).toBe(0);
      }
    });

    it("records Retry_Count with statusCode='unknown' when upstream surfaces a synthetic retryable error", async () => {
      const retryableError = Object.assign(new Error("Export failed with retryable status"), {
        name: "OTLPExporterError",
      });
      const inner = makeFakeSpanExporter({
        code: ExportResultCode.FAILED,
        error: retryableError,
      });
      const wrapper = new NetworkStatsSpanExporter(inner);
      await new Promise<void>((resolve) => wrapper.export([], () => resolve()));

      const retries = drain(RETRY_COUNT_NAME);
      expect([...retries.entries()]).toEqual([[[ENDPOINT, HOST, "unknown"], 1]]);
      expect(drain(EXCEPTION_COUNT_NAME).size).toBe(0);
    });

    it("records Exception_Count with a bounded type for timeouts and network errors", async () => {
      const cases: Array<[Error, string]> = [
        [Object.assign(new Error("aborted"), { name: "AbortError" }), "Timeout exception"],
        [Object.assign(new Error("timed out"), { name: "TimeoutError" }), "Timeout exception"],
        [new Error("Request timed out"), "Timeout exception"],
        [new TypeError("fetch failed"), "Network exception"],
        [Object.assign(new Error("conn refused"), { code: "ECONNREFUSED" }), "Network exception"],
        [Object.assign(new Error("dns"), { code: "ENOTFOUND" }), "Network exception"],
      ];

      for (const [err, expected] of cases) {
        _resetAllForTest();
        const inner = makeFakeSpanExporter({ code: ExportResultCode.FAILED, error: err });
        const wrapper = new NetworkStatsSpanExporter(inner);
        await new Promise<void>((resolve) => wrapper.export([], () => resolve()));
        const exc = drain(EXCEPTION_COUNT_NAME);
        expect([...exc.keys()][0]).toEqual([ENDPOINT, HOST, expected]);
      }
    });

    it("ignores non-HTTP numeric codes (e.g. string-coded Node errors)", async () => {
      // Some Node errors expose a string `code` (e.g. 'ECONNRESET'); other
      // errors may expose a numeric code that is not an HTTP status. Both
      // should fall through to Exception_Count rather than be misread as
      // an HTTP failure/retry.
      const weirdError = Object.assign(new Error("not http"), { code: 12345 });
      const inner = makeFakeSpanExporter({ code: ExportResultCode.FAILED, error: weirdError });
      const wrapper = new NetworkStatsSpanExporter(inner);
      await new Promise<void>((resolve) => wrapper.export([], () => resolve()));

      expect(drain(REQUEST_FAILURE_NAME).size).toBe(0);
      expect(drain(RETRY_COUNT_NAME).size).toBe(0);
      const exc = drain(EXCEPTION_COUNT_NAME);
      expect([...exc.keys()][0]).toEqual([ENDPOINT, HOST, "Client exception"]);
    });

    it("records a request duration on SUCCESS", async () => {
      const inner = makeFakeSpanExporter({ code: ExportResultCode.SUCCESS });
      const wrapper = new NetworkStatsSpanExporter(inner);
      await new Promise<void>((resolve) => wrapper.export([], () => resolve()));

      const durations = drain(REQUEST_DURATION_NAME);
      expect(durations.size).toBe(1);
      const [key, avg] = [...durations.entries()][0];
      expect(key).toEqual([ENDPOINT, HOST]);
      expect(avg).toBeGreaterThanOrEqual(0);
    });

    it("forwards forceFlush and shutdown", async () => {
      const inner = makeFakeSpanExporter({ code: ExportResultCode.SUCCESS });
      const flushSpy = vi.spyOn(inner, "forceFlush");
      const shutdownSpy = vi.spyOn(inner, "shutdown");
      const wrapper = new NetworkStatsSpanExporter(inner);
      await wrapper.forceFlush();
      await wrapper.shutdown();
      expect(flushSpy).toHaveBeenCalledOnce();
      expect(shutdownSpy).toHaveBeenCalledOnce();
    });

    it("records exception + duration and surfaces FAILED when inner throws synchronously", async () => {
      const boom = new Error("inner blew up");
      const throwingInner: SpanExporter = {
        export(): void {
          throw boom;
        },
        shutdown: () => Promise.resolve(),
        forceFlush: () => Promise.resolve(),
      };
      const wrapper = new NetworkStatsSpanExporter(throwingInner);

      const result = await new Promise<ExportResult>((resolve) =>
        wrapper.export([], (r) => resolve(r)),
      );
      expect(result.code).toBe(ExportResultCode.FAILED);
      expect(result.error).toBe(boom);

      const exceptions = drain(EXCEPTION_COUNT_NAME);
      expect(exceptions.size).toBe(1);
      expect([...exceptions.keys()][0]).toEqual([ENDPOINT, HOST, "Client exception"]);
      expect(drain(REQUEST_DURATION_NAME).size).toBe(1);
    });
  });

  describe("NetworkStatsMetricExporter", () => {
    function makeMetricExporter(result: ExportResult): PushMetricExporter {
      return {
        export(_m: ResourceMetrics, cb: (r: ExportResult) => void): void {
          cb(result);
        },
        forceFlush(): Promise<void> {
          return Promise.resolve();
        },
        shutdown(): Promise<void> {
          return Promise.resolve();
        },
        selectAggregationTemporality(): 0 {
          return 0;
        },
      };
    }

    it("records success on SUCCESS", async () => {
      const wrapper = new NetworkStatsMetricExporter(
        makeMetricExporter({ code: ExportResultCode.SUCCESS }),
      );
      await new Promise<void>((resolve) => wrapper.export({} as ResourceMetrics, () => resolve()));
      expect([...drain(REQUEST_SUCCESS_NAME).entries()]).toEqual([[[ENDPOINT, HOST], 1]]);
    });

    it("forwards selectAggregationTemporality only when inner provides it", () => {
      const innerWithSelector = makeMetricExporter({ code: ExportResultCode.SUCCESS });
      const wrapperA = new NetworkStatsMetricExporter(innerWithSelector);
      expect(typeof wrapperA.selectAggregationTemporality).toBe("function");

      const innerWithoutSelector: PushMetricExporter = {
        export(_m, cb) {
          cb({ code: ExportResultCode.SUCCESS });
        },
        forceFlush() {
          return Promise.resolve();
        },
        shutdown() {
          return Promise.resolve();
        },
      };
      const wrapperB = new NetworkStatsMetricExporter(innerWithoutSelector);
      expect(wrapperB.selectAggregationTemporality).toBeUndefined();
      expect(wrapperB.selectAggregation).toBeUndefined();
    });
  });

  describe("NetworkStatsLogExporter", () => {
    function makeLogExporter(result: ExportResult): LogRecordExporter {
      return {
        export(_l: ReadableLogRecord[], cb: (r: ExportResult) => void): void {
          cb(result);
        },
        shutdown(): Promise<void> {
          return Promise.resolve();
        },
      };
    }

    it("records success on SUCCESS", async () => {
      const wrapper = new NetworkStatsLogExporter(
        makeLogExporter({ code: ExportResultCode.SUCCESS }),
      );
      await new Promise<void>((resolve) => wrapper.export([], () => resolve()));
      expect([...drain(REQUEST_SUCCESS_NAME).entries()]).toEqual([[[ENDPOINT, HOST], 1]]);
    });

    it("does not record success on FAILED result", async () => {
      const wrapper = new NetworkStatsLogExporter(
        makeLogExporter({ code: ExportResultCode.FAILED }),
      );
      await new Promise<void>((resolve) => wrapper.export([], () => resolve()));
      expect(drain(REQUEST_SUCCESS_NAME).size).toBe(0);
    });
  });

  it("falls back to 'unknown' when no OTLP endpoint env vars are set", () => {
    clearEndpointEnv();
    const wrapper = new NetworkStatsSpanExporter({
      export: (_s, cb) => cb({ code: ExportResultCode.SUCCESS }),
      shutdown: () => Promise.resolve(),
    } as SpanExporter);
    return new Promise<void>((resolve) =>
      wrapper.export([], () => {
        const success = drain(REQUEST_SUCCESS_NAME);
        expect([...success.keys()][0]).toEqual([ENDPOINT, "unknown"]);
        resolve();
      }),
    );
  });
});
