// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { isAbsolute, resolve } from "node:path";
import { startBenchmarkSdk } from "./benchmark-sdk.mjs";

const MEMORY_RESULT_PREFIX = "MEMORY_RESULT:";
const WARMUP_ITERATIONS = 1_000;
const GC_SETTLE_ROUNDS = 3;

function readArgument(name) {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (!value) {
    throw new Error(`Missing value for ${name}`);
  }
  return value;
}

async function settleGarbageCollection() {
  for (let round = 0; round < GC_SETTLE_ROUNDS; round += 1) {
    globalThis.gc();
    await new Promise((resolveRound) => setImmediate(resolveRound));
  }
}

if (typeof globalThis.gc !== "function") {
  throw new Error("The memory benchmark requires Node --expose-gc");
}

const packageRootArgument = readArgument("--package-root");
const packageRoot = isAbsolute(packageRootArgument)
  ? packageRootArgument
  : resolve(process.cwd(), packageRootArgument);
const scenarioName = readArgument("--scenario");
const iterations = Number(readArgument("--iterations"));
if (!Number.isInteger(iterations) || iterations <= 0) {
  throw new Error("--iterations must be a positive integer");
}

const { scenarios, shutdown } = await startBenchmarkSdk(packageRoot);
const scenario = scenarios.find((candidate) => candidate.name === scenarioName);
if (!scenario) {
  throw new Error(`Unknown memory benchmark scenario: ${scenarioName}`);
}

let result;
try {
  for (let index = 0; index < Math.min(iterations, WARMUP_ITERATIONS); index += 1) {
    scenario.operation();
  }
  await settleGarbageCollection();
  const baseline = process.memoryUsage();

  for (let index = 0; index < iterations; index += 1) {
    scenario.operation();
  }

  const immediate = process.memoryUsage();
  await settleGarbageCollection();
  const retained = process.memoryUsage();
  result = {
    heapUsedDelta: immediate.heapUsed - baseline.heapUsed,
    retainedHeapDelta: retained.heapUsed - baseline.heapUsed,
    rssDelta: immediate.rss - baseline.rss,
  };
} finally {
  await shutdown();
}

console.log(`${MEMORY_RESULT_PREFIX}${JSON.stringify(result)}`);
