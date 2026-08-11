// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { readFile, writeFile } from "node:fs/promises";

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

function readArguments(name) {
  const values = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === name) {
      const value = process.argv[index + 1];
      if (!value) {
        throw new Error(`Missing value for ${name}`);
      }
      values.push(value);
    }
  }
  return values;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[midpoint - 1] + sorted[midpoint]) / 2 : sorted[midpoint];
}

async function loadBenchmarks(paths) {
  const aggregate = new Map();

  for (const path of paths) {
    const document = JSON.parse(await readFile(path, "utf8"));
    for (const benchmark of document.benchmarks) {
      const samples = benchmark.samples ?? [benchmark.stats?.median];
      if (
        samples.length === 0 ||
        samples.some((sample) => !Number.isFinite(sample) || sample <= 0)
      ) {
        throw new Error(`Benchmark ${benchmark.name} in ${path} has invalid samples`);
      }

      const current = aggregate.get(benchmark.name) ?? {
        gating: false,
        samples: [],
      };
      current.gating ||= Boolean(benchmark.gating);
      current.samples.push(...samples);
      aggregate.set(benchmark.name, current);
    }
  }

  return new Map(
    [...aggregate].map(([name, benchmark]) => [
      name,
      {
        gating: benchmark.gating,
        samples: benchmark.samples,
        stats: { median: median(benchmark.samples) },
      },
    ]),
  );
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value);
}

const baselinePaths = readArguments("--baseline");
const candidatePaths = readArguments("--candidate");
const outputPath = readArgument("--output");
const threshold = Number(readArgument("--threshold", "15"));

if (baselinePaths.length === 0 || candidatePaths.length === 0) {
  throw new Error("--baseline and --candidate are required");
}
if (!Number.isFinite(threshold) || threshold < 0) {
  throw new Error("--threshold must be a non-negative number");
}

const baseline = await loadBenchmarks(baselinePaths);
const candidate = await loadBenchmarks(candidatePaths);
const names = [...new Set([...baseline.keys(), ...candidate.keys()])].sort();
const lines = [
  "### Performance comparison",
  "",
  `Regressions over ${threshold.toFixed(1)}% fail the build. Lower ns/op is better. Medians aggregate samples from alternating trials.`,
  "",
  "| Scenario | Baseline (ns/op) | Candidate (ns/op) | Delta | Status |",
  "| --- | ---: | ---: | ---: | :---: |",
];
let regressed = false;

for (const name of names) {
  const baselineResult = baseline.get(name);
  const candidateResult = candidate.get(name);
  const baselineMedian = baselineResult?.stats?.median;
  const candidateMedian = candidateResult?.stats?.median;

  if (
    !Number.isFinite(baselineMedian) ||
    baselineMedian <= 0 ||
    !Number.isFinite(candidateMedian) ||
    candidateMedian <= 0
  ) {
    lines.push(`| \`${name}\` | - | - | - | missing |`);
    continue;
  }

  const delta = ((candidateMedian - baselineMedian) / baselineMedian) * 100;
  const gating = Boolean(baselineResult.gating || candidateResult.gating);
  const failed = gating && delta > threshold;
  regressed ||= failed;
  lines.push(
    `| \`${name}\` | ${formatNumber(baselineMedian)} | ${formatNumber(candidateMedian)} | ${delta >= 0 ? "+" : ""}${delta.toFixed(2)}% | ${failed ? "fail" : "pass"} |`,
  );
}

const report = `${lines.join("\n")}\n`;
process.stdout.write(report);

if (outputPath) {
  await writeFile(outputPath, report, "utf8");
}

if (regressed) {
  process.exitCode = 1;
}
