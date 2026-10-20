// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { HttpClient } from "@azure/core-rest-pipeline";
import { createDefaultHttpClient, createHttpHeaders } from "@azure/core-rest-pipeline";
import { promisify } from "node:util";
import { gzip } from "node:zlib";

const gzipAsync = promisify(gzip);
const ingestionDomainSuffixes = [
  ".applicationinsights.azure.com",
  ".applicationinsights.azure.us",
  ".applicationinsights.azure.cn",
  ".monitor.azure.com",
  ".monitor.azure.us",
  ".monitor.azure.cn",
];

/**
 * Compress serialized telemetry at the transport boundary, after pipeline policies.
 * @internal
 */
export function createAzureMonitorHttpClient(
  httpClient: HttpClient = createDefaultHttpClient(),
): HttpClient {
  return {
    async sendRequest(request) {
      if (
        request.method !== "POST" ||
        typeof request.body !== "string" ||
        !request.body ||
        request.headers.has("content-encoding")
      ) {
        return httpClient.sendRequest(request);
      }

      const url = new URL(request.url);
      const isIngestionEndpoint =
        url.protocol === "https:" &&
        /^\/v2(?:\.1)?\/track\/?$/i.test(url.pathname) &&
        (url.hostname === "dc.services.visualstudio.com" ||
          ingestionDomainSuffixes.some((suffix) => url.hostname.endsWith(suffix)));
      if (!isIngestionEndpoint) {
        return httpClient.sendRequest(request);
      }

      const body = await gzipAsync(request.body);
      const headers = createHttpHeaders(request.headers.toJSON());
      headers.set("content-encoding", "gzip");
      headers.set("content-length", String(body.byteLength));

      // Keep the original request intact for retries, redirects, and user policies.
      return httpClient.sendRequest({ ...request, body, headers });
    },
  };
}
