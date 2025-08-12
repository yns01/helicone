/**
 * Main registry with O(1) endpoint access
 */

import type {
  Endpoint,
  ModelConfig,
  ModelProviderConfig,
  TokenUsage,
  UserEndpointConfig,
} from "./types";
import { buildIndexes, ModelIndexes } from "./build-indexes";
import { buildEndpointUrl, buildModelId } from "./provider-helpers";
import { ProviderName } from "./providers";
import { Result, ok, err } from "../../common/result";
import { ModelName, ModelProviderConfigId, EndpointId } from "./registry-types";

// Import all models and endpoints from authors
import { anthropicModels, anthropicEndpointConfig } from "./authors/anthropic";
import { openaiModels, openaiEndpointConfig } from "./authors/openai";
import { googleModels, googleEndpointConfig } from "./authors/google";

// Combine all models
const allModels = {
  ...anthropicModels,
  ...openaiModels,
  ...googleModels,
} satisfies Record<string, ModelConfig>;

// Combine all endpoint configs
const modelProviderConfigs = {
  ...anthropicEndpointConfig,
  ...openaiEndpointConfig,
  ...googleEndpointConfig,
} satisfies Record<string, ModelProviderConfig>;

const indexes: ModelIndexes = buildIndexes(modelProviderConfigs);

function getModel(modelId: string): Result<ModelConfig> {
  const model = allModels[modelId as ModelName];
  return model ? ok(model) : err(`Model not found: ${modelId}`);
}

function getAllModels(): Result<ModelConfig[]> {
  return ok(Object.values(allModels));
}

function getAllModelIds(): Result<ModelName[]> {
  return ok(Object.keys(allModels) as ModelName[]);
}

function getAllModelsWithIds(): Result<Record<ModelName, ModelConfig>> {
  return ok(allModels);
}

function getPtbEndpointById(
  model: string,
  provider: string,
  endpointConfigId: string = "*"
): Result<Endpoint> {
  const endpointId = `${model}:${provider}:${endpointConfigId}`;
  const endpoint = indexes.endpointIdToEndpoint.get(endpointId as EndpointId);
  return endpoint ? ok(endpoint) : err(`Endpoint not found: ${endpointId}`);
}

function getPtbEndpoints(
  model: string, // Model name (gpt-4o, claude-3-5-haiku, etc)
  provider?: string, // Provider name (openai, anthropic, etc)
  endpointConfigId?: string // Deployment/region name (us-east-1, etc)
): Result<Endpoint[]> {
  // Case 1: Model + Provider + EndpointConfigId - return specific endpoint as array
  if (provider && endpointConfigId) {
    const result = getPtbEndpointById(model, provider, endpointConfigId);
    return result.error ? result : ok([result.data!]);
  }

  // Case 2: Model + Provider - return all endpoints for that provider
  if (provider) {
    return getPtbEndpointsByProvider(model, provider);
  }

  // Case 3: Model only - return all PTB endpoints
  return getPtbEndpointsByModel(model);
}

function getPtbEndpointsByModel(model: string): Result<Endpoint[]> {
  const endpoints = indexes.modelToPtbEndpoints.get(model as ModelName) || [];
  return ok(endpoints);
}

function createFallbackEndpoint(
  modelName: string,
  provider: ProviderName,
  userEndpointConfig: UserEndpointConfig
): Result<Endpoint> {
  const endpointConfig: ModelProviderConfig = {
    providerModelId: modelName,
    ptbEnabled: false,
    provider,
    pricing: {
      prompt: 0,
      completion: 0,
    },
    contextLength: 0,
    maxCompletionTokens: 0,
    supportedParameters: [],
    endpointConfigs: {},
  };

  return buildEndpoint(endpointConfig, userEndpointConfig);
}

function getPtbEndpointsByProvider(
  model: string,
  provider: string
): Result<Endpoint[]> {
  const configId = `${model}:${provider}` as ModelProviderConfigId;
  const endpoints = indexes.modelProviderIdToPtbEndpoints.get(configId) || [];
  return ok(endpoints);
}

function getProviderModels(provider: string): Result<Set<ModelName>> {
  const models =
    indexes.providerToModels.get(provider as ProviderName) || new Set();
  return ok(models);
}

function buildEndpoint(
  endpointConfig: ModelProviderConfig,
  userEndpointConfig: UserEndpointConfig
): Result<Endpoint> {
  const baseUrlResult = buildEndpointUrl(endpointConfig, userEndpointConfig);
  if (baseUrlResult.error) {
    return err(baseUrlResult.error);
  }

  const modelIdResult = buildModelId(endpointConfig, userEndpointConfig);
  if (modelIdResult.error) {
    return err(modelIdResult.error);
  }

  return ok({
    baseUrl: baseUrlResult.data ?? "",
    provider: endpointConfig.provider,
    providerModelId: modelIdResult.data ?? "",
    supportedParameters: endpointConfig.supportedParameters,
    pricing: endpointConfig.pricing,
    contextLength: endpointConfig.contextLength,
    maxCompletionTokens: endpointConfig.maxCompletionTokens,
    ptbEnabled: false,
    version: endpointConfig.version,
  });
}

function getModelProviderConfig(
  model: string,
  provider: string
): Result<ModelProviderConfig> {
  const configId = `${model}:${provider}` as ModelProviderConfigId;
  const config = indexes.endpointConfigIdToEndpointConfig.get(configId);
  return config ? ok(config) : err(`Config not found: ${configId}`);
}

function getModelProviderConfigs(model: string): Result<ModelProviderConfig[]> {
  const configs = indexes.modelToEndpointConfigs.get(model as ModelName) || [];
  return ok(configs);
}

function getModelProviders(model: string): Result<Set<ProviderName>> {
  const providers =
    indexes.modelToProviders.get(model as ModelName) || new Set();
  return ok(providers);
}

function getPtbEndpointsWithIds(model: string, provider: string): Result<Record<string, string>> {
  const result: Record<string, string> = {};
  const prefix = `${model}:${provider}:`;
  
  indexes.endpointIdToEndpoint.forEach((endpoint, endpointId) => {
    if (endpointId.startsWith(prefix) && endpoint.ptbEnabled) {
      const deploymentId = endpointId.substring(prefix.length);
      result[deploymentId] = endpoint.baseUrl;
    }
  });
  
  return ok(result);
}

function computeDimensionCost(
  usage: number | undefined,
  rate: number | undefined
): Result<number, string> {
  if (!usage) return ok(0);
  if (rate === undefined) {
    // if we have usage but no rate, we can't compute the cost,
    // and we should return an error
    return err("Undefined pricing");
  }

  return ok(usage * rate);
}

function computeCacheWriteCost(
  usage: number | { "5m": number; "1h": number; default: number } | undefined,
  pricing: number | { "5m": number; "1h": number; default: number } | undefined,
): Result<number, string> {
  if (!usage) return ok(0);
  if (pricing === undefined) {
    // if we have usage but no pricing, we can't compute the cost,
    // and we should return an error
    return err("Undefined pricing");
  }

  if (typeof pricing === "number" && typeof usage === "number") {
    return ok(usage * pricing);
  }

  if (typeof usage === "object" && typeof pricing === "number") {
    return ok(usage.default * pricing);
  }

  if (typeof pricing === "object" && typeof usage === "object") {
    let cacheWriteCost = pricing.default * usage.default;
    cacheWriteCost += pricing["5m"] * usage["5m"];
    cacheWriteCost += pricing["1h"] * usage["1h"];
    return ok(cacheWriteCost);
  }

  return err("Invalid pricing");
}

function getCost(endpoint: Endpoint, tokenUsage: TokenUsage): Result<number, string> {
  const pricingRates = endpoint.pricing;
  let total = 0;

  // Compute each pricing dimension (except cacheWrite which is handled below)
  const promptCost = computeDimensionCost(tokenUsage.prompt, pricingRates.prompt);
  if (promptCost.error) return err(promptCost.error);
  total += promptCost.data ?? 0;

  const completionCost = computeDimensionCost(tokenUsage.completion, pricingRates.completion);
  if (completionCost.error) return err(completionCost.error);
  total += completionCost.data ?? 0;

  const imageCost = computeDimensionCost(tokenUsage.image, pricingRates.image);
  if (imageCost.error) return err(imageCost.error);
  total += imageCost.data ?? 0;

  const cacheReadCost = computeDimensionCost(tokenUsage.cacheRead, pricingRates.cacheRead);
  if (cacheReadCost.error) return err(cacheReadCost.error);
  total += cacheReadCost.data ?? 0;

  const thinkingCost = computeDimensionCost(tokenUsage.thinking, pricingRates.thinking);
  if (thinkingCost.error) return err(thinkingCost.error);
  total += thinkingCost.data ?? 0;

  const requestCost = computeDimensionCost(tokenUsage.request, pricingRates.request);
  if (requestCost.error) return err(requestCost.error);
  total += requestCost.data ?? 0;

  const audioCost = computeDimensionCost(tokenUsage.audio, pricingRates.audio);
  if (audioCost.error) return err(audioCost.error);
  total += audioCost.data ?? 0;

  const videoCost = computeDimensionCost(tokenUsage.video, pricingRates.video);
  if (videoCost.error) return err(videoCost.error);
  total += videoCost.data ?? 0;

  const webSearchCost = computeDimensionCost(tokenUsage.web_search, pricingRates.web_search);
  if (webSearchCost.error) return err(webSearchCost.error);
  total += webSearchCost.data ?? 0;

  const internalReasoningCost = computeDimensionCost(
    tokenUsage.internal_reasoning,
    pricingRates.internal_reasoning
  );
  if (internalReasoningCost.error) return err(internalReasoningCost.error);
  total += internalReasoningCost.data ?? 0;


  const cacheWriteCost = computeCacheWriteCost(tokenUsage.cacheWrite, pricingRates.cacheWrite);
  if (cacheWriteCost.error) return err(cacheWriteCost.error);
  total += cacheWriteCost.data ?? 0;

  return ok(total);
}

export const registry = {
  getModel,
  getAllModels,
  getAllModelIds,
  getAllModelsWithIds,
  createFallbackEndpoint,
  getPtbEndpoints,
  getPtbEndpointById,
  getPtbEndpointsByModel,
  getPtbEndpointsByProvider,
  getPtbEndpointsWithIds,
  getCost,
  getProviderModels,
  buildEndpoint,
  buildModelId,
  getModelProviderConfig,
  getModelProviderConfigs,
  getModelProviders,
};
