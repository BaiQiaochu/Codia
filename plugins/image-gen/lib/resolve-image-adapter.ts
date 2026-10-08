import { openaiCompatibleImageAdapter } from "../adapters/openai-compatible.ts";
import { isOpenAICompatibleApi, resolveKnownModelId } from "./provider-utils.ts";

const IMAGE_DISABLED_PROVIDER_IDS = new Set(["minimax"]);

async function getProviderCredentials(bus, providerId) {
  return bus.request("provider:credentials", { providerId })
    .catch(() => ({ error: "provider_unavailable" }));
}

async function getImageModels(bus, providerId = null) {
  const payload = providerId ? { type: "image", providerId } : { type: "image" };
  const result = await bus.request("provider:models-by-type", payload)
    .catch(() => ({ models: [] }));
  return Array.isArray(result?.models) ? result.models : [];
}

function sameModelId(providerId, candidateModelId, requestedModelId) {
  const candidate = String(candidateModelId || "").trim();
  const requested = String(requestedModelId || "").trim();
  if (!candidate || !requested) return false;
  if (candidate.toLowerCase() === requested.toLowerCase()) return true;

  const resolvedRequested = resolveKnownModelId(providerId, requested, "image");
  return candidate.toLowerCase() === String(resolvedRequested || "").trim().toLowerCase();
}

function supportsImage(adapter) {
  return Array.isArray(adapter?.types) && adapter.types.includes("image");
}

async function resolveProviderAdapter({ registry, bus, providerId, modelId = null, source }) {
  if (IMAGE_DISABLED_PROVIDER_IDS.has(providerId)) return null;

  const direct = registry.get(providerId);
  if (supportsImage(direct)) {
    return { adapter: direct, providerId, modelId, source: "direct" };
  }

  const creds = await getProviderCredentials(bus, providerId);
  if (!creds?.error && isOpenAICompatibleApi(creds.api)) {
    return {
      adapter: openaiCompatibleImageAdapter,
      providerId,
      modelId,
      source,
    };
  }

  return null;
}

async function resolveModelOnlyProvider({ registry, bus, modelId }) {
  const requestedModelId = String(modelId || "").trim();
  if (!requestedModelId) return null;

  const imageModels = await getImageModels(bus);
  for (const model of imageModels) {
    const providerId = String(model?.provider || "").trim();
    const candidateModelId = String(model?.id || "").trim();
    if (!providerId || !candidateModelId) continue;
    if (!sameModelId(providerId, candidateModelId, requestedModelId)) continue;

    const resolved = await resolveProviderAdapter({
      registry,
      bus,
      providerId,
      modelId: candidateModelId,
      source: "input-model",
    });
    if (resolved) return resolved;
  }

  return null;
}

export async function resolveImageAdapter({ registry, bus, inputProvider, inputModel, defaultImageModel }) {
  const explicitProvider = String(inputProvider || "").trim();
  const explicitModel = String(inputModel || "").trim();
  const configuredDefaultProvider = String(defaultImageModel?.provider || "").trim();

  if (explicitProvider) {
    const resolved = await resolveProviderAdapter({
      registry,
      bus,
      providerId: explicitProvider,
      modelId: explicitModel || (configuredDefaultProvider === explicitProvider ? defaultImageModel?.id || null : null),
      source: "openai-compatible",
    });
    if (resolved) return resolved;

    return { adapter: null, providerId: explicitProvider, modelId: null, source: "missing" };
  }

  if (explicitModel) {
    const resolved = await resolveModelOnlyProvider({ registry, bus, modelId: explicitModel });
    if (resolved) return resolved;
  }

  if (configuredDefaultProvider) {
    const resolved = await resolveProviderAdapter({
      registry,
      bus,
      providerId: configuredDefaultProvider,
      modelId: explicitModel || defaultImageModel?.id || null,
      source: "openai-compatible",
    });
    if (resolved) return resolved;
  }

  const imageModels = await getImageModels(bus);
  for (const model of imageModels) {
    const providerId = String(model?.provider || "").trim();
    const modelId = String(model?.id || "").trim();
    if (!providerId || !modelId) continue;

    const resolved = await resolveProviderAdapter({
      registry,
      bus,
      providerId,
      modelId,
      source: "image-model",
    });
    if (resolved) return resolved;
  }

  return { adapter: null, providerId: null, modelId: null, source: "missing" };
}
