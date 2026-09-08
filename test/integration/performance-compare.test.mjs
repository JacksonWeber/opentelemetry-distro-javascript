// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

function benchmarkResult(value) {
  return {
    benchmarks: [
      {
        gating: true,
        name: "span",
        samples: [value],
        stats: { median: value },
        unit: "operations/s",
      },
    ],
  };
}

test("performance comparison fails when throughput drops beyond the threshold", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "otel-performance-compare-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const baselinePath = join(directory, "baseline.json");
  const candidatePath = join(directory, "candidate.json");
  await writeFile(baselinePath, JSON.stringify(benchmarkResult(100)));
  await writeFile(candidatePath, JSON.stringify(benchmarkResult(80)));

  const result = spawnSync(
    process.execPath,
    [
      "perf/compare.mjs",
      "--baseline",
      baselinePath,
      "--candidate",
      candidatePath,
      "--threshold",
      "15",
    ],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 1);
  assert.match(result.stdout, /Higher operations\/s is better/);
  assert.match(result.stdout, /-20.00% \| fail/);
});
