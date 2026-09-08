// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import assert from "node:assert/strict";
import { test } from "node:test";
import { summarizeMemoryTrials } from "../../perf/memory-results.mjs";

test("memory summary reports no increase for negative and noise-level median trials", () => {
  const result = summarizeMemoryTrials({
    category: "span",
    iterations: 100,
    name: "span",
    noiseFloorBytes: 4096,
    test: "span_creation",
    trials: [
      { heapUsedDelta: -8000, retainedHeapDelta: -4000, rssDelta: 0 },
      { heapUsedDelta: -1000, retainedHeapDelta: -2000, rssDelta: 4096 },
      { heapUsedDelta: 2000, retainedHeapDelta: -1000, rssDelta: -4096 },
      { heapUsedDelta: 3000, retainedHeapDelta: 1000, rssDelta: 2048 },
      { heapUsedDelta: 9000, retainedHeapDelta: 2000, rssDelta: 8192 },
    ],
  });

  assert.equal(result.rawMedians.heapUsed, 2000);
  assert.equal(result.rawMedians.retainedHeap, -1000);
  assert.equal(result.rawMedians.rss, 2048);
  assert.deepEqual(result.stats, {
    heapUsedIncrease: 0,
    heapUsedIncreasePerOperation: 0,
    retainedHeapIncrease: 0,
    retainedHeapIncreasePerOperation: 0,
    rssIncrease: 0,
  });
  assert(result.trials.some((trial) => trial.heapUsedDelta < 0));
});

test("memory summary reports a robust positive median rather than an outlier", () => {
  const result = summarizeMemoryTrials({
    category: "metric",
    iterations: 100,
    name: "counter_add",
    noiseFloorBytes: 4096,
    test: "metric_counter_add",
    trials: [
      { heapUsedDelta: 10000, retainedHeapDelta: 5000, rssDelta: 100000 },
      { heapUsedDelta: 11000, retainedHeapDelta: 6000, rssDelta: 110000 },
      { heapUsedDelta: 12000, retainedHeapDelta: 7000, rssDelta: 120000 },
      { heapUsedDelta: 13000, retainedHeapDelta: 8000, rssDelta: 130000 },
      { heapUsedDelta: 900000, retainedHeapDelta: 900000, rssDelta: 900000 },
    ],
  });

  assert.equal(result.stats.heapUsedIncrease, 12000);
  assert.equal(result.stats.heapUsedIncreasePerOperation, 120);
  assert.equal(result.stats.retainedHeapIncrease, 7000);
  assert.equal(result.stats.retainedHeapIncreasePerOperation, 70);
  assert.equal(result.stats.rssIncrease, 120000);
});
