// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, describe, expect, it, vi } from "vitest";
import * as opentelemetry from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import type { HttpClient, PipelineRequest } from "@azure/core-rest-pipeline";

// Wrap registerInstrumentations so the test can observe how each instance binds
// its own instrumentation set to its own providers, while still performing the
// real registration.
vi.mock("@opentelemetry/instrumentation", async (importActual) => {
  const actual = await importActual<typeof import("@opentelemetry/instrumentation")>();
  return { ...actual, registerInstrumentations: vi.fn(actual.registerInstrumentations) };
});

import {
  createMicrosoftOpenTelemetryInstance,
  runWithMicrosoftOpenTelemetryInstance,
} from "../../../src/distro/index.js";
import type { MicrosoftOpenTelemetryInstance } from "../../../src/distro/index.js";
import { _resetRegistry } from "../../../src/distro/multiInstance/instanceRegistry.js";
import { _resetGlobalSetup } from "../../../src/distro/multiInstance/globalSetup.js";
import { successfulBreezeResponse } from "../../utils/breezeTestUtils.js";
import type { TelemetryItem as Envelope } from "../../utils/models/index.js";

const IKEY_A = "11111111-1111-1111-1111-111111111111";
const IKEY_B = "22222222-2222-2222-2222-222222222222";
const CONNECTION_STRING_A = `InstrumentationKey=${IKEY_A};IngestionEndpoint=https://westus2-2.in.applicationinsights.azure.com/;LiveEndpoint=https://westus2.livediagnostics.monitor.azure.com/;ApplicationId=11111111-1111-1111-1111-aaaaaaaaaaaa`;
const CONNECTION_STRING_B = `InstrumentationKey=${IKEY_B};IngestionEndpoint=https://westus2-2.in.applicationinsights.azure.com/;LiveEndpoint=https://westus2.livediagnostics.monitor.azure.com/;ApplicationId=22222222-2222-2222-2222-bbbbbbbbbbbb`;

/** Build an HttpClient that records every breeze envelope it receives. */
function recordingHttpClient(sink: Envelope[]): HttpClient {
  return {
    sendRequest: vi.fn().mockImplementation((request: PipelineRequest) => {
      const envelopes = JSON.parse(request.body as string) as Envelope[];
      sink.push(...envelopes);
      return Promise.resolve({
        headers: request.headers,
        request,
        status: 200,
        bodyAsText: JSON.stringify(successfulBreezeResponse(envelopes.length)),
      });
    }),
  };
}

/** Names of the span (Request/RemoteDependency) envelopes captured by a sink. */
function spanNames(envelopes: Envelope[]): string[] {
  return envelopes
    .filter((e) => e.name?.endsWith("Request") || e.name?.endsWith("RemoteDependency"))
    .map((e) => (e.data?.baseData as { name?: string } | undefined)?.name)
    .filter((n): n is string => typeof n === "string");
}

function makeInstance(
  connectionString: string,
  httpClient: HttpClient,
  instrumentationOptions?: Record<string, unknown>,
): MicrosoftOpenTelemetryInstance {
  return createMicrosoftOpenTelemetryInstance({
    // Use the deterministic ratio sampler (always-on) instead of the default
    // rate limiter so the test is reliable.
    tracesPerSecond: 0,
    samplingRatio: 1,
    ...(instrumentationOptions ? { instrumentationOptions: instrumentationOptions as never } : {}),
    // Keep only the span pipeline active so the test is deterministic and offline.
    azureMonitor: {
      enableLiveMetrics: false,
      enableStandardMetrics: false,
      enablePerformanceCounters: false,
      azureMonitorExporterOptions: { connectionString, httpClient },
    },
  });
}

describe("Multiple SDK instances in one runtime", () => {
  let instanceA: MicrosoftOpenTelemetryInstance | undefined;
  let instanceB: MicrosoftOpenTelemetryInstance | undefined;

  afterEach(async () => {
    await instanceA?.shutdown();
    await instanceB?.shutdown();
    instanceA = undefined;
    instanceB = undefined;
    _resetRegistry();
    _resetGlobalSetup();
    // Disable every global the multi-instance setup installs (trace, metrics,
    // logs, and the AsyncLocalStorage context manager) so state does not leak
    // into other tests sharing this Vitest worker.
    opentelemetry.trace.disable();
    opentelemetry.metrics.disable();
    opentelemetry.context.disable();
    logs.disable();
  });

  it("routes each instance's telemetry only to its own Azure Monitor resource", async () => {
    const ingestA: Envelope[] = [];
    const ingestB: Envelope[] = [];

    instanceA = makeInstance(CONNECTION_STRING_A, recordingHttpClient(ingestA));
    instanceB = makeInstance(CONNECTION_STRING_B, recordingHttpClient(ingestB));

    // Spans created via each instance's own tracer.
    instanceA.getTracer("test").startSpan("alpha-span").end();
    instanceB.getTracer("test").startSpan("beta-span").end();

    await instanceA.forceFlush();
    await instanceB.forceFlush();

    // Each sink saw only its own span.
    expect(spanNames(ingestA)).toContain("alpha-span");
    expect(spanNames(ingestA)).not.toContain("beta-span");
    expect(spanNames(ingestB)).toContain("beta-span");
    expect(spanNames(ingestB)).not.toContain("alpha-span");

    // Each sink's envelopes are tagged only with its own instrumentation key.
    expect(ingestA.length).toBeGreaterThan(0);
    expect(ingestB.length).toBeGreaterThan(0);
    expect(ingestA.every((e) => e.iKey === IKEY_A)).toBe(true);
    expect(ingestB.every((e) => e.iKey === IKEY_B)).toBe(true);
  });

  it("routes global-API telemetry to the ambient instance bound via runWithInstance", async () => {
    const ingestA: Envelope[] = [];
    const ingestB: Envelope[] = [];

    instanceA = makeInstance(CONNECTION_STRING_A, recordingHttpClient(ingestA));
    instanceB = makeInstance(CONNECTION_STRING_B, recordingHttpClient(ingestB));

    // Code that uses the global OpenTelemetry API (no handle) routes to whichever
    // instance is bound as the ambient current instance.
    runWithMicrosoftOpenTelemetryInstance(instanceA.id, () => {
      opentelemetry.trace.getTracer("global").startSpan("global-into-a").end();
    });
    runWithMicrosoftOpenTelemetryInstance(instanceB.id, () => {
      opentelemetry.trace.getTracer("global").startSpan("global-into-b").end();
    });

    await instanceA.forceFlush();
    await instanceB.forceFlush();

    expect(spanNames(ingestA)).toContain("global-into-a");
    expect(spanNames(ingestA)).not.toContain("global-into-b");
    expect(spanNames(ingestB)).toContain("global-into-b");
    expect(spanNames(ingestB)).not.toContain("global-into-a");
  });

  it("binds a different instrumentation set per exporter", async () => {
    const mockRegister = vi.mocked(registerInstrumentations);
    mockRegister.mockClear();

    const ingestA: Envelope[] = [];
    const ingestB: Envelope[] = [];

    // Instance A enables the HTTP instrumentation; instance B disables it. This
    // models the prioritized scenario: a customer registers different
    // OpenTelemetry instrumentations for the Azure Monitor exporter than for the
    // second (A365/OTLP) exporter, in the same runtime.
    instanceA = makeInstance(CONNECTION_STRING_A, recordingHttpClient(ingestA), {
      http: { enabled: true },
    });
    instanceB = makeInstance(CONNECTION_STRING_B, recordingHttpClient(ingestB), {
      http: { enabled: false },
    });

    // Each instance registered its own instrumentation set against its own
    // providers.
    const registrations = mockRegister.mock.calls.map((args) => ({
      names: (args[0].instrumentations ?? [])
        .flat()
        .map((i) => (i as { instrumentationName: string }).instrumentationName),
      tracerProvider: args[0].tracerProvider,
    }));
    expect(registrations.length).toBe(2);

    const HTTP = "@opentelemetry/instrumentation-http";
    const withHttp = registrations.filter((r) => r.names.includes(HTTP));
    const withoutHttp = registrations.filter((r) => !r.names.includes(HTTP));

    // Exactly one instance (A) bound the HTTP instrumentation; the other (B)
    // did not — different instrumentation sets per exporter.
    expect(withHttp.length).toBe(1);
    expect(withoutHttp.length).toBe(1);

    // The two instances bound their instrumentations to distinct tracer
    // providers, so each instrumentation's telemetry reaches only its own
    // exporter.
    expect(registrations[0].tracerProvider).toBeDefined();
    expect(registrations[1].tracerProvider).toBeDefined();
    expect(registrations[0].tracerProvider).not.toBe(registrations[1].tracerProvider);
  });
});
