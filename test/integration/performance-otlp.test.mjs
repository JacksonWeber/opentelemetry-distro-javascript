// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const EXPECTED_METRICS = new Map([
  ["microsoft.opentelemetry.benchmark.throughput", "{operation}/s"],
  ["microsoft.opentelemetry.benchmark.memory.heap_used_increase", "By"],
  ["microsoft.opentelemetry.benchmark.memory.heap_used_increase_per_operation", "By/{operation}"],
  ["microsoft.opentelemetry.benchmark.memory.retained_heap_increase", "By"],
  [
    "microsoft.opentelemetry.benchmark.memory.retained_heap_increase_per_operation",
    "By/{operation}",
  ],
  ["microsoft.opentelemetry.benchmark.memory.rss_increase", "By"],
]);
const EXPECTED_SCENARIOS = new Map([
  ["span", { category: "span", test: "span_creation" }],
  ["span_with_attribute", { category: "span", test: "span_creation_with_attribute" }],
  ["counter_add", { category: "metric", test: "metric_counter_add" }],
  ["logger_emit", { category: "log", test: "log_emit" }],
]);

function anyValue(value) {
  const entries = Object.entries(value);
  assert.equal(entries.length, 1, `expected one OTLP AnyValue field, received ${entries.length}`);
  return entries[0][1];
}

function attributesToObject(attributes) {
  return Object.fromEntries(
    attributes.map((attribute) => [attribute.key, anyValue(attribute.value)]),
  );
}

function parseMetricRequest(request) {
  const payload = JSON.parse(request.body.toString("utf8"));
  assert.equal(payload.resourceMetrics.length, 1);
  const resourceMetrics = payload.resourceMetrics[0];
  const resourceAttributes = attributesToObject(resourceMetrics.resource.attributes);
  const metrics = resourceMetrics.scopeMetrics.flatMap((scope) => scope.metrics);
  return { metrics, resourceAttributes };
}

function runBenchmark(endpoint, outputPath, runId, memoryTrials = "3") {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--expose-gc",
        "perf/benchmark.mjs",
        "--iterations",
        "100",
        "--rounds",
        "1",
        "--memory-iterations",
        "100",
        "--memory-trials",
        memoryTrials,
        "--output",
        outputPath,
        "--otlp-endpoint",
        endpoint,
        "--run-id",
        runId,
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          MICROSOFT_OTEL_SDKSTATS_DISABLED: "true",
          OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
          OTEL_EXPORTER_OTLP_TIMEOUT: "2000",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

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
        resolve(stdout);
        return;
      }
      reject(
        new Error(
          `Performance benchmark exited with code ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
        ),
      );
    });
  });
}

test("performance benchmark exposes local usage through help", () => {
  const result = spawnSync(process.execPath, ["--expose-gc", "perf/benchmark.mjs", "--help"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: npm run test:performance/);
  assert.match(result.stdout, /--memory-trials/);
  assert.match(result.stdout, /--otlp-endpoint/);
});

test("performance benchmark exports measured results through OTLP metrics", async (t) => {
  const requests = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({
        body: Buffer.concat(chunks),
        contentType: request.headers["content-type"],
        method: request.method,
        url: request.url,
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
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
  const directory = await mkdtemp(join(tmpdir(), "otel-performance-otlp-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const outputPath = join(directory, "result.json");
  const runId = "performance-otlp-integration";
  const stdout = await runBenchmark(`http://127.0.0.1:${address.port}`, outputPath, runId);
  const packageMetadata = JSON.parse(await readFile("package.json", "utf8"));
  const benchmarkResult = JSON.parse(await readFile(outputPath, "utf8"));
  const vcsRevision = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();

  assert.match(stdout, /span: [\d.]+ operations\/s/);
  assert.match(stdout, /span_with_attribute: [\d.]+ operations\/s/);
  assert.match(stdout, /counter_add: [\d.]+ operations\/s/);
  assert.match(stdout, /logger_emit: [\d.]+ operations\/s/);
  assert.match(
    stdout,
    new RegExp(`Exported 4 throughput and 20 memory metrics with run ID ${runId}`),
  );

  const metricRequest = requests.find((request) => request.url === "/v1/metrics");
  assert(metricRequest, "expected an OTLP metric request");
  assert.equal(metricRequest.method, "POST");
  assert.equal(metricRequest.contentType, "application/json");
  assert(metricRequest.body.length > 0, "expected a non-empty OTLP payload");
  const { metrics, resourceAttributes } = parseMetricRequest(metricRequest);

  assert.deepEqual(
    {
      "benchmark.run_id": resourceAttributes["benchmark.run_id"],
      "benchmark.source": resourceAttributes["benchmark.source"],
      "package.name": resourceAttributes["package.name"],
      "package.version": resourceAttributes["package.version"],
      "process.runtime.name": resourceAttributes["process.runtime.name"],
      "vcs.revision": resourceAttributes["vcs.revision"],
    },
    {
      "benchmark.run_id": runId,
      "benchmark.source": "opentelemetry-distro-javascript",
      "package.name": packageMetadata.name,
      "package.version": packageMetadata.version,
      "process.runtime.name": "node",
      "vcs.revision": vcsRevision,
    },
  );
  for (const requiredKey of [
    "service.name",
    "process.runtime.version",
    "os.type",
    "os.version",
    "host.arch",
  ]) {
    assert(resourceAttributes[requiredKey], `expected resource attribute ${requiredKey}`);
  }

  assert.deepEqual(new Map(metrics.map((metric) => [metric.name, metric.unit])), EXPECTED_METRICS);
  for (const metric of metrics) {
    assert(metric.gauge, `expected ${metric.name} to use Gauge data`);
    assert.equal(metric.gauge.dataPoints.length, 4);
    const scenarios = new Set();
    for (const dataPoint of metric.gauge.dataPoints) {
      const attributes = attributesToObject(dataPoint.attributes);
      const scenario = attributes["benchmark.scenario"];
      scenarios.add(scenario);
      assert.equal(attributes["benchmark.test"], EXPECTED_SCENARIOS.get(scenario)?.test);
      assert.equal(attributes["benchmark.name"], scenario);
      assert.equal(attributes["benchmark.category"], EXPECTED_SCENARIOS.get(scenario)?.category);
      if (metric.name === "microsoft.opentelemetry.benchmark.throughput") {
        assert.equal(attributes["benchmark.statistic"], "median");
        assert.equal(Number(attributes["benchmark.iterations"]), 100);
        assert.equal(Number(attributes["benchmark.rounds"]), 1);
        assert.equal(attributes["benchmark.gating"], true);
      } else {
        assert.equal(attributes["benchmark.statistic"], "median_observed_increase");
        assert.equal(Number(attributes["benchmark.memory_iterations"]), 100);
        assert.equal(Number(attributes["benchmark.memory_trials"]), 3);
        assert.equal(Number(attributes["benchmark.memory_noise_floor_bytes"]), 4096);
      }
    }
    assert.deepEqual(scenarios, new Set(EXPECTED_SCENARIOS.keys()));
  }

  assert.equal(benchmarkResult.memoryTrials, 3);
  assert.equal(benchmarkResult.memoryBenchmarks.length, 4);
  for (const result of benchmarkResult.memoryBenchmarks) {
    assert.equal(result.trials.length, 3);
    for (const value of Object.values(result.stats)) {
      assert(value >= 0, `expected reportable memory value to be non-negative, received ${value}`);
    }
  }
});

test("performance benchmark fails when export identity cannot resolve a commit", async (t) => {
  const packageRoot = await mkdtemp(join(tmpdir(), "otel-performance-no-git-"));
  t.after(() => rm(packageRoot, { force: true, recursive: true }));
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "@microsoft/opentelemetry", version: "1.3.0" }),
  );

  const result = spawnSync(
    process.execPath,
    [
      "--expose-gc",
      "perf/benchmark.mjs",
      "--package-root",
      packageRoot,
      "--otlp-endpoint",
      "http://127.0.0.1:4318",
    ],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /vcs\.revision is unavailable/);
  assert.match(result.stderr, /Run from a Git checkout/);
});

test("performance benchmark fails when the collector rejects metrics", async (t) => {
  const server = createServer((_request, response) => {
    response.writeHead(500, { "content-type": "application/json" });
    response.end('{"error":"rejected"}');
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.close();
    await once(server, "close");
  });

  const address = server.address();
  assert(address && typeof address === "object");
  const directory = await mkdtemp(join(tmpdir(), "otel-performance-rejected-"));
  t.after(() => rm(directory, { force: true, recursive: true }));

  await assert.rejects(
    runBenchmark(
      `http://127.0.0.1:${address.port}`,
      join(directory, "result.json"),
      "performance-otlp-rejected",
      "1",
    ),
    /Benchmark metrics export failed/,
  );
});
