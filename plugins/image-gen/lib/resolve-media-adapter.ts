import { isOpenAICompatibleApi } from "./provider-utils.ts";

export const OPENAI_COMPATIBLE_MEDIA_ADAPTER_ID = "openai-compatible-media";

async function readProviderCredentials(bus, providerId) {
  try {
    return await bus.request("provider:credentials", { providerId });
  } catch {
    return null;
  }
}

function canUseOpenAICompatibleCredentials(creds) {
  return !!creds && !creds.error && isOpenAICompatibleApi(creds.api);
}

function defaultAdapterForProvider(registry, providerId, type) {
  const adapter = registry.get(providerId);
  return adapter?.types?.includes(type) ? adapter : null;
}

function modelIdOf(model) {
  if (typeof model === "string") return model.trim();
  return String(model?.id || "").trim();
}

function capabilityForType(type) {
  return type === "video" ? "video_generation" : `${type}_generation`;
}

async function readModelsByType(bus, type) {
  if (!bus?.request) return [];
  try {
    const result = await bus.request("provider:models-by-type", { type });
    return Array.isArray(result?.models) ? result.models : [];
  } catch {
    return [];
  }
}

async function readProviderCatalog(bus) {
  if (!bus?.request) return [];
  try {
    const result = await bus.request("provider:catalog", {});
    return Array.isArray(result?.providers) ? result.providers : [];
  } catch {
    return [];
  }
}

async function readMediaProviders(bus, type) {
  if (!bus?.request) return {};
  try {
    const result = await bus.request("provider:media-providers", { capability: capabilityForType(type) });
    return result?.providers && typeof result.providers === "object" ? result.providers : {};
  } catch {
    return {};
  }
}

function findProviderMediaModel(providers, providerId, modelId = null) {
  const models = Array.isArray(providers?.[providerId]?.models)
    ? providers[providerId].models
    : [];
  if (!models.length) return null;
  if (!modelId) return models[0] || null;
  return models.find((model) => model?.id === modelId || model?.aliases?.includes?.(modelId)) || null;
}

export async function resolveMediaAdapter({
  registry,
  bus,
  type,
  inputProvider = "",
  inputModel = "",
  defaultModel = null,
  adapterForProvider = defaultAdapterForProvider,
}) {
  const mediaProviders = await readMediaProviders(bus, type);

  const resolveForProvider = async (providerId, modelId = null, model = null) => {
    const selectedModel = model || findProviderMediaModel(mediaProviders, providerId, modelId);
    const adapter = adapterForProvider(registry, providerId, type);
    if (adapter) return { adapter, providerId, modelId: selectedModel?.id || modelId, model: selectedModel };

    const creds = providerId && bus?.request ? await readProviderCredentials(bus, providerId) : null;

    if (canUseOpenAICompatibleCredentials(creds)) {
      const generic = registry.get(OPENAI_COMPATIBLE_MEDIA_ADAPTER_ID);
      if (generic?.types?.includes(type)) return { adapter: generic, providerId, modelId: selectedModel?.id || modelId, model: selectedModel };
    }

    return { adapter: null, providerId, modelId: selectedModel?.id || modelId, model: selectedModel };
  };

  const explicitProvider = String(inputProvider || "").trim();
  if (explicitProvider) return resolveForProvider(explicitProvider, String(inputModel || "").trim() || null);

  const defaultProvider = String(defaultModel?.provider || "").trim();
  if (defaultProvider) {
    const resolved = await resolveForProvider(defaultProvider, defaultModel?.id || null);
    if (resolved.adapter) return resolved;
  }

  for (const provider of Object.values(mediaProviders)) {
    const providerId = String((provider as any)?.providerId || "").trim();
    if (!providerId || (provider as any)?.hasCredentials === false) continue;
    const model = Array.isArray((provider as any)?.models) ? (provider as any).models[0] : null;
    const modelId = modelIdOf(model);
    if (!modelId) continue;
    const resolved = await resolveForProvider(providerId, modelId, model);
    if (resolved.adapter) return resolved;
  }

  const configuredModels = await readModelsByType(bus, type);
  for (const model of configuredModels) {
    const providerId = String(model?.provider || "").trim();
    const modelId = modelIdOf(model);
    if (!providerId || !modelId) continue;
    const resolved = await resolveForProvider(providerId, modelId, model);
    if (resolved.adapter) return resolved;
  }

  const catalog = await readProviderCatalog(bus);
  for (const entry of catalog) {
    const providerId = String(entry?.id || "").trim();
    if (!providerId) continue;
    const models = Array.isArray(entry?.models) ? entry.models : [];
    const model = models.find((model) => {
      const modelType = String(model?.type || "").trim();
      return !modelType || modelType === type;
    }) || models[0];
    const modelId = modelIdOf(model);
    if (!modelId) continue;
    const resolved = await resolveForProvider(providerId, modelId, model);
    if (resolved.adapter) return resolved;
  }

  return { adapter: null, providerId: null, modelId: null, model: null };
}
