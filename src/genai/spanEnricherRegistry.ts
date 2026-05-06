// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Span } from "@opentelemetry/api";

/**
 * Generic span enricher signature. The first argument is the framework-specific
 * "run" object (e.g. a LangChain `Run`); this module intentionally types it as
 * `unknown` so the registry has no runtime dependency on any particular GenAI
 * framework. Consumers cast as needed.
 */
export type SpanEnricher = (run: unknown, span: Span) => void;

const enrichers: SpanEnricher[] = [];

/**
 * Register an enricher to be invoked for every completed run mapped to a span
 * by an integration (e.g. the LangChain tracer). Returns an unregister thunk.
 * Idempotent for the same function reference.
 */
export function registerSpanEnricher(enricher: SpanEnricher): () => void {
  if (!enrichers.includes(enricher)) {
    enrichers.push(enricher);
  }
  return () => {
    const idx = enrichers.indexOf(enricher);
    if (idx >= 0) enrichers.splice(idx, 1);
  };
}

/** Internal: called by GenAI integrations from their tracing lifecycle. */
export function getRegisteredSpanEnrichers(): readonly SpanEnricher[] {
  return enrichers;
}
