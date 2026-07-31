// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { InternalConfig } from "../../../../src/shared/config.js";
import { getAzureMonitorSdkStatsFeatures } from "../../../../src/azureMonitor/index.js";
import { SEMRESATTRS_K8S_CLUSTER_NAME } from "@opentelemetry/semantic-conventions";
import { resourceFromAttributes } from "@opentelemetry/resources";

const AKS_CLUSTER_RESOURCE_ID =
  "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/test-rg/providers/Microsoft.ContainerService/managedClusters/test-cluster";

describe("getAzureMonitorSdkStatsFeatures", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = process.env;
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("should return browserSdkLoader true when enabled in config", () => {
    const config = new InternalConfig();
    config.browserSdkLoaderOptions.enabled = true;

    const features = getAzureMonitorSdkStatsFeatures(config);
    expect(features.browserSdkLoader).toBe(true);
  });

  it("should return browserSdkLoader false when disabled in config", () => {
    const config = new InternalConfig();
    config.browserSdkLoaderOptions.enabled = false;

    const features = getAzureMonitorSdkStatsFeatures(config);
    expect(features.browserSdkLoader).toBe(false);
  });

  it("should return aadHandling true when credential is provided", () => {
    const config = new InternalConfig();
    config.azureMonitorExporterOptions.credential = {
      getToken: () => Promise.resolve({ token: "test", expiresOnTimestamp: Date.now() + 10000 }),
    };

    const features = getAzureMonitorSdkStatsFeatures(config);
    expect(features.aadHandling).toBe(true);
  });

  it("should return aadHandling false when no credential is provided", () => {
    const config = new InternalConfig();

    const features = getAzureMonitorSdkStatsFeatures(config);
    expect(features.aadHandling).toBe(false);
  });

  it("should return diskRetry true when disableOfflineStorage is falsy", () => {
    const config = new InternalConfig();

    const features = getAzureMonitorSdkStatsFeatures(config);
    expect(features.diskRetry).toBe(true);
  });

  it("should return diskRetry false when disableOfflineStorage is true", () => {
    const config = new InternalConfig();
    config.azureMonitorExporterOptions.disableOfflineStorage = true;

    const features = getAzureMonitorSdkStatsFeatures(config);
    expect(features.diskRetry).toBe(false);
  });

  it("should detect AKS resource when the AKS resource detector populated the cluster resource ID", () => {
    process.env.KUBERNETES_SERVICE_HOST = "10.0.0.1";
    process.env.CLUSTER_RESOURCE_ID = AKS_CLUSTER_RESOURCE_ID;

    const features = getAzureMonitorSdkStatsFeatures(new InternalConfig());
    expect(features.aksResourceDetectorPopulation).toBe(true);
  });

  it("should not detect AKS resource when no k8s attributes are present", () => {
    const config = new InternalConfig();

    const features = getAzureMonitorSdkStatsFeatures(config);
    expect(features.aksResourceDetectorPopulation).toBe(false);
  });

  it("should not detect AKS resource for a customer supplied k8s.cluster.name attribute", () => {
    process.env.KUBERNETES_SERVICE_HOST = "10.0.0.1";
    const config = new InternalConfig();
    config.resource = resourceFromAttributes({
      [SEMRESATTRS_K8S_CLUSTER_NAME]: "my-cluster",
    });

    const features = getAzureMonitorSdkStatsFeatures(config);
    expect(features.aksResourceDetectorPopulation).toBe(false);
  });

  it("should not detect AKS resource in App Service, which also sets cloud.resource_id", () => {
    process.env.WEBSITE_SITE_NAME = "testSiteName";
    process.env.WEBSITE_OWNER_NAME =
      "00000000-0000-0000-0000-000000000000+testResourceGroup-CentralUS";
    process.env.WEBSITE_RESOURCE_GROUP = "testResourceGroup";

    const features = getAzureMonitorSdkStatsFeatures(new InternalConfig());
    expect(features.aksResourceDetectorPopulation).toBe(false);
  });

  it("should not detect AKS resource for a cluster resource ID that is not an AKS cluster", () => {
    process.env.KUBERNETES_SERVICE_HOST = "10.0.0.1";
    process.env.CLUSTER_RESOURCE_ID = "my-self-managed-cluster";

    const features = getAzureMonitorSdkStatsFeatures(new InternalConfig());
    expect(features.aksResourceDetectorPopulation).toBe(false);
  });

  it("should not detect AKS resource outside of a Kubernetes environment", () => {
    process.env.CLUSTER_RESOURCE_ID = AKS_CLUSTER_RESOURCE_ID;

    const features = getAzureMonitorSdkStatsFeatures(new InternalConfig());
    expect(features.aksResourceDetectorPopulation).toBe(false);
  });
});
