// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Counter, Meter, MeterProvider } from "@opentelemetry/api";
import { context } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";

import { ParentMeterProvider } from "../../../../src/distro/multiInstance/delegatingProviders.js";
import type { InstanceProviders } from "../../../../src/distro/multiInstance/instanceRegistry.js";
import {
  _resetRegistry,
  registerInstance,
  withInstance,
} from "../../../../src/distro/multiInstance/instanceRegistry.js";

interface Add {
  instance: string;
  value: number;
}

/**
 * A fake MeterProvider whose counters record every `.add()` into `sink`, tagged
 * with the owning instance, so a test can see which instance a measurement
 * routed to.
 */
function recordingProviders(instance: string, sink: Add[]): InstanceProviders {
  const counter: Counter = {
    add: (value: number) => sink.push({ instance, value }),
  } as Counter;
  const meter: Meter = { createCounter: () => counter } as unknown as Meter;
  const meterProvider: MeterProvider = { getMeter: () => meter } as MeterProvider;
  return {
    tracerProvider: {} as InstanceProviders["tracerProvider"],
    meterProvider,
    loggerProvider: {} as InstanceProviders["loggerProvider"],
  };
}

describe("DelegatingMeter metric routing", () => {
  beforeAll(() => {
    // withInstance relies on the async context, so a real context manager must
    // be active for the ambient instance id to propagate.
    const cm = new AsyncLocalStorageContextManager();
    cm.enable();
    context.setGlobalContextManager(cm);
  });

  afterEach(() => {
    _resetRegistry();
  });

  it("routes each .add() to the ambient instance, not the one current at creation", () => {
    const sink: Add[] = [];
    registerInstance("a", recordingProviders("a", sink)); // first → default
    registerInstance("b", recordingProviders("b", sink));

    // Create the counter once with no ambient instance: it resolves to the
    // default (a) at creation time — mirroring how instrumentations create
    // instruments once at init.
    const counter = new ParentMeterProvider().getMeter("test").createCounter("requests");

    // Later measurements must follow the ambient context, not the creation-time
    // instance.
    withInstance("b", () => counter.add(1));
    withInstance("a", () => counter.add(2));
    counter.add(3); // no ambient → default (a)

    expect(sink).toEqual([
      { instance: "b", value: 1 },
      { instance: "a", value: 2 },
      { instance: "a", value: 3 },
    ]);
  });
});
