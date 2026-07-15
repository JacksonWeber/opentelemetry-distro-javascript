// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, describe, expect, it } from "vitest";
import {
  installLangChainFetchContextBridge,
  uninstallLangChainFetchContextBridge,
} from "../../../../../src/genai/instrumentations/langchain/fetchContextBridge.js";

describe("fetchContextBridge", () => {
  const original = globalThis.fetch;

  afterEach(() => {
    uninstallLangChainFetchContextBridge();
    globalThis.fetch = original;
  });

  it("patches global fetch and is idempotent", () => {
    installLangChainFetchContextBridge();
    const patched = globalThis.fetch;
    expect(patched).not.toBe(original);
    installLangChainFetchContextBridge();
    expect(globalThis.fetch).toBe(patched);
  });

  it("passes through fetch calls made outside a LangChain run", async () => {
    let called = 0;
    const fake = ((..._args: unknown[]) => {
      called += 1;
      return Promise.resolve("ok");
    }) as unknown as typeof globalThis.fetch;
    globalThis.fetch = fake;

    installLangChainFetchContextBridge();
    await (globalThis.fetch as unknown as (...a: unknown[]) => Promise<unknown>)(
      "http://example.test/",
    );

    expect(called).toBe(1);
  });

  it("restores the original fetch on uninstall", () => {
    const base = globalThis.fetch;
    installLangChainFetchContextBridge();
    expect(globalThis.fetch).not.toBe(base);
    uninstallLangChainFetchContextBridge();
    expect(globalThis.fetch).toBe(base);
  });
});
