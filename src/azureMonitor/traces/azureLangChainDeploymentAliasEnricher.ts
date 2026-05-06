// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Span as ApiSpan } from "@opentelemetry/api";
import { registerSpanEnricher, type SpanEnricher } from "../../genai/index.js";
import { Logger } from "../../shared/logging/index.js";
import { setDeploymentAliasForSpan } from "./azureMonitorDeploymentAliasProcessor.js";

/**
 * LangChain-specific field names that Azure-backed clients (AzureChatOpenAI /
 * AzureOpenAI) populate on `Run.extra.invocation_params` when configured with
 * a deployment instead of a raw model name. Owned by the Azure module — the
 * vendor-neutral LangChain instrumentation has no knowledge of these.
 */
const AZURE_DEPLOYMENT_ALIAS_FIELDS: ReadonlyArray<string> = [
  "azureOpenAIApiDeploymentName",
  "azure_deployment",
  "deployment_name",
];

interface LangChainRunLike {
  extra?: { invocation_params?: Record<string, unknown> };
}

function extractAzureDeploymentAlias(run: LangChainRunLike | undefined | null): string | undefined {
  const invocationParams = run?.extra?.invocation_params;
  if (!invocationParams) return undefined;
  for (const field of AZURE_DEPLOYMENT_ALIAS_FIELDS) {
    const raw = invocationParams[field];
    if (raw == null) continue;
    const value = String(raw).trim();
    if (value.length > 0) return value;
  }
  return undefined;
}

/**
 * Span enricher that — when invoked by the LangChain GenAI integration —
 * extracts the Azure deployment alias from a LangChain `Run` and associates
 * it with the live span via {@link setDeploymentAliasForSpan}. The resulting
 * value is consumed by {@link AzureMonitorDeploymentAliasProcessor} on span
 * end.
 *
 * The `run` argument is typed as `unknown` (matching the registry's generic
 * signature) and structurally accessed, so this file does not depend on
 * `@langchain/core` at runtime.
 */
export const azureLangChainDeploymentAliasEnricher: SpanEnricher = (run, span) => {
  const alias = extractAzureDeploymentAlias(run as LangChainRunLike | undefined | null);
  if (alias) {
    setDeploymentAliasForSpan(span as ApiSpan, alias);
  }
};

/**
 * Best-effort registration of {@link azureLangChainDeploymentAliasEnricher}
 * with the shared GenAI span-enricher registry. Safe to call from the Azure
 * Monitor pipeline construction path: any failure (e.g. missing peer
 * dependency, registry not available) is logged and swallowed so the
 * pipeline continues to load.
 *
 * Returns an unregister thunk on success; returns `undefined` if registration
 * could not be performed.
 */
export function registerAzureLangChainDeploymentAliasEnricher(): (() => void) | undefined {
  try {
    return registerSpanEnricher(azureLangChainDeploymentAliasEnricher);
  } catch (error) {
    Logger.getInstance().warn(
      "Failed to register Azure LangChain deployment-alias enricher; deployment aliases will not be applied to spans",
      error,
    );
    return undefined;
  }
}
