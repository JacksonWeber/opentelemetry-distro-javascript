// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { test } from "node:test";

const CHILD_SCRIPT = `
  import { trace } from "@opentelemetry/api";
  import {
    shutdownMicrosoftOpenTelemetry,
    useMicrosoftOpenTelemetry,
  } from "./dist/esm/index.js";

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
    samplingRatio: 1,
    tracesPerSecond: 0,
  });

  const span = trace.getTracer("built-package-integration").startSpan("built-package-span");
  span.setAttribute("integration.signal", "trace");
  span.end();

  await shutdownMicrosoftOpenTelemetry();
`;

function runBuiltPackage(endpoint) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", CHILD_SCRIPT], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MICROSOFT_OTEL_SDKSTATS_DISABLED: "true",
        OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
        OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
        OTEL_EXPORTER_OTLP_TIMEOUT: "2000",
        OTEL_SERVICE_NAME: "built-package-integration",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `Built package process exited with code ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
        ),
      );
    });
  });
}

test("built package exports a span to an OTLP HTTP collector", async (t) => {
  const requests = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({
        body: Buffer.concat(chunks),
        method: request.method,
        url: request.url,
      });
      response.writeHead(200, { "content-type": "application/x-protobuf" });
      response.end();
    });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.close();
    await once(server, "close");
  });

  const address = server.address();
  assert(address && typeof address === "object");

  await runBuiltPackage(`http://127.0.0.1:${address.port}`);

  const traceRequest = requests.find((request) => request.url === "/v1/traces");
  assert(traceRequest, "expected an OTLP trace request");
  assert.equal(traceRequest.method, "POST");
  assert(traceRequest.body.length > 0, "expected a non-empty OTLP payload");
  assert(
    traceRequest.body.includes(Buffer.from("built-package-span")),
    "expected the exported payload to contain the integration span",
  );
});
