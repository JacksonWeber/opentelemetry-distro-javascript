// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import type { ClientRequest, IncomingMessage } from "node:http";
import {
  azureAksDetector,
  azureAppServiceDetector,
  azureContainerAppsDetector,
  azureFunctionsDetector,
  azureVmDetector,
} from "@opentelemetry/resource-detector-azure";
import { detectResources } from "@opentelemetry/resources";
import type { ResourceDetector } from "@opentelemetry/resources";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalEnv = { ...process.env };
const azureEnvironmentVariables = [
  "CLUSTER_RESOURCE_ID",
  "CONTAINER_APP_ENV_DNS_SUFFIX",
  "CONTAINER_APP_HOSTNAME",
  "CONTAINER_APP_NAME",
  "CONTAINER_APP_PORT",
  "CONTAINER_APP_REPLICA_NAME",
  "CONTAINER_APP_REVISION",
  "FUNCTIONS_EXTENSION_VERSION",
  "REGION_NAME",
  "WEBSITE_HOME_STAMPNAME",
  "WEBSITE_HOSTNAME",
  "WEBSITE_INSTANCE_ID",
  "WEBSITE_MEMORY_LIMIT_MB",
  "WEBSITE_OWNER_NAME",
  "WEBSITE_RESOURCE_GROUP",
  "WEBSITE_SITE_NAME",
  "WEBSITE_SKU",
  "WEBSITE_SLOT_NAME",
] as const;

async function detect(detector: ResourceDetector) {
  const resource = detectResources({ detectors: [detector] });
  await resource.waitForAsyncAttributes?.();
  return resource.attributes;
}

function mockVmRequest(
  result: { body: string; statusCode: number } | { error: Error },
  onOptions?: (options: unknown) => void,
) {
  return vi.spyOn(http, "request").mockImplementation(((
    options: unknown,
    callback: (response: IncomingMessage) => void,
  ) => {
    onOptions?.(options);
    const request = new EventEmitter() as ClientRequest;
    request.destroy = vi.fn();
    request.end = () => {
      queueMicrotask(() => {
        if ("error" in result) {
          request.emit("error", result.error);
          return;
        }

        const response = new EventEmitter() as IncomingMessage;
        response.statusCode = result.statusCode;
        response.setEncoding = vi.fn();
        callback(response);
        response.emit("data", result.body);
        response.emit("end");
      });
      return request;
    };
    return request;
  }) as unknown as typeof http.request);
}

describe("@opentelemetry/resource-detector-azure contracts", () => {
  beforeEach(() => {
    for (const name of azureEnvironmentVariables) {
      delete process.env[name];
    }
    delete process.env.OTEL_NODE_RESOURCE_DETECTORS;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it.each([
    ["App Service", azureAppServiceDetector],
    ["Container Apps", azureContainerAppsDetector],
    ["Functions", azureFunctionsDetector],
  ])("returns no %s attributes outside its Azure environment", async (_name, detector) => {
    await expect(detect(detector)).resolves.toEqual({});
  });

  it("returns no AKS attributes without environment or mounted metadata", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);

    await expect(detect(azureAksDetector)).resolves.toEqual({});
  });

  it("detects a minimal Azure App Service environment without inventing optional attributes", async () => {
    vi.stubEnv("WEBSITE_SITE_NAME", "minimal-api");

    await expect(detect(azureAppServiceDetector)).resolves.toEqual({
      "cloud.platform": "azure.app_service",
      "cloud.provider": "azure",
      "service.name": "minimal-api",
    });
  });

  it("detects Azure App Service attributes and its ARM resource ID", async () => {
    vi.stubEnv("WEBSITE_SITE_NAME", "orders-api");
    vi.stubEnv("WEBSITE_OWNER_NAME", "subscription-id+hosting-plan");
    vi.stubEnv("WEBSITE_RESOURCE_GROUP", "production-rg");
    vi.stubEnv("REGION_NAME", "westus3");
    vi.stubEnv("WEBSITE_SLOT_NAME", "staging");
    vi.stubEnv("WEBSITE_HOSTNAME", "orders-api.azurewebsites.net");
    vi.stubEnv("WEBSITE_INSTANCE_ID", "instance-1");
    vi.stubEnv("WEBSITE_HOME_STAMPNAME", "stamp-1");

    await expect(detect(azureAppServiceDetector)).resolves.toEqual({
      "azure.app.service.stamp": "stamp-1",
      "cloud.platform": "azure.app_service",
      "cloud.provider": "azure",
      "cloud.region": "westus3",
      "cloud.resource_id":
        "/subscriptions/subscription-id/resourceGroups/production-rg/providers/Microsoft.Web/sites/orders-api",
      "deployment.environment.name": "staging",
      "host.id": "orders-api.azurewebsites.net",
      "service.instance.id": "instance-1",
      "service.name": "orders-api",
    });
  });

  it("keeps Azure Container Apps mutually exclusive from App Service", async () => {
    vi.stubEnv("WEBSITE_SITE_NAME", "container-backed-site");
    vi.stubEnv("CONTAINER_APP_NAME", "checkout");
    vi.stubEnv("CONTAINER_APP_REVISION", "checkout--0000042");
    vi.stubEnv("CONTAINER_APP_HOSTNAME", "checkout.internal.example");
    vi.stubEnv("CONTAINER_APP_ENV_DNS_SUFFIX", "internal.example");
    vi.stubEnv("CONTAINER_APP_PORT", "8080");
    vi.stubEnv("CONTAINER_APP_REPLICA_NAME", "checkout--0000042-abcd");

    await expect(detect(azureAppServiceDetector)).resolves.toEqual({});
  });

  it("keeps Azure Functions mutually exclusive from App Service", async () => {
    vi.stubEnv("WEBSITE_SITE_NAME", "thumbnail-function");
    vi.stubEnv("FUNCTIONS_EXTENSION_VERSION", "~4");
    vi.stubEnv("WEBSITE_INSTANCE_ID", "function-instance");
    vi.stubEnv("WEBSITE_MEMORY_LIMIT_MB", "1536");
    vi.stubEnv("REGION_NAME", "eastus2");
    vi.stubEnv("WEBSITE_OWNER_NAME", "subscription-id");
    vi.stubEnv("WEBSITE_RESOURCE_GROUP", "functions-rg");

    await expect(detect(azureAppServiceDetector)).resolves.toEqual({});
    await expect(detect(azureFunctionsDetector)).resolves.toEqual({
      "cloud.platform": "azure.functions",
      "cloud.provider": "azure",
      "cloud.region": "eastus2",
      "cloud.resource_id":
        "/subscriptions/subscription-id/resourceGroups/functions-rg/providers/Microsoft.Web/sites/thumbnail-function",
      "faas.instance": "function-instance",
      "faas.max_memory": "1536",
      "process.pid": process.pid,
      "service.name": "thumbnail-function",
    });
  });

  it("detects Flex Consumption as Azure Functions without FUNCTIONS_EXTENSION_VERSION", async () => {
    vi.stubEnv("WEBSITE_SITE_NAME", "flex-function");
    vi.stubEnv("WEBSITE_SKU", "FlexConsumption");

    await expect(detect(azureFunctionsDetector)).resolves.toEqual({
      "cloud.platform": "azure.functions",
      "cloud.provider": "azure",
      "cloud.region": undefined,
      "process.pid": process.pid,
      "service.name": "flex-function",
    });
  });

  it("requires a site name even when the Azure Functions runtime marker exists", async () => {
    vi.stubEnv("FUNCTIONS_EXTENSION_VERSION", "~4");

    await expect(detect(azureFunctionsDetector)).resolves.toEqual({});
  });

  function stubCompleteContainerAppsEnvironment() {
    vi.stubEnv("CONTAINER_APP_NAME", "checkout");
    vi.stubEnv("CONTAINER_APP_REVISION", "checkout--0000042");
    vi.stubEnv("CONTAINER_APP_HOSTNAME", "checkout.internal.example");
    vi.stubEnv("CONTAINER_APP_ENV_DNS_SUFFIX", "internal.example");
    vi.stubEnv("CONTAINER_APP_PORT", "8080");
    vi.stubEnv("CONTAINER_APP_REPLICA_NAME", "checkout--0000042-abcd");
  }

  it("detects Azure Container Apps from the complete platform signature", async () => {
    stubCompleteContainerAppsEnvironment();

    await expect(detect(azureContainerAppsDetector)).resolves.toEqual({
      "azure.container_app.instance.id": "checkout--0000042-abcd",
      "azure.container_app.name": "checkout",
      "azure.container_app.version": "checkout--0000042",
      "cloud.platform": "azure.container_apps",
      "cloud.provider": "azure",
      "host.name": "checkout.internal.example",
    });
  });

  it.each([
    "CONTAINER_APP_NAME",
    "CONTAINER_APP_REVISION",
    "CONTAINER_APP_HOSTNAME",
    "CONTAINER_APP_ENV_DNS_SUFFIX",
    "CONTAINER_APP_PORT",
    "CONTAINER_APP_REPLICA_NAME",
  ])("requires %s before identifying Azure Container Apps", async (missingVariable) => {
    stubCompleteContainerAppsEnvironment();
    delete process.env[missingVariable];

    await expect(detect(azureContainerAppsDetector)).resolves.toEqual({});
  });

  it("extracts the AKS cluster name from the native metadata resource ID", async () => {
    const resourceId =
      "/subscriptions/subscription-id/resourceGroups/aks-rg/providers/Microsoft.ContainerService/managedClusters/production-aks";
    vi.stubEnv("CLUSTER_RESOURCE_ID", resourceId);

    await expect(detect(azureAksDetector)).resolves.toEqual({
      "cloud.platform": "azure.aks",
      "cloud.provider": "azure",
      "cloud.resource_id": resourceId,
      "k8s.cluster.name": "production-aks",
    });
  });

  it("falls back to the final resource ID segment for nonstandard AKS IDs", async () => {
    vi.stubEnv("CLUSTER_RESOURCE_ID", "/custom/cluster/resource/nonstandard-aks");

    await expect(detect(azureAksDetector)).resolves.toMatchObject({
      "cloud.resource_id": "/custom/cluster/resource/nonstandard-aks",
      "k8s.cluster.name": "nonstandard-aks",
    });
  });

  it("reads AKS metadata from the mounted ConfigMap when the environment variable is absent", async () => {
    const resourceId =
      "/subscriptions/subscription-id/resourceGroups/aks-rg/providers/Microsoft.ContainerService/managedClusters/file-backed-aks";
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      `# generated metadata\nclusterResourceId=${resourceId}\n`,
    );

    await expect(detect(azureAksDetector)).resolves.toEqual({
      "cloud.platform": "azure.aks",
      "cloud.provider": "azure",
      "cloud.resource_id": resourceId,
      "k8s.cluster.name": "file-backed-aks",
    });
  });

  it("ignores unreadable AKS metadata files", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      throw new Error("permission denied");
    });

    await expect(detect(azureAksDetector)).resolves.toEqual({});
  });

  const vmMetadata = {
    location: "centralus",
    name: "worker-01",
    resourceId:
      "/subscriptions/subscription-id/resourceGroups/vm-rg/providers/Microsoft.Compute/virtualMachines/worker-01",
    sku: "2022-datacenter",
    version: "10.0.20348",
    vmId: "f4f6a51f-327d-4a55-97d1-94ed92f64018",
    vmScaleSetName: "workers",
    vmSize: "Standard_D4s_v5",
  };

  it("requests and resolves Azure VM metadata through asynchronous resource attributes", async () => {
    let requestOptions: unknown;
    mockVmRequest(
      { body: JSON.stringify(vmMetadata), statusCode: 200 },
      (options) => (requestOptions = options),
    );

    await expect(detect(azureVmDetector)).resolves.toEqual({
      "azure.vm.scaleset.name": "workers",
      "azure.vm.sku": "2022-datacenter",
      "cloud.platform": "azure.vm",
      "cloud.provider": "azure",
      "cloud.region": "centralus",
      "cloud.resource_id": vmMetadata.resourceId,
      "host.id": vmMetadata.vmId,
      "host.name": vmMetadata.name,
      "host.type": vmMetadata.vmSize,
      "os.version": vmMetadata.version,
    });
    expect(requestOptions).toMatchObject({
      headers: { Metadata: "True" },
      host: "169.254.169.254",
      method: "GET",
      path: "/metadata/instance/compute?api-version=2021-12-13&format=json",
      timeout: 5000,
    });
  });

  it.each([
    ["a non-success response", { body: "not found", statusCode: 404 }],
    ["invalid JSON", { body: "{not-json", statusCode: 200 }],
  ])("returns no Azure VM attributes for %s", async (_case, result) => {
    mockVmRequest(result);

    await expect(detect(azureVmDetector)).resolves.toEqual({});
  });

  it("returns no Azure VM attributes when the metadata request fails", async () => {
    mockVmRequest({ error: new Error("network unavailable") });

    await expect(detect(azureVmDetector)).resolves.toEqual({});
  });
});
