// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { trace } from "@opentelemetry/api";

const DEFAULT_ITERATIONS = 100_000;
const DEFAULT_ROUNDS = 12;
const WARMUP_ITERATIONS = 20_000;

function readArgument(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return fallback;
  }
  const value = process.argv[index + 1];
  if (!value) {
    throw new Error(`Missing value for ${name}`);
  }
  return value;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[midpoint - 1] + sorted[midpoint]) / 2 : sorted[midpoint];
}

function runIterations(operation, iterations) {
  const start = process.hrtime.bigint();
  for (let index = 0; index < iterations; index += 1) {
    operation();
  }
  return Number(process.hrtime.bigint() - start) / iterations;
}

async function benchmark(name, operation, iterations, rounds) {
  runIterations(operation, WARMUP_ITERATIONS);
  const samples = [];

  for (let round = 0; round < rounds; round += 1) {
    globalThis.gc?.();
    samples.push(runIterations(operation, iterations));
    await new Promise((resolveRound) => setImmediate(resolveRound));
  }

  const result = {
    gating: true,
    name,
    samples,
    stats: { median: median(samples) },
    unit: "ns/op",
  };
  console.log(`${name}: ${result.stats.median.toFixed(1)} ns/op`);
  return result;
}

const packageRootArgument = readArgument("--package-root", process.cwd());
const packageRoot = isAbsolute(packageRootArgument)
  ? packageRootArgument
  : resolve(process.cwd(), packageRootArgument);
const outputArgument = readArgument("--output");
const iterations = Number(readArgument("--iterations", String(DEFAULT_ITERATIONS)));
const rounds = Number(readArgument("--rounds", String(DEFAULT_ROUNDS)));

if (!Number.isInteger(iterations) || iterations <= 0) {
  throw new Error("--iterations must be a positive integer");
}
if (!Number.isInteger(rounds) || rounds <= 0) {
  throw new Error("--rounds must be a positive integer");
}

const distroEntryPoint = pathToFileURL(join(packageRoot, "dist", "esm", "index.js")).href;
process.env.MICROSOFT_OTEL_SDKSTATS_DISABLED = "true";
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
  samplingRatio: 1,
  tracesPerSecond: 0,
});

const tracer = trace.getTracer("performance-test");
const benchmarks = [];

try {
  benchmarks.push(
    await benchmark(
      "span",
      () => {
        tracer.startSpan("benchmark-span").end();
      },
      iterations,
      rounds,
    ),
  );
  benchmarks.push(
    await benchmark(
      "span_with_attribute",
      () => {
        const span = tracer.startSpan("benchmark-span");
        span.setAttribute("benchmark.attribute", 1);
        span.end();
      },
      iterations,
      rounds,
    ),
  );
} finally {
  await shutdownMicrosoftOpenTelemetry();
}

const result = {
  benchmarks,
  iterations,
  packageRoot,
  rounds,
};

if (outputArgument) {
  await writeFile(outputArgument, `${JSON.stringify(result, null, 2)}\n`, "utf8");
} else {
  console.log(JSON.stringify(result, null, 2));
}
