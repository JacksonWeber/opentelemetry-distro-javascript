// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

// Mock the setup modules so we can verify orchestration without side effects
vi.mock("../src/setup/azureMonitor.js", () => ({
  setupAzureMonitor: vi.fn(),
  teardownAzureMonitor: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/setup/otlp.js", () => ({
  setupOtlp: vi.fn(),
  teardownOtlp: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/setup/a365.js", () => ({
  setupA365: vi.fn(),
  teardownA365: vi.fn().mockResolvedValue(undefined),
}));

import {
  useMicrosoftOpenTelemetry,
  shutdownMicrosoftOpenTelemetry,
} from "../src/index.js";
import type {
  MicrosoftOpenTelemetryOptions,
  AzureMonitorOpenTelemetryOptions,
  OtlpOptions,
  A365Options,
} from "../src/index.js";
import { setupAzureMonitor, teardownAzureMonitor } from "../src/setup/azureMonitor.js";
import { setupOtlp, teardownOtlp } from "../src/setup/otlp.js";
import { setupA365, teardownA365 } from "../src/setup/a365.js";

const OTLP_ENV_KEYS = [
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
  "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
  "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
] as const;

function clearAllEnv() {
  delete process.env["APPLICATIONINSIGHTS_CONNECTION_STRING"];
  for (const key of OTLP_ENV_KEYS) {
    delete process.env[key];
  }
}

// ---------------------------------------------------------------------------
// useMicrosoftOpenTelemetry – basic behaviour
// ---------------------------------------------------------------------------
describe("useMicrosoftOpenTelemetry", () => {
  afterEach(() => {
    vi.clearAllMocks();
    clearAllEnv();
  });

  it("should be a callable function", () => {
    expect(typeof useMicrosoftOpenTelemetry).toBe("function");
  });

  it("should return void", () => {
    const result = useMicrosoftOpenTelemetry();
    expect(result).toBeUndefined();
  });

  it("should accept being called with no arguments", () => {
    expect(() => useMicrosoftOpenTelemetry()).not.toThrow();
  });

  it("should accept being called with an empty options object", () => {
    expect(() => useMicrosoftOpenTelemetry({})).not.toThrow();
  });

  it("should not call any setup function when no options and no env var are provided", () => {
    useMicrosoftOpenTelemetry();
    expect(setupAzureMonitor).not.toHaveBeenCalled();
    expect(setupOtlp).not.toHaveBeenCalled();
    expect(setupA365).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Azure Monitor activation
// ---------------------------------------------------------------------------
describe("useMicrosoftOpenTelemetry – Azure Monitor activation", () => {
  afterEach(() => {
    vi.clearAllMocks();
    clearAllEnv();
  });

  it("should not call setupAzureMonitor when no azureMonitor options and no env var", () => {
    useMicrosoftOpenTelemetry({});
    expect(setupAzureMonitor).not.toHaveBeenCalled();
  });

  it("should call setupAzureMonitor when azureMonitor options are provided", () => {
    const azureMonitor: AzureMonitorOpenTelemetryOptions = {
      azureMonitorExporterOptions: {
        connectionString: "InstrumentationKey=test-key",
      },
    };
    useMicrosoftOpenTelemetry({ azureMonitor });
    expect(setupAzureMonitor).toHaveBeenCalledOnce();
    expect(setupAzureMonitor).toHaveBeenCalledWith(azureMonitor);
  });

  it("should call setupAzureMonitor when APPLICATIONINSIGHTS_CONNECTION_STRING env var is set", () => {
    process.env["APPLICATIONINSIGHTS_CONNECTION_STRING"] =
      "InstrumentationKey=env-key";
    useMicrosoftOpenTelemetry();
    expect(setupAzureMonitor).toHaveBeenCalledOnce();
    expect(setupAzureMonitor).toHaveBeenCalledWith(undefined);
  });

  it("should pass azureMonitor options through when both options and env var are set", () => {
    process.env["APPLICATIONINSIGHTS_CONNECTION_STRING"] =
      "InstrumentationKey=env-key";
    const azureMonitor: AzureMonitorOpenTelemetryOptions = {
      azureMonitorExporterOptions: {
        connectionString: "InstrumentationKey=explicit-key",
      },
    };
    useMicrosoftOpenTelemetry({ azureMonitor });
    expect(setupAzureMonitor).toHaveBeenCalledOnce();
    expect(setupAzureMonitor).toHaveBeenCalledWith(azureMonitor);
  });

  it("should call setupAzureMonitor only once per invocation", () => {
    process.env["APPLICATIONINSIGHTS_CONNECTION_STRING"] =
      "InstrumentationKey=env-key";
    useMicrosoftOpenTelemetry({
      azureMonitor: {
        azureMonitorExporterOptions: {
          connectionString: "InstrumentationKey=explicit-key",
        },
      },
    });
    expect(setupAzureMonitor).toHaveBeenCalledOnce();
  });

  it("should treat an empty connection string env var as falsy and not call setupAzureMonitor", () => {
    process.env["APPLICATIONINSIGHTS_CONNECTION_STRING"] = "";
    useMicrosoftOpenTelemetry();
    expect(setupAzureMonitor).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Azure Monitor options pass-through
// ---------------------------------------------------------------------------
describe("useMicrosoftOpenTelemetry – Azure Monitor options pass-through", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("should forward samplingRatio", () => {
    const azureMonitor: AzureMonitorOpenTelemetryOptions = {
      azureMonitorExporterOptions: { connectionString: "InstrumentationKey=k" },
      samplingRatio: 0.5,
    };
    useMicrosoftOpenTelemetry({ azureMonitor });
    expect(setupAzureMonitor).toHaveBeenCalledWith(
      expect.objectContaining({ samplingRatio: 0.5 }),
    );
  });

  it("should forward enableLiveMetrics", () => {
    const azureMonitor: AzureMonitorOpenTelemetryOptions = {
      azureMonitorExporterOptions: { connectionString: "InstrumentationKey=k" },
      enableLiveMetrics: true,
    };
    useMicrosoftOpenTelemetry({ azureMonitor });
    expect(setupAzureMonitor).toHaveBeenCalledWith(
      expect.objectContaining({ enableLiveMetrics: true }),
    );
  });

  it("should forward instrumentationOptions", () => {
    const azureMonitor: AzureMonitorOpenTelemetryOptions = {
      azureMonitorExporterOptions: { connectionString: "InstrumentationKey=k" },
      instrumentationOptions: { http: { enabled: false } },
    };
    useMicrosoftOpenTelemetry({ azureMonitor });
    expect(setupAzureMonitor).toHaveBeenCalledWith(
      expect.objectContaining({
        instrumentationOptions: { http: { enabled: false } },
      }),
    );
  });

  it("should forward disableOfflineStorage", () => {
    const azureMonitor: AzureMonitorOpenTelemetryOptions = {
      azureMonitorExporterOptions: {
        connectionString: "InstrumentationKey=k",
        disableOfflineStorage: true,
      },
    };
    useMicrosoftOpenTelemetry({ azureMonitor });
    expect(setupAzureMonitor).toHaveBeenCalledWith(
      expect.objectContaining({
        azureMonitorExporterOptions: expect.objectContaining({
          disableOfflineStorage: true,
        }),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// OTLP activation
// ---------------------------------------------------------------------------
describe("useMicrosoftOpenTelemetry – OTLP activation", () => {
  afterEach(() => {
    vi.clearAllMocks();
    clearAllEnv();
  });

  it("should not call setupOtlp when otlp options are not provided and no env vars set", () => {
    useMicrosoftOpenTelemetry({});
    expect(setupOtlp).not.toHaveBeenCalled();
  });

  it("should call setupOtlp when otlp options are provided", () => {
    const otlp: OtlpOptions = {
      endpoint: "http://localhost:4317",
      protocol: "grpc",
    };
    useMicrosoftOpenTelemetry({ otlp });
    expect(setupOtlp).toHaveBeenCalledOnce();
    expect(setupOtlp).toHaveBeenCalledWith(otlp);
  });

  it("should forward all OTLP options", () => {
    const otlp: OtlpOptions = {
      endpoint: "http://collector:4318",
      protocol: "http/protobuf",
      headers: { "x-custom": "value" },
      enableTraceExport: true,
      enableMetricExport: false,
      enableLogExport: true,
    };
    useMicrosoftOpenTelemetry({ otlp });
    expect(setupOtlp).toHaveBeenCalledWith(otlp);
  });

  it("should call setupOtlp when OTEL_EXPORTER_OTLP_ENDPOINT is set", () => {
    process.env["OTEL_EXPORTER_OTLP_ENDPOINT"] = "http://localhost:4317";
    useMicrosoftOpenTelemetry();
    expect(setupOtlp).toHaveBeenCalledOnce();
    expect(setupOtlp).toHaveBeenCalledWith({});
  });

  it("should call setupOtlp when OTEL_EXPORTER_OTLP_TRACES_ENDPOINT is set", () => {
    process.env["OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"] =
      "http://localhost:4318/v1/traces";
    useMicrosoftOpenTelemetry();
    expect(setupOtlp).toHaveBeenCalledOnce();
  });

  it("should call setupOtlp when OTEL_EXPORTER_OTLP_METRICS_ENDPOINT is set", () => {
    process.env["OTEL_EXPORTER_OTLP_METRICS_ENDPOINT"] =
      "http://localhost:4318/v1/metrics";
    useMicrosoftOpenTelemetry();
    expect(setupOtlp).toHaveBeenCalledOnce();
  });

  it("should call setupOtlp when OTEL_EXPORTER_OTLP_LOGS_ENDPOINT is set", () => {
    process.env["OTEL_EXPORTER_OTLP_LOGS_ENDPOINT"] =
      "http://localhost:4318/v1/logs";
    useMicrosoftOpenTelemetry();
    expect(setupOtlp).toHaveBeenCalledOnce();
  });

  it("should pass explicit otlp options when both options and env var are set", () => {
    process.env["OTEL_EXPORTER_OTLP_ENDPOINT"] = "http://env-collector:4317";
    const otlp: OtlpOptions = {
      endpoint: "http://explicit-collector:4317",
      protocol: "grpc",
    };
    useMicrosoftOpenTelemetry({ otlp });
    expect(setupOtlp).toHaveBeenCalledOnce();
    expect(setupOtlp).toHaveBeenCalledWith(otlp);
  });

  it("should not call setupOtlp when OTLP env var is set to empty string", () => {
    process.env["OTEL_EXPORTER_OTLP_ENDPOINT"] = "";
    useMicrosoftOpenTelemetry();
    expect(setupOtlp).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// A365 activation (placeholder)
// ---------------------------------------------------------------------------
describe("useMicrosoftOpenTelemetry – A365 activation", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("should not call setupA365 when a365 options are not provided", () => {
    useMicrosoftOpenTelemetry({});
    expect(setupA365).not.toHaveBeenCalled();
  });

  it("should call setupA365 when a365 options are provided", () => {
    const a365: A365Options = {
      endpoint: "https://a365.example.com",
      enableAgentFrameworkInstrumentation: true,
    };
    useMicrosoftOpenTelemetry({ a365 });
    expect(setupA365).toHaveBeenCalledOnce();
    expect(setupA365).toHaveBeenCalledWith(a365);
  });

  it("should forward all A365 options", () => {
    const a365: A365Options = {
      endpoint: "https://a365.example.com",
      enableAgentFrameworkInstrumentation: true,
      enableBaggageExtensions: true,
    };
    useMicrosoftOpenTelemetry({ a365 });
    expect(setupA365).toHaveBeenCalledWith(a365);
  });
});

// ---------------------------------------------------------------------------
// Combined backend activation
// ---------------------------------------------------------------------------
describe("useMicrosoftOpenTelemetry – combined backends", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("should activate Azure Monitor, OTLP, and A365 independently", () => {
    const options: MicrosoftOpenTelemetryOptions = {
      azureMonitor: {
        azureMonitorExporterOptions: { connectionString: "InstrumentationKey=k" },
      },
      otlp: { endpoint: "http://localhost:4317" },
      a365: { endpoint: "https://a365.example.com" },
    };
    useMicrosoftOpenTelemetry(options);
    expect(setupAzureMonitor).toHaveBeenCalledOnce();
    expect(setupOtlp).toHaveBeenCalledOnce();
    expect(setupA365).toHaveBeenCalledOnce();
  });

  it("should activate only the backends that have options set", () => {
    useMicrosoftOpenTelemetry({
      otlp: { endpoint: "http://localhost:4317" },
    });
    expect(setupAzureMonitor).not.toHaveBeenCalled();
    expect(setupOtlp).toHaveBeenCalledOnce();
    expect(setupA365).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// shutdownMicrosoftOpenTelemetry
// ---------------------------------------------------------------------------
describe("shutdownMicrosoftOpenTelemetry", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("should be a callable function", () => {
    expect(typeof shutdownMicrosoftOpenTelemetry).toBe("function");
  });

  it("should return a promise", () => {
    const result = shutdownMicrosoftOpenTelemetry();
    expect(result).toBeInstanceOf(Promise);
  });

  it("should call all teardown functions", async () => {
    await shutdownMicrosoftOpenTelemetry();
    expect(teardownAzureMonitor).toHaveBeenCalledOnce();
    expect(teardownOtlp).toHaveBeenCalledOnce();
    expect(teardownA365).toHaveBeenCalledOnce();
  });

  it("should resolve when all teardowns resolve", async () => {
    await expect(shutdownMicrosoftOpenTelemetry()).resolves.toBeUndefined();
  });

  it("should propagate rejection from teardownAzureMonitor", async () => {
    vi.mocked(teardownAzureMonitor).mockRejectedValueOnce(
      new Error("azure shutdown failure"),
    );
    await expect(shutdownMicrosoftOpenTelemetry()).rejects.toThrow(
      "azure shutdown failure",
    );
  });

  it("should propagate rejection from teardownOtlp", async () => {
    vi.mocked(teardownOtlp).mockRejectedValueOnce(
      new Error("otlp shutdown failure"),
    );
    await expect(shutdownMicrosoftOpenTelemetry()).rejects.toThrow(
      "otlp shutdown failure",
    );
  });

  it("should propagate rejection from teardownA365", async () => {
    vi.mocked(teardownA365).mockRejectedValueOnce(
      new Error("a365 shutdown failure"),
    );
    await expect(shutdownMicrosoftOpenTelemetry()).rejects.toThrow(
      "a365 shutdown failure",
    );
  });
});

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------
describe("module exports", () => {
  it("should export useMicrosoftOpenTelemetry", async () => {
    const mod = await import("../src/index.js");
    expect(mod.useMicrosoftOpenTelemetry).toBeDefined();
  });

  it("should export shutdownMicrosoftOpenTelemetry", async () => {
    const mod = await import("../src/index.js");
    expect(mod.shutdownMicrosoftOpenTelemetry).toBeDefined();
  });

  it("should not export internal setup functions directly", async () => {
    const mod = await import("../src/index.js");
    const exports = mod as Record<string, unknown>;
    expect(exports["setupAzureMonitor"]).toBeUndefined();
    expect(exports["setupOtlp"]).toBeUndefined();
    expect(exports["setupA365"]).toBeUndefined();
    expect(exports["useAzureMonitor"]).toBeUndefined();
    expect(exports["shutdownAzureMonitor"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Multiple invocations
// ---------------------------------------------------------------------------
describe("useMicrosoftOpenTelemetry – multiple invocations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearAllEnv();
  });

  it("should allow calling use multiple times", () => {
    const options: MicrosoftOpenTelemetryOptions = {
      azureMonitor: {
        azureMonitorExporterOptions: { connectionString: "InstrumentationKey=k" },
      },
    };
    useMicrosoftOpenTelemetry(options);
    useMicrosoftOpenTelemetry(options);
    expect(setupAzureMonitor).toHaveBeenCalledTimes(2);
  });

  it("should forward different options on each call", () => {
    const first: MicrosoftOpenTelemetryOptions = {
      azureMonitor: {
        azureMonitorExporterOptions: { connectionString: "InstrumentationKey=k1" },
        samplingRatio: 0.1,
      },
    };
    const second: MicrosoftOpenTelemetryOptions = {
      azureMonitor: {
        azureMonitorExporterOptions: { connectionString: "InstrumentationKey=k2" },
        samplingRatio: 0.9,
      },
    };
    useMicrosoftOpenTelemetry(first);
    useMicrosoftOpenTelemetry(second);
    expect(setupAzureMonitor).toHaveBeenNthCalledWith(1, first.azureMonitor);
    expect(setupAzureMonitor).toHaveBeenNthCalledWith(2, second.azureMonitor);
  });
});
