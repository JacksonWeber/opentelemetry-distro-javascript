// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { metrics, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { describe, it, beforeEach, afterEach, afterAll, expect, vi } from "vitest";
import { ObservabilityManager } from "@microsoft/agents-a365-observability";
import {
  useMicrosoftOpenTelemetry,
  shutdownMicrosoftOpenTelemetry,
} from "../../../src/distro/distro.js";

// Env var names used by the A365 integration
const ENV_A365_EXPORTER = "ENABLE_A365_OBSERVABILITY_EXPORTER";
const ENV_A365_PER_REQUEST = "ENABLE_A365_OBSERVABILITY_PER_REQUEST_EXPORT";
const ENV_A365_DOMAIN = "A365_OBSERVABILITY_DOMAIN_OVERRIDE";

const GLOBAL_OPENTELEMETRY_API_KEY = Symbol.for("opentelemetry.js.api.1");

const TEST_CONNECTION_STRING = "InstrumentationKey=00000000-0000-0000-0000-000000000000";

// Mock ObservabilityManager.start so we can assert calls without side effects
vi.mock("@microsoft/agents-a365-observability", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    ObservabilityManager: {
      start: vi.fn(),
    },
  };
});

describe("A365 integration in distro", () => {
  let savedEnv: Record<string, string | undefined>;
  let savedOTelGlobal: unknown;

  beforeEach(() => {
    savedEnv = {
      [ENV_A365_EXPORTER]: process.env[ENV_A365_EXPORTER],
      [ENV_A365_PER_REQUEST]: process.env[ENV_A365_PER_REQUEST],
      [ENV_A365_DOMAIN]: process.env[ENV_A365_DOMAIN],
    };
    savedOTelGlobal = (globalThis as Record<symbol, unknown>)[GLOBAL_OPENTELEMETRY_API_KEY];
    // Clean slate
    delete process.env[ENV_A365_EXPORTER];
    delete process.env[ENV_A365_PER_REQUEST];
    delete process.env[ENV_A365_DOMAIN];
    vi.clearAllMocks();
  });

  afterEach(async () => {
    // Restore env
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = val;
      }
    }
    // Restore the global OTel API object
    if (savedOTelGlobal === undefined) {
      delete (globalThis as Record<symbol, unknown>)[GLOBAL_OPENTELEMETRY_API_KEY];
    } else {
      (globalThis as Record<symbol, unknown>)[GLOBAL_OPENTELEMETRY_API_KEY] = savedOTelGlobal;
    }
    // Shutdown to avoid provider leaks
    try {
      await shutdownMicrosoftOpenTelemetry();
    } catch {
      // ignore if not initialized
    }
  });

  afterAll(() => {
    trace.disable();
    metrics.disable();
    logs.disable();
  });

  it("does not call ObservabilityManager.start when a365 is not enabled", () => {
    useMicrosoftOpenTelemetry({
      azureMonitor: {
        azureMonitorExporterOptions: {
          connectionString: TEST_CONNECTION_STRING,
        },
      },
    });
    expect(ObservabilityManager.start).not.toHaveBeenCalled();
  });

  it("calls ObservabilityManager.start when options.a365.enabled is true", () => {
    const tokenResolver = vi.fn().mockResolvedValue("token");
    useMicrosoftOpenTelemetry({
      azureMonitor: {
        azureMonitorExporterOptions: {
          connectionString: TEST_CONNECTION_STRING,
        },
      },
      a365: {
        enabled: true,
        tokenResolver,
        clusterCategory: "dev",
      },
    });
    expect(ObservabilityManager.start).toHaveBeenCalledOnce();
    expect(ObservabilityManager.start).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenResolver,
        clusterCategory: "dev",
      }),
    );
  });

  it("calls ObservabilityManager.start when env var is set to true", () => {
    process.env[ENV_A365_EXPORTER] = "true";
    useMicrosoftOpenTelemetry({
      azureMonitor: {
        azureMonitorExporterOptions: {
          connectionString: TEST_CONNECTION_STRING,
        },
      },
    });
    expect(ObservabilityManager.start).toHaveBeenCalledOnce();
  });

  it("env var false overrides programmatic enabled: true", () => {
    process.env[ENV_A365_EXPORTER] = "false";
    useMicrosoftOpenTelemetry({
      azureMonitor: {
        azureMonitorExporterOptions: {
          connectionString: TEST_CONNECTION_STRING,
        },
      },
      a365: {
        enabled: true,
      },
    });
    expect(ObservabilityManager.start).not.toHaveBeenCalled();
  });

  it("sets per-request env var from options when not already set", () => {
    useMicrosoftOpenTelemetry({
      azureMonitor: {
        azureMonitorExporterOptions: {
          connectionString: TEST_CONNECTION_STRING,
        },
      },
      a365: {
        enabled: true,
        perRequestExport: true,
      },
    });
    expect(process.env[ENV_A365_PER_REQUEST]).toBe("true");
  });

  it("does not overwrite per-request env var when already set", () => {
    process.env[ENV_A365_PER_REQUEST] = "false";
    useMicrosoftOpenTelemetry({
      azureMonitor: {
        azureMonitorExporterOptions: {
          connectionString: TEST_CONNECTION_STRING,
        },
      },
      a365: {
        enabled: true,
        perRequestExport: true,
      },
    });
    expect(process.env[ENV_A365_PER_REQUEST]).toBe("false");
  });

  it("passes configProvider when domainOverride is specified", () => {
    useMicrosoftOpenTelemetry({
      azureMonitor: {
        azureMonitorExporterOptions: {
          connectionString: TEST_CONNECTION_STRING,
        },
      },
      a365: {
        enabled: true,
        domainOverride: "https://custom.domain.com",
      },
    });
    expect(ObservabilityManager.start).toHaveBeenCalledWith(
      expect.objectContaining({
        configProvider: expect.objectContaining({
          getConfiguration: expect.any(Function),
        }),
      }),
    );
  });
});
