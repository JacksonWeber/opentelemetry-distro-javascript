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

async function loadBenchmarks(path) {
  const document = JSON.parse(await readFile(path, "utf8"));
  return new Map(document.benchmarks.map((benchmark) => [benchmark.name, benchmark]));
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value);
}

const baselinePath = readArgument("--baseline");
const candidatePath = readArgument("--candidate");
const outputPath = readArgument("--output");
const threshold = Number(readArgument("--threshold", "15"));

if (!baselinePath || !candidatePath) {
  throw new Error("--baseline and --candidate are required");
}
if (!Number.isFinite(threshold) || threshold < 0) {
  throw new Error("--threshold must be a non-negative number");
}

const baseline = await loadBenchmarks(baselinePath);
const candidate = await loadBenchmarks(candidatePath);
const names = [...new Set([...baseline.keys(), ...candidate.keys()])].sort();
const lines = [
  "### Performance comparison",
  "",
  `Regressions over ${threshold.toFixed(1)}% fail the build. Lower ns/op is better.`,
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
