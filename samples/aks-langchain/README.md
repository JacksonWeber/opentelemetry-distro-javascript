# LangChain auto-instrumentation on AKS

This sample deploys a Node.js LangChain application to Azure Kubernetes Service
(AKS) and exports GenAI spans to Azure Monitor Application Insights through the
Microsoft OpenTelemetry distribution.

The pod sets:

```text
NODE_OPTIONS=--import ./telemetry.mjs
```

The preload imports `@microsoft/opentelemetry/loader` and configures the SDK
before the application and LangChain modules load, allowing their operations to
be auto-instrumented.

> Do not combine this loader-based setup with AKS managed codeless
> instrumentation on the same workload. Using both can produce duplicate
> telemetry.

## Prerequisites

- Node.js 22 or later for local runs
- An Azure subscription with:
  - an AKS cluster
  - an Azure Container Registry (ACR)
  - an Application Insights resource
  - an Azure OpenAI resource and deployed chat model
- Azure CLI, `kubectl`, and Docker

## Build and push the image

Run this command from `samples/aks-langchain`, replacing `<acr-name>`:

```bash
az acr build \
  --registry <acr-name> \
  --image langchain-aks-sample:1.0.0 \
  .
```

Allow the AKS cluster to pull from the registry:

```bash
az aks update \
  --resource-group <resource-group> \
  --name <aks-cluster> \
  --attach-acr <acr-name>

az aks get-credentials \
  --resource-group <resource-group> \
  --name <aks-cluster>
```

## Create the Kubernetes secret

Create the namespace:

```bash
kubectl create namespace langchain-aks
```

Create the secret consumed by `deployment.yaml`:

```bash
kubectl create secret generic langchain-aks-secrets \
  --namespace langchain-aks \
  --from-literal=applicationinsights-connection-string="<application-insights-connection-string>" \
  --from-literal=azure-openai-api-key="<azure-openai-api-key>" \
  --from-literal=azure-openai-instance-name="<azure-openai-resource-name>" \
  --from-literal=azure-openai-deployment-name="<azure-openai-deployment-name>"
```

For production workloads, use a managed secret provider such as the Azure Key
Vault provider for the Secrets Store CSI Driver instead of command-line
literals.

## Deploy to AKS

In `deployment.yaml`, replace `YOUR_ACR_NAME` with the ACR name used to build
the image, then apply the manifest:

```bash
kubectl apply -f deployment.yaml
kubectl rollout status deployment/langchain-aks-sample --namespace langchain-aks
```

The manifest injects the loader through `NODE_OPTIONS`, sets a stable
`OTEL_SERVICE_NAME`, reads credentials from the Kubernetes secret, and keeps
sensitive LangChain message capture disabled.

## Invoke the sample

Forward the internal service locally:

```bash
kubectl port-forward service/langchain-aks-sample 3000:80 --namespace langchain-aks
```

In another terminal:

```bash
curl --request POST http://localhost:3000/invoke \
  --header "content-type: application/json" \
  --data '{"prompt":"Explain OpenTelemetry in one sentence."}'
```

The response contains the model output. The corresponding LangChain chat span
is exported to Application Insights with GenAI attributes such as request and
response model, response ID, token usage, and finish reasons when supplied by
the provider.

## Troubleshooting

Inspect the pod and application logs:

```bash
kubectl get pods --namespace langchain-aks
kubectl logs deployment/langchain-aks-sample --namespace langchain-aks
```

If the pod does not start, verify that all four secret keys exist and that the
AKS cluster can pull from ACR. If requests work but telemetry is absent, verify
the Application Insights connection string and confirm that the pod has
outbound access to Azure Monitor ingestion endpoints.
