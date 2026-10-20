// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, describe, expect, it, vi } from "vitest";
import { createHttpHeaders, createPipelineRequest } from "@azure/core-rest-pipeline";
import type { PipelineRequest } from "@azure/core-rest-pipeline";
import { gunzipSync, gzip } from "node:zlib";
import { Readable } from "node:stream";
import { createAzureMonitorHttpClient } from "../../../../src/azureMonitor/utils/httpClient.js";

vi.mock("node:zlib", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:zlib")>();
  return { ...actual, gzip: vi.fn(actual.gzip) };
});

const ingestionUrl = "https://dc.services.visualstudio.com/v2.1/track";
const body = JSON.stringify([{ name: "test", message: "unicode \u00e9 \ud83c\udf0d".repeat(50) }]);

function createRequest(url = ingestionUrl): PipelineRequest {
  return createPipelineRequest({
    url,
    method: "POST",
    body,
    headers: createHttpHeaders({
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(body)),
      authorization: "Bearer test-token",
    }),
  });
}

function createClient() {
  const sendRequest = vi.fn(async (request: PipelineRequest) => ({
    request,
    headers: createHttpHeaders(),
    status: 200,
    bodyAsText: "{}",
  }));
  return { sendRequest, client: createAzureMonitorHttpClient({ sendRequest }) };
}

describe("Azure Monitor gzip HTTP client", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ingestionUrl,
    "https://DC.SERVICES.VISUALSTUDIO.COM/v2/track",
    "https://dc.applicationinsights.azure.com/v2.1/track",
    "https://westus-0.in.applicationinsights.azure.com/v2.1/track",
    "https://dc.applicationinsights.azure.us/v2.1/track",
    "https://chinanorth-0.in.applicationinsights.azure.cn/v2.1/track",
    "https://eastus.livediagnostics.monitor.azure.com/v2.1/track",
    "https://westus.monitor.azure.us/v2.1/track",
    "https://chinanorth.monitor.azure.cn/v2.1/track?test=true",
  ])("compresses telemetry for %s without mutating the pipeline request", async (url) => {
    const { client, sendRequest } = createClient();
    const request = createRequest(url);
    const response = await client.sendRequest(request);
    const sent = sendRequest.mock.calls[0][0];

    expect(Buffer.isBuffer(sent.body)).toBe(true);
    if (!Buffer.isBuffer(sent.body)) throw new Error("Expected binary body");
    expect(gunzipSync(sent.body).toString("utf8")).toBe(body);
    expect(sent.body.byteLength).toBeLessThan(Buffer.byteLength(body));
    expect(sent.headers.get("content-encoding")).toBe("gzip");
    expect(sent.headers.get("content-length")).toBe(String(sent.body.byteLength));
    expect(sent.headers.get("content-type")).toBe("application/json");
    expect(sent.headers.get("authorization")).toBe("Bearer test-token");
    expect(sent.url).toBe(url);
    expect(response).toBe(await sendRequest.mock.results[0].value);
    expect(request.body).toBe(body);
    expect(request.headers.has("content-encoding")).toBe(false);
    expect(request.headers.get("content-length")).toBe(String(Buffer.byteLength(body)));
  });

  it.each([
    "https://collector.example.com/v2.1/track",
    "http://localhost:4318/v2.1/track",
    "http://dc.services.visualstudio.com/v2.1/track",
    "https://dc.services.visualstudio.com.example.com/v2.1/track",
    "https://notapplicationinsights.azure.com/v2.1/track",
    "https://westus.applicationinsights.azure.com.example.com/v2.1/track",
    "https://rt.services.visualstudio.com/QuickPulseService.svc/post",
    "https://westus.monitor.azure.com/v1/logs",
    "https://collector.example.com/v2.1/track?host=dc.services.visualstudio.com",
  ])("preserves plain JSON for %s", async (url) => {
    const { client, sendRequest } = createClient();
    const request = createRequest(url);
    await client.sendRequest(request);
    expect(sendRequest).toHaveBeenCalledWith(request);
    expect(sendRequest.mock.calls[0][0]).toBe(request);
    expect(gzip).not.toHaveBeenCalled();
  });

  it("does not double-encode an already encoded request, including nested wrappers", async () => {
    const { client, sendRequest } = createClient();
    await createAzureMonitorHttpClient(client).sendRequest(createRequest());
    expect(gzip).toHaveBeenCalledTimes(1);
    const sent = sendRequest.mock.calls[0][0];
    if (!Buffer.isBuffer(sent.body)) throw new Error("Expected binary body");
    expect(gunzipSync(sent.body).toString("utf8")).toBe(body);

    const request = createRequest();
    request.headers.set("content-encoding", "br");
    await client.sendRequest(request);
    expect(sendRequest.mock.calls[1][0]).toBe(request);
    expect(gzip).toHaveBeenCalledTimes(1);
  });

  it("preserves empty, binary, streaming, and non-POST requests", async () => {
    const { client, sendRequest } = createClient();
    for (const value of [
      undefined,
      "",
      Buffer.from(body),
      Readable.from([body]),
      () => Readable.from([body]),
    ]) {
      const request = createRequest();
      request.body = value;
      await client.sendRequest(request);
      expect(sendRequest.mock.lastCall?.[0]).toBe(request);
    }
    const request = createRequest();
    request.method = "GET";
    await client.sendRequest(request);
    expect(sendRequest.mock.lastCall?.[0]).toBe(request);
    expect(gzip).not.toHaveBeenCalled();
  });

  it("re-evaluates the destination when a request is retried", async () => {
    const { client, sendRequest } = createClient();
    const request = createRequest();
    await client.sendRequest(request);
    await client.sendRequest(request);
    request.url = "https://custom.example.com/v2.1/track";
    await client.sendRequest(request);
    for (const [sent] of sendRequest.mock.calls.slice(0, 2)) {
      if (!Buffer.isBuffer(sent.body)) throw new Error("Expected binary body");
      expect(gunzipSync(sent.body).toString("utf8")).toBe(body);
    }
    expect(sendRequest.mock.calls[2][0].body).toBe(body);
    expect(sendRequest.mock.calls[2][0].headers.has("content-encoding")).toBe(false);
  });

  it("propagates compression failures without sending or modifying the request", async () => {
    const error = new Error("gzip failed");
    vi.mocked(gzip).mockImplementationOnce((...args: Parameters<typeof gzip>) => {
      const callback = args[args.length - 1];
      if (typeof callback !== "function") throw new Error("Expected gzip callback");
      callback(error, Buffer.alloc(0));
    });
    const { client, sendRequest } = createClient();
    const request = createRequest();
    await expect(client.sendRequest(request)).rejects.toBe(error);
    expect(sendRequest).not.toHaveBeenCalled();
    expect(request.body).toBe(body);
    expect(request.headers.has("content-encoding")).toBe(false);
  });

  it("propagates transport failures unchanged", async () => {
    const error = new Error("connection failed");
    const sendRequest = vi.fn().mockRejectedValue(error);
    await expect(
      createAzureMonitorHttpClient({ sendRequest }).sendRequest(createRequest()),
    ).rejects.toBe(error);
  });
});
