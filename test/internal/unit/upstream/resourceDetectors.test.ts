// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  defaultResource,
  detectResources,
  envDetector,
  hostDetector,
  osDetector,
  processDetector,
  resourceFromAttributes,
  serviceInstanceIdDetector,
} from "@opentelemetry/resources";
import type { ResourceDetector } from "@opentelemetry/resources";
import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

async function detect(detectors: ResourceDetector[]) {
  const resource = detectResources({ detectors });
  await resource.waitForAsyncAttributes?.();
  return resource;
}

describe("@opentelemetry/resources contracts", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("provides the default SDK and service identity attributes", () => {
    expect(defaultResource().attributes).toMatchObject({
      "service.name": expect.stringMatching(/^unknown_service:/),
      "telemetry.sdk.language": "nodejs",
      "telemetry.sdk.name": "opentelemetry",
      "telemetry.sdk.version": expect.stringMatching(/^\d+\.\d+\.\d+/),
    });
  });

  it("decodes resource environment variables and gives OTEL_SERVICE_NAME precedence", async () => {
    vi.stubEnv(
      "OTEL_RESOURCE_ATTRIBUTES",
      "service.name=attribute-name,custom.key=hello%20world,custom.empty=",
    );
    vi.stubEnv("OTEL_SERVICE_NAME", "explicit-service-name");

    const resource = await detect([envDetector]);

    expect(resource.attributes).toEqual({
      "service.name": "explicit-service-name",
      "custom.key": "hello world",
      "custom.empty": "",
    });
  });

  it("returns an empty resource when resource environment variables are absent", async () => {
    vi.stubEnv("OTEL_RESOURCE_ATTRIBUTES", "");
    vi.stubEnv("OTEL_SERVICE_NAME", "");

    await expect(detect([envDetector])).resolves.toMatchObject({ attributes: {} });
  });

  it("uses the last value when an environment attribute is repeated", async () => {
    vi.stubEnv("OTEL_RESOURCE_ATTRIBUTES", "duplicate=first,duplicate=second");

    const resource = await detect([envDetector]);

    expect(resource.attributes).toEqual({ duplicate: "second" });
  });

  it.each([
    ["an unescaped equals sign", "valid=value,invalid=one=two"],
    ["an empty key", "=value"],
    ["invalid percent encoding", "valid=value,invalid=%E0%A4%A"],
    ["an oversized key", `${"k".repeat(256)}=value`],
    ["an oversized value", `key=${"v".repeat(256)}`],
  ])("discards all OTEL_RESOURCE_ATTRIBUTES for %s", async (_case, value) => {
    vi.stubEnv("OTEL_RESOURCE_ATTRIBUTES", value);
    vi.stubEnv("OTEL_SERVICE_NAME", "service-survives-invalid-attributes");

    const resource = await detect([envDetector]);

    expect(resource.attributes).toEqual({
      "service.name": "service-survives-invalid-attributes",
    });
  });

  it("detects host attributes from the current operating system", async () => {
    const resource = await detect([hostDetector]);

    expect(resource.attributes).toMatchObject({
      "host.arch": expect.any(String),
      "host.name": os.hostname(),
      "host.id": expect.any(String),
    });
  });

  it("detects OS attributes from the current operating system", async () => {
    const resource = await detect([osDetector]);

    expect(resource.attributes).toEqual({
      "os.type": expect.stringMatching(/^(aix|darwin|freebsd|linux|openbsd|sunos|windows)$/),
      "os.version": os.release(),
    });
  });

  it("detects the current Node.js process contract", async () => {
    const resource = await detect([processDetector]);

    expect(resource.attributes).toMatchObject({
      "process.pid": process.pid,
      "process.executable.name": process.title,
      "process.executable.path": process.execPath,
      "process.command_args": expect.arrayContaining([process.execPath]),
      "process.runtime.description": "Node.js",
      "process.runtime.name": "nodejs",
      "process.runtime.version": process.versions.node,
    });
  });

  it("generates a distinct RFC 4122 service instance ID for each detection", async () => {
    const first = await detect([serviceInstanceIdDetector]);
    const second = await detect([serviceInstanceIdDetector]);
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

    expect(first.attributes["service.instance.id"]).toMatch(uuidPattern);
    expect(second.attributes["service.instance.id"]).toMatch(uuidPattern);
    expect(second.attributes["service.instance.id"]).not.toBe(
      first.attributes["service.instance.id"],
    );
  });

  it("lets incoming resource attributes override existing attributes", () => {
    const original = resourceFromAttributes({ original: true, shared: "original" });
    const updating = resourceFromAttributes({ updating: true, shared: "updating" });

    expect(original.merge(updating).attributes).toEqual({
      original: true,
      shared: "updating",
      updating: true,
    });
  });

  it("preserves matching schema URLs and drops conflicting schema URLs", () => {
    const original = resourceFromAttributes({ original: true }, { schemaUrl: "schema-v1" });
    const matching = resourceFromAttributes({ matching: true }, { schemaUrl: "schema-v1" });
    const conflicting = resourceFromAttributes({ conflicting: true }, { schemaUrl: "schema-v2" });

    expect(original.merge(matching).schemaUrl).toBe("schema-v1");
    expect(original.merge(conflicting).schemaUrl).toBeUndefined();
  });

  it("omits undefined and rejected asynchronous attributes", async () => {
    const resource = resourceFromAttributes({
      array: ["one", "two"],
      boolean: false,
      rejected: Promise.reject(new Error("optional attribute failed")),
      undefined,
      zero: 0,
    });

    await resource.waitForAsyncAttributes?.();

    expect(resource.attributes).toEqual({
      array: ["one", "two"],
      boolean: false,
      zero: 0,
    });
  });

  it("isolates a detector that throws and continues with later detectors", async () => {
    const throwingDetector: ResourceDetector = {
      detect: () => {
        throw new Error("detector failed");
      },
    };
    const succeedingDetector: ResourceDetector = {
      detect: () => ({ attributes: { detected: true } }),
    };

    const resource = await detect([throwingDetector, succeedingDetector]);

    expect(resource.attributes).toEqual({ detected: true });
  });

  it("merges synchronous and asynchronous detector results in detector order", async () => {
    const firstDetector: ResourceDetector = {
      detect: () => ({
        attributes: {
          first: "first-value",
          shared: "first-value",
        },
      }),
    };
    const secondDetector: ResourceDetector = {
      detect: () => ({
        attributes: {
          second: Promise.resolve("second-value"),
          shared: "second-value",
          rejected: Promise.reject(new Error("optional detector failed")),
        },
      }),
    };

    const resource = detectResources({ detectors: [firstDetector, secondDetector] });

    expect(resource.asyncAttributesPending).toBe(true);
    await resource.waitForAsyncAttributes?.();
    expect(resource.asyncAttributesPending).toBe(false);
    expect(resource.attributes).toEqual({
      first: "first-value",
      second: "second-value",
      shared: "second-value",
    });
  });
});
