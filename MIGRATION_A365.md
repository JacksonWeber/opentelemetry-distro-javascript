# Migrating from `@microsoft/agents-a365-observability` to `@microsoft/opentelemetry`

This guide covers migrating agent observability code from the standalone `@microsoft/agents-a365-observability` package (in [Agent365-nodejs](https://github.com/microsoft/Agent365-nodejs)) to the `@microsoft/opentelemetry` distribution.

## Quick Start

### Before (Agent365-nodejs)

```typescript
import { Builder } from "@microsoft/agents-a365-observability";

const manager = new Builder({
  tokenResolver: async (agentId, tenantId) => getToken(agentId, tenantId),
  clusterCategory: "prod",
}).build();
```

### After (@microsoft/opentelemetry)

```typescript
import { useMicrosoftOpenTelemetry } from "@microsoft/opentelemetry";

useMicrosoftOpenTelemetry({
  a365: {
    enabled: true,
    tokenResolver: async (agentId, tenantId) => getToken(agentId, tenantId),
    clusterCategory: "prod",
  },
});
```

## Package Changes

| Before | After |
|---|---|
| `npm install @microsoft/agents-a365-observability` | `npm install @microsoft/opentelemetry` |
| `import { Builder } from "@microsoft/agents-a365-observability"` | `import { useMicrosoftOpenTelemetry } from "@microsoft/opentelemetry"` |

The `@microsoft/opentelemetry` distro handles A365 setup via `useMicrosoftOpenTelemetry()`. For manual telemetry APIs (scopes, baggage, context propagation, etc.), import them directly from `@microsoft/agents-a365-observability` — they are **not** re-exported by the distro.

## Import Mapping

### Initialization (import from `@microsoft/opentelemetry`)

| Before | After |
|---|---|
| `Builder` / `ObservabilityManager` | `useMicrosoftOpenTelemetry({ a365: { ... } })` |

### Manual APIs (keep importing from `@microsoft/agents-a365-observability`)

Scopes, constants, enums, context propagation, baggage, message utilities, and types are all imported directly from `@microsoft/agents-a365-observability`. The distro does not re-export these.

```typescript
// Initialization — from the distro
import { useMicrosoftOpenTelemetry } from "@microsoft/opentelemetry";

// Manual telemetry APIs — from the A365 observability package directly
import {
  InvokeAgentScope,
  InferenceScope,
  ExecuteToolScope,
  OutputScope,
  BaggageBuilder,
  MessageRole,
  injectContextToHeaders,
  runWithExtractedTraceContext,
} from "@microsoft/agents-a365-observability";
import type { AgentDetails, Request, InferenceDetails } from "@microsoft/agents-a365-observability";
```

## Initialization

### Before: `ObservabilityBuilder`

The Agent365-nodejs package used `ObservabilityBuilder` / `ObservabilityManager`:

```typescript
import { Builder } from "@microsoft/agents-a365-observability";

const manager = new Builder({
  tokenResolver: async (agentId, tenantId) => getToken(agentId, tenantId),
  clusterCategory: "prod",
  perRequestExport: true,
}).build();
```

### After: `useMicrosoftOpenTelemetry`

The new package uses a unified initialization call:

```typescript
import { useMicrosoftOpenTelemetry } from "@microsoft/opentelemetry";

useMicrosoftOpenTelemetry({
  a365: {
    enabled: true,
    tokenResolver: async (agentId, tenantId) => getToken(agentId, tenantId),
    clusterCategory: "prod",
    perRequestExport: true,
  },
  // Optional: also send to Azure Monitor
  azureMonitor: {
    azureMonitorExporterOptions: {
      connectionString: process.env.APPLICATIONINSIGHTS_CONNECTION_STRING,
    },
  },
});
```

## Environment Variables

Environment variable names are **unchanged** from Agent365-nodejs:

| Environment Variable | Description |
|---|---|
| `ENABLE_A365_OBSERVABILITY_EXPORTER` | Enable/disable A365 exporter (`true`, `1`, `yes`, `on`) |
| `ENABLE_A365_OBSERVABILITY_PER_REQUEST_EXPORT` | Enable/disable per-request export mode |
| `A365_OBSERVABILITY_SCOPES_OVERRIDE` | Space-separated list of OAuth scopes |
| `A365_OBSERVABILITY_DOMAIN_OVERRIDE` | Override service domain |
| `CLUSTER_CATEGORY` | Cluster category (`prod`, `dev`, `test`, etc.) |
| `A365_PER_REQUEST_MAX_TRACES` | Max buffered traces (default: `1000`) |
| `A365_PER_REQUEST_MAX_SPANS_PER_TRACE` | Max spans per trace (default: `5000`) |
| `A365_PER_REQUEST_MAX_CONCURRENT_EXPORTS` | Max concurrent exports (default: `20`) |
| `A365_PER_REQUEST_FLUSH_GRACE_MS` | Grace period after root span ends (default: `250`) |
| `A365_PER_REQUEST_MAX_TRACE_AGE_MS` | Max trace age before forced flush (default: `1800000`) |

## Scopes

Scope usage is identical. Import path stays the same — scopes come directly from `@microsoft/agents-a365-observability`, not re-exported by the distro:

### Before

```typescript
import { InvokeAgentScope } from "@microsoft/agents-a365-observability";

const scope = new InvokeAgentScope({
  agent: { id: "agent-123", name: "MyAgent" },
  request: { tenantId: "tenant-456" },
  invokeAgent: { targetAgentId: "target-789" },
});

scope.start();
try {
  // ... agent work
} finally {
  scope.end();
}
```

### After

```typescript
// Same import — no change needed for scopes
import { InvokeAgentScope } from "@microsoft/agents-a365-observability";
const scope = new InvokeAgentScope({
  agent: { id: "agent-123", name: "MyAgent" },
  request: { tenantId: "tenant-456" },
  invokeAgent: { targetAgentId: "target-789" },
});

scope.start();
try {
  // ... agent work
} finally {
  scope.end();
}
```

## BaggageBuilder

The `BaggageBuilder` fluent API is identical:

```typescript
import { BaggageBuilder } from "@microsoft/agents-a365-observability";

const scope = new BaggageBuilder()
  .tenantId("tenant-123")
  .agentId("agent-456")
  .sessionId("session-789")
  .build();

scope.run(() => {
  // Baggage is active in this context
  // A365SpanProcessor copies baggage to span attributes automatically
});
```

## Token Context

Per-request token management is identical:

```typescript
import { runWithExportToken, updateExportToken } from "@microsoft/agents-a365-observability";

runWithExportToken(initialToken, async () => {
  // Start spans...

  // Refresh token before long-running request completes
  updateExportToken(refreshedToken);

  // End root span — export uses the refreshed token
});
```

## What Changes

| Component | Change |
|---|---|
| `ObservabilityManager` / `ObservabilityBuilder` | No longer called directly — `useMicrosoftOpenTelemetry()` calls `ObservabilityManager.start()` internally |
| `@microsoft/agents-a365-observability` | Still used directly for manual APIs (scopes, baggage, context propagation) |
| `@microsoft/agents-a365-runtime` | Transitive dependency — no direct import needed by consumers |
| `@microsoft/agents-hosting` | HTTP hosting middleware — separate concern, not part of the distro |
| `AgenticTokenCache` | Token caching is the caller's responsibility |

## Checklist

- [ ] Add `@microsoft/opentelemetry` dependency
- [ ] Keep `@microsoft/agents-a365-observability` for manual telemetry APIs (scopes, baggage, etc.)
- [ ] Replace `Builder().build()` with `useMicrosoftOpenTelemetry({ a365: { ... } })`
- [ ] Verify scope/baggage imports still come from `@microsoft/agents-a365-observability`
- [ ] Verify environment variables work (names are unchanged)
- [ ] Remove direct `@microsoft/agents-a365-runtime` dependency if no longer needed (it's a transitive dep)
