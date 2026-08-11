// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { createServer } from "node:http";
import { HumanMessage } from "@langchain/core/messages";
import { AzureChatOpenAI } from "@langchain/openai";
import { shutdownTelemetry } from "./telemetry.mjs";

const requiredEnvironmentVariables = [
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_INSTANCE_NAME",
  "AZURE_OPENAI_DEPLOYMENT_NAME",
];

const missingEnvironmentVariables = requiredEnvironmentVariables.filter(
  (name) => !process.env[name],
);

if (missingEnvironmentVariables.length > 0) {
  throw new Error(
    `Missing required environment variables: ${missingEnvironmentVariables.join(", ")}`,
  );
}

const port = Number.parseInt(process.env.PORT ?? "3000", 10);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`PORT must be an integer between 1 and 65535; received "${process.env.PORT}"`);
}

const model = new AzureChatOpenAI({
  model: process.env.AZURE_OPENAI_MODEL ?? "gpt-4o",
  temperature: 0,
  azureOpenAIApiKey: process.env.AZURE_OPENAI_API_KEY,
  azureOpenAIApiInstanceName: process.env.AZURE_OPENAI_INSTANCE_NAME,
  azureOpenAIApiDeploymentName: process.env.AZURE_OPENAI_DEPLOYMENT_NAME,
  azureOpenAIApiVersion: process.env.AZURE_OPENAI_API_VERSION ?? "2024-06-01",
});

function writeJson(response, statusCode, body) {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

class RequestError extends Error {}

async function readPrompt(request) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 16_384) {
      throw new RequestError("Request body exceeds the 16 KB limit");
    }
    chunks.push(buffer);
  }

  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new RequestError("Request body must be valid JSON");
  }

  if (typeof parsed.prompt !== "string" || parsed.prompt.trim().length === 0) {
    throw new RequestError('Request body must contain a non-empty string property named "prompt"');
  }

  return parsed.prompt;
}

const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/healthz") {
    writeJson(response, 200, { status: "ok" });
    return;
  }

  if (request.method !== "POST" || request.url !== "/invoke") {
    writeJson(response, 404, { error: "Use POST /invoke or GET /healthz" });
    return;
  }

  try {
    const prompt = await readPrompt(request);
    const result = await model.invoke([new HumanMessage(prompt)]);
    writeJson(response, 200, { content: result.content });
  } catch (error) {
    if (error instanceof RequestError) {
      writeJson(response, 400, { error: error.message });
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    console.error("LangChain invocation failed:", message);
    writeJson(response, 502, { error: "LangChain invocation failed" });
  }
});

server.listen(port, () => {
  console.log(`LangChain AKS sample listening on port ${port}`);
});

let isShuttingDown = false;
async function shutdown(signal) {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  console.log(`Received ${signal}; shutting down`);

  server.close(async (error) => {
    if (error) {
      console.error("HTTP server shutdown failed:", error);
    }

    await shutdownTelemetry();
    process.exitCode = error ? 1 : 0;
  });
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
