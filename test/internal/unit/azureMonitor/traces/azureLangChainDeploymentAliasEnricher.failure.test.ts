// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, assert, beforeEach, describe, it, vi } from "vitest";

// Module-level mock: simulate `registerSpanEnricher` throwing (e.g. because
// the GenAI registry module failed to load or threw on registration). This
// is the explicit "best-effort" failure path that
// `registerAzureLangChainDeploymentAliasEnricher` must handle gracefully so
// an unloadable GenAI integration cannot break the Azure Monitor pipeline.
vi.mock("../../../../../src/genai/index.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    "../../../../../src/genai/index.js",
  );
  return {
    ...actual,
    registerSpanEnricher: vi.fn(() => {
      throw new Error("simulated registry load failure");
    }),
  };
});

describe("registerAzureLangChainDeploymentAliasEnricher (failure path)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let warnSpy: any;

  beforeEach(async () => {
    const { Logger } = await import("../../../../../src/shared/logging/index.js");
    warnSpy = vi.spyOn(Logger.getInstance(), "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy?.mockRestore();
    vi.restoreAllMocks();
  });

  it("returns undefined and logs a warning when registerSpanEnricher throws", async () => {
    const { registerAzureLangChainDeploymentAliasEnricher } =
      await import("../../../../../src/azureMonitor/traces/azureLangChainDeploymentAliasEnricher.js");

    const result = registerAzureLangChainDeploymentAliasEnricher();

    assert.strictEqual(
      result,
      undefined,
      "helper must return undefined when registration fails so callers can keep going",
    );
    assert.strictEqual(warnSpy.mock.calls.length, 1, "exactly one warning is logged");
    const [message, error] = warnSpy.mock.calls[0] as [string, unknown];
    assert.match(message, /Azure LangChain deployment-alias enricher/);
    assert.ok(error instanceof Error);
    assert.strictEqual((error as Error).message, "simulated registry load failure");
  });
});
