// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import "@microsoft/opentelemetry/loader";
import {
  shutdownMicrosoftOpenTelemetry,
  useMicrosoftOpenTelemetry,
} from "@microsoft/opentelemetry";

if (!process.env.APPLICATIONINSIGHTS_CONNECTION_STRING) {
  throw new Error("APPLICATIONINSIGHTS_CONNECTION_STRING is required");
}

useMicrosoftOpenTelemetry({
  azureMonitor: {
    azureMonitorExporterOptions: {
      connectionString: process.env.APPLICATIONINSIGHTS_CONNECTION_STRING,
    },
    enableLiveMetrics: false,
  },
  enableSensitiveData: process.env.ENABLE_SENSITIVE_DATA === "true",
  instrumentationOptions: {
    langchain: {
      enabled: true,
    },
  },
});

export async function shutdownTelemetry() {
  await shutdownMicrosoftOpenTelemetry();
}
