// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { azureAppServiceDetector } from "@opentelemetry/resource-detector-azure";
import {
  detectResources,
  envDetector,
  osDetector,
  resourceFromAttributes,
  serviceInstanceIdDetector,
} from "@opentelemetry/resources";
import type { Resource } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getCloudRoleInstance } from "../../../../src/azureMonitor/metrics/utils.js";
import { parseResourceDetectorsFromEnvVar } from "../../../../src/utils/common.js";

const execFileAsync = promisify(execFile);
const originalResourceDetectors = process.env.OTEL_NODE_RESOURCE_DETECTORS;

async function settle(resource: Resource): Promise<Resource> {
  await resource.waitForAsyncAttributes?.();
  return resource;
}

describe("service.instance.id compatibility contracts", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    if (originalResourceDetectors === undefined) {
      delete process.env.OTEL_NODE_RESOURCE_DETECTORS;
    } else {
      process.env.OTEL_NODE_RESOURCE_DETECTORS = originalResourceDetectors;
    }
  });

  it("keeps generated service instance IDs opt-in in the distro defaults", async () => {
    delete process.env.OTEL_NODE_RESOURCE_DETECTORS;
    vi.stubEnv("OTEL_RESOURCE_ATTRIBUTES", "");
    vi.stubEnv("OTEL_SERVICE_NAME", "");

    const detectors = parseResourceDetectorsFromEnvVar();
    const resource = await settle(detectResources({ detectors }));

    expect(detectors).toEqual([envDetector, osDetector]);
    expect(resource.attributes).not.toHaveProperty("service.instance.id");
  });

  it("allows environment configuration to override a generated service instance ID", async () => {
    vi.stubEnv("OTEL_RESOURCE_ATTRIBUTES", "service.instance.id=configured-instance");

    const resource = await settle(
      detectResources({
        detectors: [serviceInstanceIdDetector, envDetector],
      }),
    );

    expect(resource.attributes["service.instance.id"]).toBe("configured-instance");
  });

  it("allows an Azure detector to override a generated service instance ID", async () => {
    vi.stubEnv("WEBSITE_SITE_NAME", "orders-api");
    vi.stubEnv("WEBSITE_INSTANCE_ID", "azure-instance");

    const resource = await settle(
      detectResources({
        detectors: [serviceInstanceIdDetector, azureAppServiceDetector],
      }),
    );

    expect(resource.attributes["service.instance.id"]).toBe("azure-instance");
  });

  it("preserves an initial service instance ID through the distro's default NodeSDK detection", async () => {
    delete process.env.OTEL_NODE_RESOURCE_DETECTORS;
    vi.stubEnv("OTEL_RESOURCE_ATTRIBUTES", "");
    const sdk = new NodeSDK({
      autoDetectResources: true,
      instrumentations: [],
      logRecordProcessors: [],
      metricReaders: [],
      resource: resourceFromAttributes({
        "service.instance.id": "initial-instance",
      }),
      resourceDetectors: parseResourceDetectorsFromEnvVar(),
      spanProcessors: [],
    });

    try {
      sdk.start();
      const sdkResource = (sdk as unknown as { _resource: Resource })._resource;
      await settle(sdkResource);
      expect(sdkResource.attributes["service.instance.id"]).toBe("initial-instance");
    } finally {
      await sdk.shutdown();
    }
  });

  it("keeps a configured environment ID stable across repeated detection", async () => {
    vi.stubEnv("OTEL_RESOURCE_ATTRIBUTES", "service.instance.id=configured-instance");

    const first = await settle(
      detectResources({ detectors: [serviceInstanceIdDetector, envDetector] }),
    );
    const second = await settle(
      detectResources({ detectors: [serviceInstanceIdDetector, envDetector] }),
    );

    expect(first.attributes["service.instance.id"]).toBe("configured-instance");
    expect(second.attributes["service.instance.id"]).toBe("configured-instance");
  });

  it("gives the Kubernetes pod identity precedence when deriving cloud role instance", () => {
    const resource = resourceFromAttributes({
      "k8s.pod.name": "orders-api-7b8f9c6d5-x2k9m",
      "service.instance.id": "generated-or-vm-instance",
    });

    expect(getCloudRoleInstance(resource)).toBe("orders-api-7b8f9c6d5-x2k9m");
  });

  it("falls back to service instance ID when Kubernetes pod identity is unavailable", () => {
    const resource = resourceFromAttributes({
      "service.instance.id": "configured-instance",
    });

    expect(getCloudRoleInstance(resource)).toBe("configured-instance");
  });

  it("generates fresh instance IDs and process IDs in separate worker processes", async () => {
    const script = `
      const resources = require("@opentelemetry/resources");
      const resource = resources.detectResources({
        detectors: [resources.processDetector, resources.serviceInstanceIdDetector],
      });
      Promise.resolve(resource.waitForAsyncAttributes?.()).then(() => {
        console.log(JSON.stringify({
          actualPid: process.pid,
          detectedPid: resource.attributes["process.pid"],
          instanceId: resource.attributes["service.instance.id"],
        }));
      });
    `;

    const [firstResult, secondResult] = await Promise.all([
      execFileAsync(process.execPath, ["-e", script], { cwd: process.cwd() }),
      execFileAsync(process.execPath, ["-e", script], { cwd: process.cwd() }),
    ]);
    const first = JSON.parse(firstResult.stdout.trim()) as {
      actualPid: number;
      detectedPid: number;
      instanceId: string;
    };
    const second = JSON.parse(secondResult.stdout.trim()) as typeof first;

    expect(first.detectedPid).toBe(first.actualPid);
    expect(second.detectedPid).toBe(second.actualPid);
    expect(first.actualPid).not.toBe(second.actualPid);
    expect(first.instanceId).not.toBe(second.instanceId);
  });
});
