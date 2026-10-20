// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AzureMonitorLogExporter } from "@azure/monitor-opentelemetry-exporter";
import type { AzureMonitorExporterOptions } from "@azure/monitor-opentelemetry-exporter";
import {
  createDefaultHttpClient,
  createEmptyPipeline,
  createHttpHeaders,
  RestError,
} from "@azure/core-rest-pipeline";
import type { HttpClient, PipelineRequest, PipelineResponse } from "@azure/core-rest-pipeline";
import type { ExportResult } from "@opentelemetry/core";
import { ExportResultCode } from "@opentelemetry/core";
import { createServer } from "node:http";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { azureVmDetector } from "@opentelemetry/resource-detector-azure";
import { createAzureMonitorHttpClient } from "../../../src/azureMonitor/utils/httpClient.js";
import { InternalConfig } from "../../../src/shared/config.js";
import { StandardMetrics } from "../../../src/azureMonitor/metrics/standardMetrics.js";
import { PerformanceCounterMetrics } from "../../../src/azureMonitor/metrics/performanceCounters.js";
import {
  createMockSdkLogRecord,
  parseBreezeRequest,
  partialBreezeResponse,
  successfulBreezeResponse,
} from "../../utils/breezeTestUtils.js";

const connectionString = "InstrumentationKey=1aa11111-bbbb-1ccc-8ddd-eeeeffff3333";
const ingestionUrl = "https://dc.services.visualstudio.com/v2.1/track";

// The upstream exporter has no public replay trigger. Exercise its actual persister
// and replay path without waiting for randomized background timers.
interface ReplaySender {
  cancelStorageTimers(): void;
  sendFirstPersistedFile(): Promise<void>;
  persister: { _tempDirectory: string };
}

function getSender(exporter: AzureMonitorLogExporter): ReplaySender {
  return Reflect.get(exporter, "_sender") as ReplaySender;
}

function response(
  request: PipelineRequest,
  status = 200,
  body: unknown = successfulBreezeResponse(1),
  headers: Record<string, string> = {},
): PipelineResponse {
  return {
    request,
    headers: createHttpHeaders({ "content-type": "application/json", ...headers }),
    status,
    bodyAsText: JSON.stringify(body),
  };
}

function exportLogs(exporter: AzureMonitorLogExporter, messages = ["hello \u00e9 \ud83c\udf0d"]) {
  return new Promise<ExportResult>((resolve) => {
    void exporter.export(
      messages.map((body) => createMockSdkLogRecord(undefined, undefined, { body })),
      resolve,
    );
  });
}

describe("Azure Monitor compressed delivery", () => {
  const exporters: AzureMonitorLogExporter[] = [];
  const directories: string[] = [];

  function createExporter(httpClient: HttpClient, options: AzureMonitorExporterOptions = {}) {
    const exporter = new AzureMonitorLogExporter({
      connectionString,
      disableOfflineStorage: true,
      retryOptions: { maxRetries: 0 },
      ...options,
      httpClient: createAzureMonitorHttpClient(httpClient),
    });
    getSender(exporter).cancelStorageTimers();
    exporters.push(exporter);
    return exporter;
  }

  beforeEach(() => {
    vi.stubEnv("APPLICATION_INSIGHTS_NO_STATSBEAT", "true");
    vi.stubEnv("APPLICATIONINSIGHTS_SDKSTATS_DISABLED", "true");
  });

  afterEach(async () => {
    await Promise.all(exporters.splice(0).map((exporter) => exporter.shutdown()));
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each([StandardMetrics, PerformanceCounterMetrics])(
    "compresses %s through the shared distro configuration",
    async (Collector) => {
      vi.spyOn(azureVmDetector, "detect").mockReturnValue({ attributes: {} });
      const requests: PipelineRequest[] = [];
      const config = new InternalConfig({
        azureMonitor: {
          azureMonitorExporterOptions: {
            connectionString,
            disableOfflineStorage: true,
            httpClient: {
              async sendRequest(request) {
                requests.push(request);
                return response(request);
              },
            },
          },
        },
      });
      const provider = new Collector(config).getMeterProvider();
      try {
        provider.getMeter("gzip-test").createCounter("gzip-test-counter").add(1);
        await provider.forceFlush();
        expect(requests.length).toBeGreaterThan(0);
        for (const request of requests) {
          expect(request.headers.get("content-encoding")).toBe("gzip");
          expect(parseBreezeRequest(request).length).toBeGreaterThan(0);
        }
      } finally {
        await provider.shutdown();
      }
    },
  );

  it.each([
    { connectionString: `${connectionString};IngestionEndpoint=https://collector.example.com` },
    { endpoint: "https://collector.example.com/v2.1" },
  ])("preserves JSON for a custom endpoint override: %j", async (options) => {
    const requests: PipelineRequest[] = [];
    const exporter = createExporter(
      {
        async sendRequest(request) {
          requests.push(request);
          return response(request);
        },
      },
      options,
    );
    expect((await exportLogs(exporter)).code).toBe(ExportResultCode.SUCCESS);
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("https://collector.example.com/v2.1/track");
    expect(requests[0].headers.has("content-encoding")).toBe(false);
    expect(parseBreezeRequest(requests[0])).toHaveLength(1);
  });

  it("compresses when the connection string comes from the environment", async () => {
    vi.stubEnv(
      "APPLICATIONINSIGHTS_CONNECTION_STRING",
      `${connectionString};IngestionEndpoint=https://westus-0.in.applicationinsights.azure.com`,
    );
    const requests: PipelineRequest[] = [];
    const exporter = createExporter(
      {
        async sendRequest(request) {
          requests.push(request);
          return response(request);
        },
      },
      { connectionString: undefined },
    );
    expect((await exportLogs(exporter)).code).toBe(ExportResultCode.SUCCESS);
    expect(requests).toHaveLength(1);
    expect(requests[0].headers.get("content-encoding")).toBe("gzip");
    expect(parseBreezeRequest(requests[0])).toHaveLength(1);
  });

  it("honors custom pipeline destination changes before deciding to compress", async () => {
    const pipeline = createEmptyPipeline();
    pipeline.addPolicy({
      name: "customEndpoint",
      async sendRequest(request, next) {
        request.url = "https://proxy.example.com/v2.1/track";
        request.headers.set("x-custom-policy", "preserved");
        return next(request);
      },
    });
    const sendRequest = vi.fn(async (request: PipelineRequest) => response(request));
    const exporter = createExporter({ sendRequest }, { pipeline });
    expect((await exportLogs(exporter)).code).toBe(ExportResultCode.SUCCESS);
    const sent = sendRequest.mock.calls[0][0];
    expect(sent.url).toBe("https://proxy.example.com/v2.1/track");
    expect(sent.headers.get("x-custom-policy")).toBe("preserved");
    expect(sent.headers.has("content-encoding")).toBe(false);
    expect(parseBreezeRequest(sent)).toHaveLength(1);
  });

  it("preserves the original JSON for user policies on every pipeline retry", async () => {
    const requests: PipelineRequest[] = [];
    const policyBodies: unknown[] = [];
    const exporter = createExporter(
      {
        async sendRequest(request) {
          requests.push(request);
          return response(request, requests.length === 1 ? 503 : 200);
        },
      },
      {
        retryOptions: { maxRetries: 1, retryDelayInMs: 1, maxRetryDelayInMs: 1 },
        additionalPolicies: [
          {
            position: "perRetry",
            policy: {
              name: "inspectBody",
              async sendRequest(request, next) {
                policyBodies.push(request.body);
                return next(request);
              },
            },
          },
        ],
      },
    );
    expect((await exportLogs(exporter)).code).toBe(ExportResultCode.SUCCESS);
    expect(requests).toHaveLength(2);
    expect(policyBodies).toHaveLength(2);
    expect(typeof policyBodies[0]).toBe("string");
    expect(policyBodies[1]).toBe(policyBodies[0]);
    expect(parseBreezeRequest(requests[1])).toEqual(parseBreezeRequest(requests[0]));
    expect(requests.every((request) => request.headers.get("content-encoding") === "gzip")).toBe(
      true,
    );
  });

  it.each([307, 308])("compresses again after an accepted %s redirect", async (status) => {
    const requests: PipelineRequest[] = [];
    const target = "https://westus-0.in.applicationinsights.azure.com/v2.1/track";
    const exporter = createExporter({
      async sendRequest(request) {
        requests.push(request);
        return requests.length === 1
          ? response(request, status, {}, { location: target })
          : response(request);
      },
    });
    expect((await exportLogs(exporter)).code).toBe(ExportResultCode.SUCCESS);
    expect(requests.map((request) => request.url)).toEqual([ingestionUrl, target]);
    expect(requests.every((request) => request.headers.get("content-encoding") === "gzip")).toBe(
      true,
    );
    expect(parseBreezeRequest(requests[1])).toEqual(parseBreezeRequest(requests[0]));
  });

  it.each(["partial", "unavailable", "transport"] as const)(
    "persists JSON after %s failure and compresses only the replayed envelopes after restart",
    async (failure) => {
      const directory = await mkdtemp(join(process.cwd(), ".gzip-replay-"));
      directories.push(directory);
      const requests: PipelineRequest[] = [];
      let failing = true;
      const httpClient: HttpClient = {
        async sendRequest(request) {
          requests.push(request);
          if (failing && failure === "transport") {
            throw new RestError("Connection reset", { code: "ECONNRESET" });
          }
          if (failing) {
            return failure === "partial"
              ? response(request, 206, partialBreezeResponse([200, 503, 400]))
              : response(request, 503);
          }
          return response(
            request,
            200,
            successfulBreezeResponse(parseBreezeRequest(request).length),
          );
        },
      };
      const options = { storageDirectory: directory, disableOfflineStorage: false };
      const exporter = createExporter(httpClient, options);
      expect((await exportLogs(exporter, ["accepted", "retry", "rejected"])).code).toBe(
        ExportResultCode.SUCCESS,
      );
      getSender(exporter).cancelStorageTimers();
      await exporter.shutdown();

      const storedDirectory = getSender(exporter).persister._tempDirectory;
      const files = await readdir(storedDirectory);
      expect(files).toHaveLength(1);
      const stored: {
        instrumentationKey: string;
        data: { baseData: { message: string } };
      }[] = JSON.parse(await readFile(join(storedDirectory, files[0]), "utf8"));
      const original = parseBreezeRequest(requests[0]);
      expect(stored.map((envelope) => envelope.data.baseData.message)).toEqual(
        failure === "partial" ? ["retry"] : ["accepted", "retry", "rejected"],
      );
      expect(
        stored.every(
          (envelope) => envelope.instrumentationKey === "1aa11111-bbbb-1ccc-8ddd-eeeeffff3333",
        ),
      ).toBe(true);

      failing = false;
      const restarted = createExporter(httpClient, options);
      await getSender(restarted).sendFirstPersistedFile();
      expect(requests).toHaveLength(2);
      expect(requests[1].headers.get("content-encoding")).toBe("gzip");
      expect(parseBreezeRequest(requests[1])).toEqual(
        failure === "partial" ? [original[1]] : original,
      );
      expect(await readdir(storedDirectory)).toHaveLength(0);
    },
  );

  it("delivers binary gzip through the real Node HTTP client with the correct length", async () => {
    const received: { body: Buffer; encoding?: string; length?: string; contentType?: string }[] =
      [];
    const server = createServer((request, result) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        received.push({
          body: Buffer.concat(chunks),
          encoding: request.headers["content-encoding"],
          length: request.headers["content-length"],
          contentType: request.headers["content-type"],
        });
        result.writeHead(200, { "content-type": "application/json" });
        result.end(JSON.stringify(successfulBreezeResponse(1)));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected a listening server");
      const transport = createDefaultHttpClient();
      const exporter = createExporter({
        sendRequest(request) {
          // Route the already-compressed bytes to a loopback receiver, never to Azure.
          return transport.sendRequest({
            ...request,
            url: `http://127.0.0.1:${address.port}/v2.1/track`,
            allowInsecureConnection: true,
          });
        },
      });
      expect((await exportLogs(exporter)).code).toBe(ExportResultCode.SUCCESS);
      expect(received).toHaveLength(1);
      expect(received[0].encoding).toBe("gzip");
      expect(received[0].length).toBe(String(received[0].body.byteLength));
      expect(received[0].contentType).toBe("application/json");
      const envelopes = JSON.parse(gunzipSync(received[0].body).toString("utf8"));
      expect(envelopes[0].data.baseData.message).toBe("hello \u00e9 \ud83c\udf0d");
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
