// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { assert, describe, it } from "vitest";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { AzureMonitorLangChainModelProcessor } from "../../../../../src/azureMonitor/traces/azureMonitorLangChainModelProcessor.js";
import {
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_RESPONSE_MODEL,
  ATTR_MICROSOFT_LANGCHAIN_DEPLOYMENT_ALIAS,
} from "../../../../../src/genai/index.js";

function makeFakeSpan(name: string, attributes: Record<string, unknown>): ReadableSpan {
  // Mimic the SDK Span object enough that the processor's mutations land on
  // a writable `attributes` map and `name` field.
  const span = {
    name,
    attributes,
  } as unknown as ReadableSpan;
  return span;
}

describe("AzureMonitorLangChainModelProcessor", () => {
  it("overrides gen_ai.request.model with the deployment alias when the bridge attribute is present", () => {
    const processor = new AzureMonitorLangChainModelProcessor();
    const attrs: Record<string, unknown> = {
      [ATTR_GEN_AI_REQUEST_MODEL]: "gpt-3.5-turbo",
      [ATTR_GEN_AI_RESPONSE_MODEL]: "gpt-4o-2024-08-06",
      [ATTR_MICROSOFT_LANGCHAIN_DEPLOYMENT_ALIAS]: "my-gpt4o-deployment",
    };
    const span = makeFakeSpan("chat gpt-3.5-turbo", attrs);

    processor.onEnd(span);

    assert.strictEqual(
      attrs[ATTR_GEN_AI_REQUEST_MODEL],
      "my-gpt4o-deployment",
      "request model is overridden with the Azure deployment alias",
    );
    assert.strictEqual(
      attrs[ATTR_GEN_AI_RESPONSE_MODEL],
      "gpt-4o-2024-08-06",
      "response model is left untouched",
    );
    assert.ok(
      !(ATTR_MICROSOFT_LANGCHAIN_DEPLOYMENT_ALIAS in attrs),
      "internal bridge attribute is stripped from the exported span",
    );
    assert.strictEqual(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (span as any).name,
      "chat my-gpt4o-deployment",
      "chat span name is rewritten to use the deployment alias",
    );
  });

  it("is a no-op when the deployment alias bridge attribute is missing", () => {
    const processor = new AzureMonitorLangChainModelProcessor();
    const attrs: Record<string, unknown> = {
      [ATTR_GEN_AI_REQUEST_MODEL]: "gpt-4o",
      [ATTR_GEN_AI_RESPONSE_MODEL]: "gpt-4o-2024-08-06",
    };
    const span = makeFakeSpan("chat gpt-4o", attrs);

    processor.onEnd(span);

    assert.strictEqual(attrs[ATTR_GEN_AI_REQUEST_MODEL], "gpt-4o");
    assert.strictEqual(attrs[ATTR_GEN_AI_RESPONSE_MODEL], "gpt-4o-2024-08-06");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.strictEqual((span as any).name, "chat gpt-4o");
  });

  it("does not rewrite span name for non-chat operations", () => {
    const processor = new AzureMonitorLangChainModelProcessor();
    const attrs: Record<string, unknown> = {
      [ATTR_GEN_AI_REQUEST_MODEL]: "gpt-3.5-turbo",
      [ATTR_MICROSOFT_LANGCHAIN_DEPLOYMENT_ALIAS]: "my-deployment",
    };
    const span = makeFakeSpan("invoke_agent MyAgent", attrs);

    processor.onEnd(span);

    assert.strictEqual(attrs[ATTR_GEN_AI_REQUEST_MODEL], "my-deployment");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.strictEqual((span as any).name, "invoke_agent MyAgent");
  });

  it("ignores non-string deployment alias values", () => {
    const processor = new AzureMonitorLangChainModelProcessor();
    const attrs: Record<string, unknown> = {
      [ATTR_GEN_AI_REQUEST_MODEL]: "gpt-4o",
      [ATTR_MICROSOFT_LANGCHAIN_DEPLOYMENT_ALIAS]: 12345,
    };
    const span = makeFakeSpan("chat gpt-4o", attrs);

    processor.onEnd(span);

    assert.strictEqual(attrs[ATTR_GEN_AI_REQUEST_MODEL], "gpt-4o");
    assert.strictEqual(attrs[ATTR_MICROSOFT_LANGCHAIN_DEPLOYMENT_ALIAS], 12345);
  });

  it("ignores empty-string deployment alias values", () => {
    const processor = new AzureMonitorLangChainModelProcessor();
    const attrs: Record<string, unknown> = {
      [ATTR_GEN_AI_REQUEST_MODEL]: "gpt-4o",
      [ATTR_MICROSOFT_LANGCHAIN_DEPLOYMENT_ALIAS]: "",
    };
    const span = makeFakeSpan("chat gpt-4o", attrs);

    processor.onEnd(span);

    assert.strictEqual(attrs[ATTR_GEN_AI_REQUEST_MODEL], "gpt-4o");
    assert.strictEqual(attrs[ATTR_MICROSOFT_LANGCHAIN_DEPLOYMENT_ALIAS], "");
  });

  it("sets gen_ai.request.model from the alias even when the instrumentation did not set one", () => {
    // Covers the scenario where LangChain only populated an Azure
    // deployment-alias field on invocation_params (no `model` / `model_name` /
    // `ls_model_name`). The instrumentation will not set gen_ai.request.model;
    // the processor must add it from the bridge attribute so the exported span
    // is still attributed to a model.
    const processor = new AzureMonitorLangChainModelProcessor();
    const attrs: Record<string, unknown> = {
      [ATTR_MICROSOFT_LANGCHAIN_DEPLOYMENT_ALIAS]: "my-gpt4o-deployment",
    };
    const span = makeFakeSpan("chat ", attrs);

    processor.onEnd(span);

    assert.strictEqual(
      attrs[ATTR_GEN_AI_REQUEST_MODEL],
      "my-gpt4o-deployment",
      "request model is populated from the alias even when not previously set",
    );
    assert.ok(!(ATTR_MICROSOFT_LANGCHAIN_DEPLOYMENT_ALIAS in attrs));
  });

  it("regression: AzureChatOpenAI deployment alias wins over LangChain's default invocation_params.model after the processor runs", () => {
    // End-to-end pipeline behavior: the LangChain instrumentation sets
    // gen_ai.request.model to "gpt-3.5-turbo" (the LangChain.js default for
    // Azure clients) and the bridge attribute to the configured deployment
    // alias. After this processor runs, gen_ai.request.model must be the
    // deployment alias, gen_ai.response.model must be untouched, and the
    // bridge attribute must be stripped.
    const processor = new AzureMonitorLangChainModelProcessor();
    const attrs: Record<string, unknown> = {
      [ATTR_GEN_AI_REQUEST_MODEL]: "gpt-3.5-turbo",
      [ATTR_GEN_AI_RESPONSE_MODEL]: "gpt-4o-2024-08-06",
      [ATTR_MICROSOFT_LANGCHAIN_DEPLOYMENT_ALIAS]: "my-gpt4o-deployment",
    };
    const span = makeFakeSpan("chat gpt-3.5-turbo", attrs);

    processor.onEnd(span);

    assert.strictEqual(attrs[ATTR_GEN_AI_REQUEST_MODEL], "my-gpt4o-deployment");
    assert.strictEqual(attrs[ATTR_GEN_AI_RESPONSE_MODEL], "gpt-4o-2024-08-06");
    assert.ok(!(ATTR_MICROSOFT_LANGCHAIN_DEPLOYMENT_ALIAS in attrs));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.strictEqual((span as any).name, "chat my-gpt4o-deployment");
  });

  it("tolerates spans without an attributes bag (defensive)", () => {
    const processor = new AzureMonitorLangChainModelProcessor();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const span = { name: "chat foo" } as any as ReadableSpan;
    // Should not throw.
    processor.onEnd(span);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.strictEqual((span as any).name, "chat foo");
  });
});
