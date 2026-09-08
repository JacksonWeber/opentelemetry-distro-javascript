// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[midpoint - 1] + sorted[midpoint]) / 2 : sorted[midpoint];
}

function observedIncrease(rawMedian, noiseFloorBytes) {
  return rawMedian > noiseFloorBytes ? rawMedian : 0;
}

export function summarizeMemoryTrials({
  category,
  iterations,
  name,
  noiseFloorBytes,
  test,
  trials,
}) {
  if (trials.length === 0) {
    throw new Error(`Memory benchmark ${name} requires at least one trial`);
  }

  const rawMedians = {
    heapUsed: median(trials.map((trial) => trial.heapUsedDelta)),
    retainedHeap: median(trials.map((trial) => trial.retainedHeapDelta)),
    rss: median(trials.map((trial) => trial.rssDelta)),
  };
  const heapUsedIncrease = observedIncrease(rawMedians.heapUsed, noiseFloorBytes);
  const retainedHeapIncrease = observedIncrease(rawMedians.retainedHeap, noiseFloorBytes);
  const rssIncrease = observedIncrease(rawMedians.rss, noiseFloorBytes);

  return {
    category,
    iterations,
    name,
    noiseFloorBytes,
    rawMedians,
    stats: {
      heapUsedIncrease,
      heapUsedIncreasePerOperation: heapUsedIncrease / iterations,
      retainedHeapIncrease,
      retainedHeapIncreasePerOperation: retainedHeapIncrease / iterations,
      rssIncrease,
    },
    test,
    trials,
  };
}
