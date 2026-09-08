// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { arch, platform, release } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startBenchmarkSdk } from "./benchmark-sdk.mjs";
import { summarizeMemoryTrials } from "./memory-results.mjs";

const DEFAULT_ITERATIONS = 100_000;
const DEFAULT_ROUNDS = 12;
const WARMUP_ITERATIONS = 20_000;
const DEFAULT_MEMORY_TRIALS = 5;
const DEFAULT_MEMORY_NOISE_FLOOR_BYTES = 4_096;
const MEMORY_RESULT_PREFIX = "MEMORY_RESULT:";
const HELP = `Usage: npm run test:performance -- [options]

Measure Microsoft OpenTelemetry SDK throughput and isolated process-memory increases.

Options:
  --package-root <path>          Built package root (default: current directory)
  --output <path>                Write raw samples and summaries as JSON
  --iterations <count>           Throughput operations per round (default: 100000)
  --rounds <count>               Throughput rounds (default: 12)
  --memory-iterations <count>    Operations per isolated memory trial
  --memory-trials <count>        Isolated memory trials per scenario (default: 5)
  --memory-noise-floor <bytes>   Median increase required for reporting (default: 4096)
  --otlp-endpoint <url>          Export summarized results to an OTLP/HTTP base URL
  --run-id <value>               Result run identifier
  -h, --help                     Show this help

Environment fallbacks:
  OTEL_EXPORTER_OTLP_ENDPOINT, OTEL_PERF_RUN_ID

Cross-language point identity:
  benchmark.test=<stable benchmark case>
  benchmark.scenario=<operation>
  benchmark.name=<operation> (compatibility alias equal to benchmark.scenario)
`;
const OTLP_ENDPOINT_VARIABLES = [
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
  "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
  "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
];

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(HELP);
  process.exit(0);
}

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
  const elapsedNanoseconds = Number(process.hrtime.bigint() - start);
  return (iterations * 1_000_000_000) / elapsedNanoseconds;
}

async function benchmark(category, name, test, operation, iterations, rounds) {
  runIterations(operation, WARMUP_ITERATIONS);
  const samples = [];

  for (let round = 0; round < rounds; round += 1) {
    globalThis.gc?.();
    samples.push(runIterations(operation, iterations));
    await new Promise((resolveRound) => setImmediate(resolveRound));
  }

  const result = {
    category,
    gating: true,
    name,
    samples,
    stats: { median: median(samples) },
    test,
    unit: "operations/s",
  };
  console.log(`${name}: ${result.stats.median.toFixed(1)} operations/s`);
  return result;
}

function normalizeOtlpEndpoint(value) {
  if (!value) {
    return undefined;
  }

  let endpoint;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error("--otlp-endpoint must be a valid URL");
  }
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    throw new Error("--otlp-endpoint must use http or https");
  }
  return endpoint.href.replace(/\/+$/, "");
}

function readGitSha(packageRoot) {
  try {
    return execFileSync("git", ["-C", packageRoot, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

function requireExportIdentity(packageRoot, packageMetadata) {
  const packageName = typeof packageMetadata.name === "string" ? packageMetadata.name.trim() : "";
  const packageVersion =
    typeof packageMetadata.version === "string" ? packageMetadata.version.trim() : "";
  if (!packageName) {
    throw new Error(
      `Cannot export benchmark results: package.name is missing from ${join(packageRoot, "package.json")}`,
    );
  }
  if (!packageVersion) {
    throw new Error(
      `Cannot export benchmark results: package.version is missing from ${join(packageRoot, "package.json")}`,
    );
  }

  const vcsRevision = readGitSha(packageRoot);
  if (!vcsRevision) {
    throw new Error(
      `Cannot export benchmark results: vcs.revision is unavailable for ${packageRoot}. Run from a Git checkout whose package root contains the benchmarked revision.`,
    );
  }

  return { packageName, packageVersion, vcsRevision };
}

function runMemoryTrial(packageRoot, scenarioName, iterations) {
  const environment = { ...process.env };
  for (const name of OTLP_ENDPOINT_VARIABLES) {
    delete environment[name];
  }
  const stdout = execFileSync(
    process.execPath,
    [
      "--expose-gc",
      fileURLToPath(new URL("./memory-worker.mjs", import.meta.url)),
      "--package-root",
      packageRoot,
      "--scenario",
      scenarioName,
      "--iterations",
      String(iterations),
    ],
    {
      encoding: "utf8",
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    },
  );
  const resultLine = stdout.split(/\r?\n/).find((line) => line.startsWith(MEMORY_RESULT_PREFIX));
  if (!resultLine) {
    throw new Error(`Memory benchmark ${scenarioName} did not produce a result`);
  }
  return JSON.parse(resultLine.slice(MEMORY_RESULT_PREFIX.length));
}

function measureMemoryScenarios({
  iterations,
  noiseFloorBytes,
  packageRoot,
  scenarios,
  trialCount,
}) {
  return scenarios.map((scenario) => {
    const trials = [];
    for (let trial = 0; trial < trialCount; trial += 1) {
      trials.push(runMemoryTrial(packageRoot, scenario.name, iterations));
    }
    const result = summarizeMemoryTrials({
      category: scenario.category,
      iterations,
      name: scenario.name,
      noiseFloorBytes,
      test: scenario.test,
      trials,
    });
    console.log(
      `${scenario.name} memory increase: heap ${result.stats.heapUsedIncrease} B, retained ${result.stats.retainedHeapIncrease} B, RSS ${result.stats.rssIncrease} B`,
    );
    return result;
  });
}

async function exportBenchmarkMetrics({
  benchmarks,
  endpoint,
  iterations,
  memoryBenchmarks,
  packageRoot,
  rounds,
  runId,
  exportIdentity,
}) {
  const requireFromPackage = createRequire(join(packageRoot, "package.json"));
  const { OTLPMetricExporter } = requireFromPackage("@opentelemetry/exporter-metrics-otlp-http");
  const { ExportResultCode } = requireFromPackage("@opentelemetry/core");
  const { resourceFromAttributes } = requireFromPackage("@opentelemetry/resources");
  const { MeterProvider, MetricReader } = requireFromPackage("@opentelemetry/sdk-metrics");

  const resourceAttributes = {
    "service.name": "microsoft-opentelemetry-js-benchmark",
    "benchmark.run_id": runId,
    "benchmark.source": "opentelemetry-distro-javascript",
    "package.name": exportIdentity.packageName,
    "package.version": exportIdentity.packageVersion,
    "process.runtime.name": "node",
    "process.runtime.version": process.version,
    "os.type": platform(),
    "os.version": release(),
    "host.arch": arch(),
  };
  resourceAttributes["vcs.revision"] = exportIdentity.vcsRevision;

  const exporter = new OTLPMetricExporter({ url: `${endpoint}/v1/metrics` });
  class ManualMetricReader extends MetricReader {
    onForceFlush() {
      return Promise.resolve();
    }

    onShutdown() {
      return Promise.resolve();
    }
  }
  const reader = new ManualMetricReader();
  const provider = new MeterProvider({
    readers: [reader],
    resource: resourceFromAttributes(resourceAttributes),
  });
  const throughput = provider
    .getMeter("microsoft-opentelemetry-js-benchmark")
    .createGauge("microsoft.opentelemetry.benchmark.throughput", {
      description: "Median operation throughput measured by the JavaScript distro benchmark",
      unit: "{operation}/s",
    });

  for (const result of benchmarks) {
    throughput.record(result.stats.median, {
      "benchmark.category": result.category,
      "benchmark.name": result.name,
      "benchmark.scenario": result.name,
      "benchmark.unit": result.unit,
      "benchmark.test": result.test,
      "benchmark.statistic": "median",
      "benchmark.iterations": iterations,
      "benchmark.rounds": rounds,
      "benchmark.gating": result.gating,
    });
  }

  const meter = provider.getMeter("microsoft-opentelemetry-js-benchmark");
  const memoryGauges = {
    heapUsedIncrease: meter.createGauge(
      "microsoft.opentelemetry.benchmark.memory.heap_used_increase",
      {
        description:
          "Median observed process heap-used increase during an isolated operation batch",
        unit: "By",
      },
    ),
    heapUsedIncreasePerOperation: meter.createGauge(
      "microsoft.opentelemetry.benchmark.memory.heap_used_increase_per_operation",
      {
        description: "Median observed heap-used increase divided by operations in the memory batch",
        unit: "By/{operation}",
      },
    ),
    retainedHeapIncrease: meter.createGauge(
      "microsoft.opentelemetry.benchmark.memory.retained_heap_increase",
      {
        description: "Median observed retained heap increase across isolated operation batches",
        unit: "By",
      },
    ),
    retainedHeapIncreasePerOperation: meter.createGauge(
      "microsoft.opentelemetry.benchmark.memory.retained_heap_increase_per_operation",
      {
        description: "Median observed retained heap increase divided by memory batch operations",
        unit: "By/{operation}",
      },
    ),
    rssIncrease: meter.createGauge("microsoft.opentelemetry.benchmark.memory.rss_increase", {
      description: "Median observed process RSS increase during an isolated operation batch",
      unit: "By",
    }),
  };

  for (const result of memoryBenchmarks) {
    const attributes = {
      "benchmark.category": result.category,
      "benchmark.memory_iterations": result.iterations,
      "benchmark.memory_noise_floor_bytes": result.noiseFloorBytes,
      "benchmark.memory_trials": result.trials.length,
      "benchmark.name": result.name,
      "benchmark.scenario": result.name,
      "benchmark.statistic": "median_observed_increase",
      "benchmark.test": result.test,
    };
    memoryGauges.heapUsedIncrease.record(result.stats.heapUsedIncrease, attributes);
    memoryGauges.heapUsedIncreasePerOperation.record(
      result.stats.heapUsedIncreasePerOperation,
      attributes,
    );
    memoryGauges.retainedHeapIncrease.record(result.stats.retainedHeapIncrease, attributes);
    memoryGauges.retainedHeapIncreasePerOperation.record(
      result.stats.retainedHeapIncreasePerOperation,
      attributes,
    );
    memoryGauges.rssIncrease.record(result.stats.rssIncrease, attributes);
  }

  try {
    const { resourceMetrics, errors } = await reader.collect();
    if (errors.length > 0) {
      throw new AggregateError(errors, "Benchmark metrics collection failed");
    }
    await new Promise((resolveExport, rejectExport) => {
      exporter.export(resourceMetrics, (result) => {
        if (result.code === ExportResultCode.SUCCESS) {
          resolveExport();
        } else {
          rejectExport(
            new Error(
              `Benchmark metrics export failed${result.error ? `: ${result.error.message}` : ""}`,
            ),
          );
        }
      });
    });
  } finally {
    await provider.shutdown();
    await exporter.shutdown();
  }
  console.log(
    `Exported ${benchmarks.length} throughput and ${memoryBenchmarks.length * 5} memory metrics with run ID ${runId}`,
  );
}

const packageRootArgument = readArgument("--package-root", process.cwd());
const packageRoot = isAbsolute(packageRootArgument)
  ? packageRootArgument
  : resolve(process.cwd(), packageRootArgument);
const outputArgument = readArgument("--output");
const iterations = Number(readArgument("--iterations", String(DEFAULT_ITERATIONS)));
const rounds = Number(readArgument("--rounds", String(DEFAULT_ROUNDS)));
const memoryIterations = Number(
  readArgument("--memory-iterations", String(Math.min(iterations, 10_000))),
);
const memoryTrials = Number(readArgument("--memory-trials", String(DEFAULT_MEMORY_TRIALS)));
const memoryNoiseFloorBytes = Number(
  readArgument("--memory-noise-floor", String(DEFAULT_MEMORY_NOISE_FLOOR_BYTES)),
);
const otlpEndpoint = normalizeOtlpEndpoint(
  readArgument("--otlp-endpoint", process.env.OTEL_EXPORTER_OTLP_ENDPOINT),
);
const runId = readArgument(
  "--run-id",
  process.env.OTEL_PERF_RUN_ID ?? `local-${Date.now()}-${randomUUID().slice(0, 8)}`,
);

if (!Number.isInteger(iterations) || iterations <= 0) {
  throw new Error("--iterations must be a positive integer");
}
if (!Number.isInteger(rounds) || rounds <= 0) {
  throw new Error("--rounds must be a positive integer");
}
if (!Number.isInteger(memoryIterations) || memoryIterations <= 0) {
  throw new Error("--memory-iterations must be a positive integer");
}
if (!Number.isInteger(memoryTrials) || memoryTrials <= 0) {
  throw new Error("--memory-trials must be a positive integer");
}
if (!Number.isInteger(memoryNoiseFloorBytes) || memoryNoiseFloorBytes < 0) {
  throw new Error("--memory-noise-floor must be a non-negative integer");
}
if (!runId.trim()) {
  throw new Error("--run-id must not be empty");
}
if (typeof globalThis.gc !== "function") {
  throw new Error("The performance benchmark requires Node --expose-gc");
}

const packageMetadata = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
const exportIdentity = otlpEndpoint
  ? requireExportIdentity(packageRoot, packageMetadata)
  : undefined;
process.env.MICROSOFT_OTEL_SDKSTATS_DISABLED = "true";

// Exclude OTLP exporter initialization and network activity from the measured section.
const savedOtlpEndpoints = new Map(
  OTLP_ENDPOINT_VARIABLES.map((name) => [name, process.env[name]]),
);
for (const name of OTLP_ENDPOINT_VARIABLES) {
  delete process.env[name];
}

const { scenarios, shutdown } = await startBenchmarkSdk(packageRoot);
const benchmarks = [];

try {
  for (const scenario of scenarios) {
    benchmarks.push(
      await benchmark(
        scenario.category,
        scenario.name,
        scenario.test,
        scenario.operation,
        iterations,
        rounds,
      ),
    );
  }
} finally {
  await shutdown();
  for (const [name, value] of savedOtlpEndpoints) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
}

const memoryBenchmarks = measureMemoryScenarios({
  iterations: memoryIterations,
  noiseFloorBytes: memoryNoiseFloorBytes,
  packageRoot,
  scenarios,
  trialCount: memoryTrials,
});

const result = {
  benchmarks,
  iterations,
  memoryBenchmarks,
  memoryIterations,
  memoryNoiseFloorBytes,
  memoryTrials,
  package: {
    name: packageMetadata.name,
    version: packageMetadata.version,
  },
  packageRoot,
  rounds,
  runId,
};

if (outputArgument) {
  await writeFile(outputArgument, `${JSON.stringify(result, null, 2)}\n`, "utf8");
} else {
  console.log(JSON.stringify(result, null, 2));
}

if (otlpEndpoint) {
  await exportBenchmarkMetrics({
    benchmarks,
    endpoint: otlpEndpoint,
    iterations,
    memoryBenchmarks,
    packageRoot,
    rounds,
    runId,
    exportIdentity,
  });
}
