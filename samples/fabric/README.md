# Fabric Demo

Express app that sends traces, metrics, and logs to Microsoft Fabric Real-Time Intelligence (or Azure Data Explorer) via an OpenTelemetry Collector.

Use patched Node.js: 22.23.4+ on 22.x, 24.22.1+ on 24.x, or 26.12.1+ on 26.x.
See the [runtime requirements](../../README.md#nodejs-runtime-requirements).

## How to run

### 1. Start the OTel Collector

Edit `collector-config.yaml` — replace `<your-cluster>` and `<yourdbname>` with your values.

```bash
# Download otelcol-contrib from
# https://github.com/open-telemetry/opentelemetry-collector-releases/releases
az login
otelcol-contrib --config collector-config.yaml
```

### 2. Run the app

In a second terminal:

```bash
npm install
npm start
```

Or run directly:

```bash
npm install
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 node --import @microsoft/opentelemetry/loader app.mjs
```

### 3. Send requests

```bash
curl http://localhost:3000/
curl http://localhost:3000/weather
```

### 4. Query your data

In the [ADX web UI](https://dataexplorer.azure.com/):

```kql
OTELTraces | take 10
OTELLogs | take 10
OTELMetrics | take 10
```

## Full guide

See [docs/fabric-getting-started.md](../../docs/fabric-getting-started.md) for table creation, permissions, authentication options, and deployment guidance.
