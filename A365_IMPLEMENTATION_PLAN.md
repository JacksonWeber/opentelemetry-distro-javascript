# A365 Integration Implementation Plan

## Overview

This document details the plan for migrating the A365 observability runtime from `microsoft/Agent365-nodejs` into the Microsoft OpenTelemetry JavaScript distro (`@microsoft/opentelemetry`). Per PLANNING.md Phase 6 (A365 Convergence), A365 code is **migrated as source** — not consumed as an npm dependency — under a clearly defined internal module boundary (`_a365/`).

This plan covers both **Phase 5 (GenAI Instrumentations)** and **Phase 6 (A365 Convergence)** from PLANNING.md. The GenAI instrumentations (OpenAI, OpenAI Agents SDK, LangChain) are Phase 5 deliverables but are sourced from A365's existing implementations, so they are coordinated here. The core A365 infrastructure (exporter, processors, scopes, hosting) is Phase 6.

Phases 1–4 are now substantially complete:
- ~~**Phase 1 (Package Foundation):** Published as `@microsoft/opentelemetry`, with ESLint, Vitest, and CI configured.~~
- **Phase 2 (Configuration Surface):** `MicrosoftOpenTelemetryOptions` is defined in `src/distro/types.ts` with a backend-scoped pattern (`azureMonitor?: AzureMonitorOpenTelemetryOptions`). The A365 scope (`a365?: A365Options`) follows this established pattern. Per PLANNING.md, A365-scoped configuration includes: A365 exporter endpoint, baggage extensions, Microsoft Agent Framework instrumentation toggles, and A365-specific span processors.
- **Phase 3 (Azure Monitor Migration):** Azure Monitor distro code has been fully migrated in-repo under `src/` (traces, metrics, logs, browser SDK loader, statsbeat, etc.).
- **Phase 4 (Core OTel Setup):** `useMicrosoftOpenTelemetry()` in `src/distro/distro.ts` orchestrates NodeSDK creation with Azure Monitor handlers. The entry point has explicit `// TODO` placeholders for OTLP and A365 integration.

This plan builds on the established architecture.
---

## Source Packages (Agent365-nodejs)

The following packages from [`microsoft/Agent365-nodejs/packages/`](https://github.com/microsoft/Agent365-nodejs/tree/main/packages) are in scope for migration:

| Package | Purpose | Key Files |
|---------|---------|-----------|
| `agents-a365-observability` | Core observability SDK — exporter, span processors, scopes, context propagation, configuration, constants/contracts | `ObservabilityBuilder.ts`, `ObservabilityManager.ts`, `configuration/`, `tracing/`, `internal/`, `utils/` |
| `agents-a365-observability-hosting` | Hosting integration — middleware, token caching, baggage propagation | `middleware/`, `caching/`, `utils/` |
| `agents-a365-observability-extensions-openai` | OpenAI Agents SDK instrumentation | `OpenAIAgentsTraceInstrumentor.ts`, `OpenAIAgentsTraceProcessor.ts`, `Constants.ts`, `Utils.ts`, `configuration/` |
| `agents-a365-observability-extensions-langchain` | LangChain instrumentation via callback handler patching | `LangChainTraceInstrumentor.ts`, `tracer.ts`, `Utils.ts` |
| `agents-a365-runtime` | Runtime configuration utilities (partial — only what observability depends on) | `environment-utils.ts`, `configuration/`, `ClusterCategory` |

---

## Target Module Structure

All A365 code lives under `src/_a365/` with clear internal module boundaries. GenAI instrumentations (Phase 5) live in separate top-level internal modules (`_openai/`, `_langchain/`) per PLANNING.md convention, but are sourced from A365's existing implementations and coordinated here. The setup orchestrator follows the established pattern of `src/azureMonitorSetup.ts` (a top-level setup helper called from `src/distro/distro.ts`):

```
src/
├── index.ts                          # Re-exports from distro; backward-compat useAzureMonitor()
├── distro/
│   ├── distro.ts                     # useMicrosoftOpenTelemetry() entry point — calls a365Setup
│   ├── types.ts                      # MicrosoftOpenTelemetryOptions (a365 scope here)
│   └── index.ts                      # Barrel export for distro
├── azureMonitorSetup.ts              # Azure Monitor setup helper (existing)
├── a365Setup.ts                      # A365 setup orchestrator (wires _a365/ into providers)
│
├── _a365/                            # Internal A365 module boundary (Phase 6)
│   ├── index.ts                      # Internal barrel export
│   │
│   ├── configuration/
│   │   ├── A365Configuration.ts      # From ObservabilityConfiguration + RuntimeConfiguration
│   │   └── A365ConfigurationOptions.ts
│   │
│   ├── exporter/
│   │   ├── Agent365Exporter.ts       # Custom SpanExporter → A365 service
│   │   └── Agent365ExporterOptions.ts
│   │
│   ├── processors/
│   │   ├── PerRequestSpanProcessor.ts  # Buffers spans per trace, exports on root completion
│   │   ├── SpanProcessor.ts            # Generic span processing
│   │   └── BaggageSpanProcessor.ts     # Copies baggage items to span attributes
│   │
│   ├── scopes/
│   │   ├── OpenTelemetryScope.ts       # Base span scope (Disposable)
│   │   ├── InvokeAgentScope.ts         # Agent invocation spans
│   │   ├── ExecuteToolScope.ts         # Tool execution spans
│   │   ├── InferenceScope.ts           # LLM inference spans
│   │   └── OutputScope.ts             # Output message spans
│   │
│   ├── context/
│   │   ├── tokenContext.ts             # runWithExportToken / getExportToken
│   │   ├── parentSpanContext.ts         # ParentSpanRef, manual parent linking
│   │   └── traceContextPropagation.ts  # W3C traceparent inject/extract
│   │
│   ├── contracts/
│   │   ├── messages.ts                 # ChatMessage, InputMessages, OutputMessages
│   │   ├── details.ts                  # AgentDetails, UserDetails, SpanDetails
│   │   └── types.ts                    # MessageRole, MessagePart union types
│   │
│   ├── constants.ts                    # OpenTelemetryConstants (semantic attribute keys)
│   │
│   ├── hosting/
│   │   ├── BaggageMiddleware.ts
│   │   ├── OutputLoggingMiddleware.ts
│   │   ├── ObservabilityHostingManager.ts
│   │   └── AgenticTokenCache.ts
│   │
│   ├── instrumentations/
│   │   └── MicrosoftAgentFrameworkInstrumentation.ts  # Microsoft Agent Framework instrumentation
│   │
│   └── utils/
│       ├── baggageBuilder.ts
│       ├── scopeUtils.ts
│       └── logger.ts
│
├── _openai/                          # OpenAI GenAI instrumentations (Phase 5 — sourced from A365)
│   ├── OpenAIAgentsTraceInstrumentor.ts
│   ├── OpenAIAgentsTraceProcessor.ts
│   ├── Constants.ts
│   ├── Utils.ts
│   └── configuration/
│       └── OpenAIObservabilityConfiguration.ts
│
└── _langchain/                       # LangChain GenAI instrumentations (Phase 5 — sourced from A365)
    ├── LangChainTraceInstrumentor.ts
    ├── tracer.ts
    └── Utils.ts
```

---

## Implementation Tasks

### Task 1: Migrate A365 Configuration Layer

**Source:** `agents-a365-observability/src/configuration/` + `agents-a365-runtime/src/configuration/`

**Work:**
- Create `_a365/configuration/A365Configuration.ts` — merge `ObservabilityConfiguration` and the runtime config it extends
- Extract only the config properties needed by observability (drop runtime-only concerns like authorization service, Power Platform API discovery)
- Define `A365ConfigurationOptions` interface for the distro's public `a365` config scope
- Map environment variables to the distro convention:

| A365 Original Env Var | Distro Env Var |
|----------------------|----------------|
| `ENABLE_A365_OBSERVABILITY_EXPORTER` | `MICROSOFT_OTEL_A365_EXPORTER_ENABLED` |
| `ENABLE_A365_OBSERVABILITY_PER_REQUEST_EXPORT` | `MICROSOFT_OTEL_A365_PER_REQUEST_EXPORT` |
| `A365_OBSERVABILITY_SCOPES_OVERRIDE` | `MICROSOFT_OTEL_A365_AUTH_SCOPES` |
| `A365_OBSERVABILITY_DOMAIN_OVERRIDE` | `MICROSOFT_OTEL_A365_DOMAIN` |
| `A365_OBSERVABILITY_LOG_LEVEL` | `MICROSOFT_OTEL_A365_LOG_LEVEL` |
| `AGENT_CLUSTER_CATEGORY` | `MICROSOFT_OTEL_A365_CLUSTER_CATEGORY` |

- Integrate into the distro's `src/distro/types.ts` as the `a365` scope (following the established `azureMonitor` scoping pattern):

```typescript
// In src/distro/types.ts
export interface MicrosoftOpenTelemetryOptions {
  // ── Global options (already defined) ──
  resource?: Resource;
  samplingRatio?: number;
  tracesPerSecond?: number;
  instrumentationOptions?: InstrumentationOptions;
  logRecordProcessors?: LogRecordProcessor[];
  spanProcessors?: SpanProcessor[];
  metricReaders?: MetricReader[];
  views?: ViewOptions[];

  // ── Backend-scoped options ──
  azureMonitor?: AzureMonitorOpenTelemetryOptions;  // (already defined)
  a365?: A365Options;                                // NEW
}

export interface A365Options {
  enabled?: boolean;
  tokenResolver?: (agentId: string, tenantId: string) => string | Promise<string>;
  clusterCategory?: 'prod' | 'preprod';
  domainOverride?: string;
  authScopes?: string[];
  perRequestExport?: boolean;
  exporterOptions?: Partial<Agent365ExporterOptions>;
  logLevel?: 'none' | 'error' | 'warn' | 'info' | 'debug' | 'verbose';
  baggage?: {
    propagationEnabled?: boolean;        // Enable baggage propagation middleware
    enrichSpans?: boolean;               // Copy baggage items to span attributes
  };
  instrumentations?: {
    openaiAgents?: boolean | OpenAIObservabilityConfiguration;
    langchain?: boolean | LangChainObservabilityConfiguration;
    microsoftAgentFramework?: boolean;   // Microsoft Agent Framework instrumentation
  };
  hosting?: {
    enabled?: boolean;                   // Enable hosting middleware (requires @microsoft/agents-hosting)
  };
}
```

**Depends on:** Phase 2 configuration surface (now complete — `MicrosoftOpenTelemetryOptions` with backend scoping is established in `src/distro/types.ts`)

---

### Task 2: Migrate Agent365 Exporter

**Source:** `agents-a365-observability/src/tracing/exporter/`

**Work:**
- Copy `Agent365Exporter.ts` and `Agent365ExporterOptions.ts` into `_a365/exporter/`
- The exporter implements `SpanExporter` from `@opentelemetry/sdk-trace-base`
- Key behavior to preserve:
  - Span partitioning by `(tenantId, agentId)` tuples
  - OTLP-like JSON payload construction (`resourceSpans → scopeSpans → spans`)
  - Dual endpoint styles: `/observability/...` and `/observabilityService/...` (S2S)
  - Token resolution: batch export via `tokenResolver()`, per-request via context `getExportToken()`
  - Automatic retry with exponential backoff
  - HTTP request timeout support
- **Adaptation:** Replace dependency on `agents-a365-runtime` config with the distro's `A365Configuration`
- **Adaptation:** Replace internal logger with distro's logging approach (`Logger` from `src/shared/logging/`)
- Add new dependency: native `fetch` (Node 18+) or `undici` for HTTP — check what the exporter currently uses

**Depends on:** Task 1

---

### Task 3: Migrate Span Processors

**Source:** `agents-a365-observability/src/tracing/`

**Work:**
- Copy `PerRequestSpanProcessor.ts` → `_a365/processors/PerRequestSpanProcessor.ts`
  - Buffers spans per traceId in `Map<traceId, TraceBuffer>`
  - Waits for root span to end + all children to complete
  - Grace period timeout for stuck spans
  - Concurrent export limiting
  - Stores OpenTelemetry Context for token retrieval at export time
- Copy `SpanProcessor.ts` → `_a365/processors/SpanProcessor.ts`
- Copy baggage builder → `_a365/processors/BaggageSpanProcessor.ts`
  - Extracts OTel baggage from context, copies to span attributes
- **Adaptation:** These implement `SpanProcessor` from `@opentelemetry/sdk-trace-base` — wire them into the distro's provider setup via `src/a365Setup.ts`
- The processor chain order must be preserved:
  1. BaggageSpanProcessor (enriches spans with baggage attributes)
  2. SpanProcessor (generic processing)
  3. PerRequestSpanProcessor or BatchSpanProcessor (export)

**Depends on:** Task 2

---

### Task 4: Migrate Scopes & Contracts

**Source:** `agents-a365-observability/src/tracing/scopes/` + `agents-a365-observability/src/tracing/contracts.ts` + `agents-a365-observability/src/tracing/constants.ts`

**Work:**
- Copy scope hierarchy into `_a365/scopes/`:
  - `OpenTelemetryScope` — base class with `Disposable`/`Symbol.dispose`, wraps OTel spans
  - `InvokeAgentScope` — agent invocation
  - `ExecuteToolScope` — tool execution
  - `InferenceScope` — LLM inference
  - `OutputScope` — output recording
- Copy contracts into `_a365/contracts/`:
  - `MessageRole` enum: system, user, assistant, tool
  - `MessagePart` union: TextPart, ToolCallRequestPart, ToolCallResponsePart, ReasoningPart, BlobPart, FilePart, UriPart, etc.
  - `ChatMessage`, `InputMessages`, `OutputMessages`
  - `AgentDetails`, `UserDetails`, `SpanDetails`
- Copy `OpenTelemetryConstants` into `_a365/constants.ts`:
  - Gen AI semantic convention attribute keys (`gen_ai.agent.id`, `gen_ai.agent.name`, etc.)
  - Microsoft-specific attributes (`microsoft.a365.caller.agent.*`, `microsoft.tenant.id`)
  - Tool/inference/message attributes
- **Decision needed:** Scopes are the primary public API surface for A365 consumers building agent frameworks — decide whether to re-export from the distro's top-level `index.ts` or keep internal

**Depends on:** Task 1

---

### Task 5: Migrate Context Propagation

**Source:** `agents-a365-observability/src/tracing/context/`

**Work:**
- Copy `token-context.ts` → `_a365/context/tokenContext.ts`
  - `runWithExportToken(token, callback)` — stores token in OTel context
  - `getExportToken()` — retrieves token from active context
  - `updateExportToken(token)` — updates token
- Copy `parent-span-context.ts` → `_a365/context/parentSpanContext.ts`
  - `ParentSpanRef` type (traceId, spanId)
  - `runWithParentSpanRef()` / `createContextWithParentSpanRef()`
- Copy `trace-context-propagation.ts` → `_a365/context/traceContextPropagation.ts`
  - W3C traceparent inject/extract to/from HTTP headers
- **Note:** These use `@opentelemetry/api` context APIs — no adaptation needed beyond import paths

**Depends on:** None (standalone utilities)

---

### Task 6: Migrate OpenAI Agents Instrumentation

**Source:** `agents-a365-observability-extensions-_openai/src/`

**Work:**
- Per PLANNING.md Phase 5, GenAI instrumentations go into clearly marked internal modules
- Copy into `src/_openai/` (separate from `_a365/` per PLANNING.md convention):
  - `OpenAIAgentsTraceInstrumentor.ts` — extends `InstrumentationBase`, targets `@_openai/agents >= 0.1.5`
  - `OpenAIAgentsTraceProcessor.ts` — implements OpenAI's `TracingProcessor` interface
  - `Constants.ts` — OpenAI-specific constants
  - `Utils.ts` — OpenAI utilities
  - `configuration/OpenAIObservabilityConfiguration.ts`
- Key behavior:
  - `enable()` → gets tracer, creates processor, calls OpenAI's `setTraceProcessors([processor])`
  - Config options: `suppressInvokeAgentInput`, `isContentRecordingEnabled`
  - Maps OpenAI agent events to A365 scope types (InvokeAgent, ExecuteTool, Inference, Output)
- **Adaptation:** Replace `@microsoft/agents-a365-observability` imports with `../_a365/` imports
- **Adaptation:** Replace `@microsoft/agents-a365-runtime` imports with distro config
- **Dependency:** `@_openai/agents` as optional peer dependency
- Wire into distro config: `a365.instrumentations.openaiAgents`

**Depends on:** Task 4 (scopes/contracts)

---

### Task 7: Migrate LangChain Instrumentation

**Source:** `agents-a365-observability-extensions-_langchain/src/`

**Work:**
- Copy into `src/_langchain/` (separate from `_a365/` per PLANNING.md convention):
  - `LangChainTraceInstrumentor.ts` — singleton instrumentor
  - `tracer.ts` — `LangChainTracer` implementing LangChain callback handler
  - `Utils.ts` — LangChain utilities
- Key behavior:
  - Patches `@_langchain/core/callbacks/manager.CallbackManager._configureSync()`
  - Injects `LangChainTracer` into callback handlers
  - Listens to `on_chain_start`, `on_chain_end`, `on_tool_start`, etc.
  - Creates/manages spans for chain invocations and tool calls
  - Config: `isContentRecordingEnabled`
- **Adaptation:** Replace `@microsoft/agents-a365-observability` imports with `../_a365/` imports
- **Dependency:** `@_langchain/core` as optional peer dependency
- Wire into distro config: `a365.instrumentations.langchain`

**Depends on:** Task 4 (scopes/contracts)

---

### Task 8: Migrate Hosting Integration

**Source:** `agents-a365-observability-hosting/src/`

**Work:**
- Copy into `_a365/hosting/`:
  - `AgenticTokenCache.ts` — TTL-based token caching for A365 service authentication
  - `BaggageMiddleware.ts` — propagates baggage from request headers to span context
  - `OutputLoggingMiddleware.ts` — records output, injects parent span info into response headers
  - `ObservabilityHostingManager.ts` — lifecycle management in hosting environments
  - `BaggageBuilderUtils.ts`, `ScopeUtils.ts`, `TurnContextUtils.ts`
- **Adaptation:** Replace `@microsoft/agents-hosting` dependency:
  - Evaluate whether hosting middleware should be directly included or behind a feature flag
  - The hosting package depends on `@microsoft/agents-hosting` (Microsoft Agent Framework) — this is a tight coupling
  - **Option A:** Keep hosting code but make `@microsoft/agents-hosting` an optional peer dependency
  - **Option B:** Defer hosting integration until the distro has a hosting story
- **Recommendation:** Option A — migrate the code, gate behind `a365.hosting.enabled` config flag, declare `@microsoft/agents-hosting` as optional peer dependency

**Depends on:** Tasks 1, 3, 5

---

### Task 10: Testing

**Work:**
- Unit tests for each migrated module (maintain test parity with Agent365-nodejs):
  - `_a365/exporter/` — mock HTTP, verify payload format, retry behavior
  - `_a365/processors/` — verify buffering, grace period, concurrent export limits
  - `_a365/scopes/` — verify span attributes, lifecycle, disposable pattern
  - `_a365/context/` — verify context propagation, token storage/retrieval
  - `_a365/configuration/` — verify env var parsing, defaults, validation
  - `_a365/instrumentations/` — verify Microsoft Agent Framework instrumentation lifecycle
  - `_openai/` — mock `@_openai/agents`, verify trace processor registration
  - `_langchain/` — mock `@_langchain/core`, verify callback patching
  - `a365Setup.ts` — integration test for full A365 setup flow
- Use Vitest (confirmed — already configured in `vitest.config.ts` with tests under `test/`)
- Tests for missing optional peer dependencies (graceful failures when `@_openai/agents`, `@_langchain/core`, or `@microsoft/agents-hosting` not installed)
- Tests for disabled A365 scenario (no processors registered, no exporter created)
- **Telemetry pipeline validation** (per PLANNING.md Phase 6): Validate that existing A365 telemetry pipelines continue to work under the new distro setup with the in-repo code:
  - Verify span attribute fidelity: spans produced by the migrated code must have identical attributes, naming, and structure to those produced by the standalone `Agent365-nodejs` packages
  - Verify exporter payload compatibility: the JSON payloads sent to the A365 service endpoint must be wire-compatible
  - Verify processor chain ordering produces the same enrichment results
  - Verify context propagation (token context, parent span ref, W3C traceparent) works identically
  - Smoke test: run a representative agent workload through the distro and compare telemetry output with the same workload through the standalone A365 SDK

**Depends on:** Tasks 1–9

---

## Public API Surface

### Exported from `@microsoft/opentelemetry` (Top-Level)

These A365 types should be re-exported from the distro's `src/distro/index.ts` barrel (which is then re-exported by `src/index.ts`) for consumers building agent frameworks:

```typescript
// Scopes — primary API for creating agent observability spans
export { OpenTelemetryScope } from './_a365/scopes/OpenTelemetryScope';
export { InvokeAgentScope } from './_a365/scopes/InvokeAgentScope';
export { ExecuteToolScope } from './_a365/scopes/ExecuteToolScope';
export { InferenceScope } from './_a365/scopes/InferenceScope';
export { OutputScope } from './_a365/scopes/OutputScope';

// Contracts — message and detail types
export type { ChatMessage, InputMessages, OutputMessages } from './_a365/contracts/messages';
export type { AgentDetails, UserDetails, SpanDetails } from './_a365/contracts/details';
export { MessageRole } from './_a365/contracts/types';

// Context propagation utilities
export { runWithExportToken, getExportToken } from './_a365/context/tokenContext';
export { injectContextToHeaders, extractContextFromHeaders } from './_a365/context/traceContextPropagation';

// Configuration types
export type { A365Options } from './distro/types';

// Constants
export { OpenTelemetryConstants } from './_a365/constants';
```
