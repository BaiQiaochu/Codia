// @ts-nocheck
import { inferMediaTypeFromModelId } from "../../../shared/model-type-inference.ts";
import { OPENAI_IMAGE_MODELS } from "../../../shared/openai-image-models.ts";

function isLocalBaseUrl(url = "") {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(String(url || ""));
}

export function isLocalOpenAICompatibleProvider(entry = {}) {
  return isOpenAICompatibleApi(entry.api) && isLocalBaseUrl(entry.baseUrl || entry.base_url || "");
}

const MEDIA_TYPES = ["image", "audio", "music", "video"];
const DISABLED_PROVIDER_TYPES = {
  minimax: new Set(["image"]),
};

export const IMAGE_PROVIDER_PRESETS = [
  { id: "volcengine", displayName: "Volcengine (Doubao)" },
  { id: "openai", displayName: "OpenAI" },
  { id: "minimax", displayName: "MiniMax" },
  { id: "comfyui", displayName: "ComfyUI", credentialsOptional: true, defaultBaseUrl: "http://127.0.0.1:8188" },
];

export const KNOWN_MODELS_BY_TYPE = {
  image: {
    volcengine: [
      { id: "doubao-seedream-3-0-t2i", name: "Seedream 3.0", type: "image" },
      { id: "doubao-seedream-4-0-250828", name: "Seedream 4.0", type: "image" },
      { id: "doubao-seedream-4-5-251128", name: "Seedream 4.5", type: "image" },
      { id: "doubao-seedream-5-0", name: "Seedream 5.0", type: "image" },
      { id: "doubao-seedream-5-0-pro", name: "Seedream 5.0 Pro", type: "image" },
      { id: "doubao-seedream-5-0-lite-260128", name: "Seedream 5.0 Lite", type: "image" },
    ],
    openai: [
      ...OPENAI_IMAGE_MODELS.map((model) => ({
        ...model,
        type: "image",
        ...(model.id === "gpt-image-1.5" ? { default: true } : {}),
      })),
      { id: "gptimage2", name: "GPT Image 2", type: "image" },
      { id: "dall-e-3", name: "DALL-E 3", type: "image" },
    ],
    comfyui: [
      { id: "workflow", name: "ComfyUI Workflow", type: "image" },
    ],
  },
  audio: {
    minimax: [
      { id: "speech-2.8-hd", name: "MiniMax Speech 2.8 HD", type: "audio" },
      { id: "speech-2.8-turbo", name: "MiniMax Speech 2.8 Turbo", type: "audio" },
    ],
  },
  music: {
    minimax: [
      { id: "music-2.6", name: "MiniMax Music 2.6", type: "music" },
    ],
  },
  video: {
    volcengine: [
      { id: "doubao-seedance-2-0-260128", name: "Seedance 2.0", type: "video" },
    ],
  },
};

export const KNOWN_IMAGE_MODELS = KNOWN_MODELS_BY_TYPE.image;

const IMAGE_MODEL_ALIASES = {
  volcengine: {
    "3.0": "doubao-seedream-3-0-t2i",
    "4.0": "doubao-seedream-4-0-250828",
    "4.5": "doubao-seedream-4-5-251128",
    "5.0": "doubao-seedream-5-0",
    "5.0-pro": "doubao-seedream-5-0-pro",
    "5.0-lite": "doubao-seedream-5-0-lite-260128",
  },
  openai: {
    "1": "gpt-image-1",
    "1.5": "gpt-image-1.5",
    "1-mini": "gpt-image-1-mini",
    mini: "gpt-image-1-mini",
    "2": "gpt-image-2",
    dalle3: "dall-e-3",
    "dall-e-3": "dall-e-3",
  },
};

export function resolveKnownModelId(providerId, raw, type = "image") {
  const value = String(raw || "").trim();
  const catalog = KNOWN_MODELS_BY_TYPE[type]?.[providerId] || [];
  if (!value || !catalog.length) return value;

  if (catalog.some((model) => model?.id === value)) return value;

  const alias = IMAGE_MODEL_ALIASES[providerId]?.[value.toLowerCase()];
  if (alias && catalog.some((model) => model?.id === alias)) return alias;

  return value;
}

export function isOpenAICompatibleApi(api = "") {
  const normalized = String(api || "").trim().toLowerCase();
  return normalized === "openai-completions" || normalized === "openai";
}

export function normalizeProviderModels(models = [], fallbackType = null) {
  return models
    .map((model) => {
      if (!model) return null;
      if (typeof model === "string") {
        const id = model.trim();
        if (!id) return null;
        return fallbackType ? { id, name: id, type: fallbackType } : { id, name: id };
      }
      const id = String(model.id || "").trim();
      if (!id) return null;
      const type = String(model.type || fallbackType || "").trim();
      const result = {
        id,
        name: model.name || model.displayName || id,
        ...(model.protocolId ? { protocolId: model.protocolId } : {}),
        ...(model.credentialLaneId ? { credentialLaneId: model.credentialLaneId } : {}),
      };
      return type ? { ...result, type } : result;
    })
    .filter(Boolean);
}

export function dedupeModels(models = []) {
  const seen = new Set();
  const result = [];
  for (const model of models) {
    const id = String(model?.id || "").trim();
    const type = String(model?.type || "").trim();
    const key = `${type}:${id}`;
    if (!id || seen.has(key)) continue;
    seen.add(key);
    const next = {
      id,
      name: model.name || model.displayName || id,
      ...(model.protocolId ? { protocolId: model.protocolId } : {}),
      ...(model.credentialLaneId ? { credentialLaneId: model.credentialLaneId } : {}),
    };
    result.push(type ? { ...next, type } : next);
  }
  return result;
}

function modelsByProvider(models = [], type) {
  const byProvider = new Map();
  for (const model of models || []) {
    const providerId = String(model?.provider || "").trim();
    const id = String(model?.id || "").trim();
    if (!providerId || !id) continue;
    const current = byProvider.get(providerId) || [];
    current.push({
      id,
      name: model.name || model.displayName || id,
      type,
      ...(model.protocolId ? { protocolId: model.protocolId } : {}),
      ...(model.credentialLaneId ? { credentialLaneId: model.credentialLaneId } : {}),
    });
    byProvider.set(providerId, current);
  }
  return byProvider;
}

function knownModels(providerId, type) {
  return KNOWN_MODELS_BY_TYPE[type]?.[providerId] || [];
}

function providerSupportsType(providerId, type) {
  return !DISABLED_PROVIDER_TYPES[providerId]?.has(type);
}

function configuredModelsForType(entry, providerId, type) {
  return normalizeProviderModels(entry.models || [])
    .map((model) => {
      if (model.type) return model;
      const inferredType = inferMediaTypeFromModelId(model.id, providerId);
      if (inferredType) return { ...model, type: inferredType };
      return model;
    })
    .filter((model) => model.type === type);
}

function candidatesForType({ entry = {}, providerId, type, addedModels = [] }) {
  if (!providerSupportsType(providerId, type)) {
    return {
      configuredCandidates: [],
      availableModels: [],
    };
  }
  const addedKeys = new Set(addedModels.map((model) => `${model.type || type}:${model.id}`));
  const configuredCandidates = configuredModelsForType(entry, providerId, type)
    .filter((model) => !addedKeys.has(`${model.type || type}:${model.id}`));
  return {
    configuredCandidates,
    availableModels: [],
  };
}

function buildProviderResult({ providerId, entry = {}, preset = null, modelsByType = {} }) {
  const typeData = {};
  for (const type of MEDIA_TYPES) {
    const addedModels = providerSupportsType(providerId, type)
      ? dedupeModels(modelsByType[type]?.get(providerId) || [])
      : [];
    const { configuredCandidates, availableModels } = candidatesForType({
      entry,
      providerId,
      type,
      addedModels,
    });
    typeData[type] = { addedModels, configuredCandidates, availableModels };
  }

  const hasAnyModel = MEDIA_TYPES.some((type) => typeData[type].addedModels.length > 0);
  const baseUrl = entry.baseUrl || entry.base_url || preset?.defaultBaseUrl || "";
  const shouldInclude =
    hasAnyModel;

  if (!shouldInclude) return null;

  const hasCredentials = !!entry.hasCredentials
    || !!preset?.credentialsOptional
    || isLocalBaseUrl(baseUrl);

  return {
    providerId,
    displayName: preset?.displayName || entry.displayName || providerId,
    hasCredentials,
    baseUrl,
    api: entry.api || "",
    isLocalOpenAICompatible: isLocalOpenAICompatibleProvider({ ...entry, baseUrl }),
    imageModels: typeData.image.addedModels,
    audioModels: typeData.audio.addedModels,
    musicModels: typeData.music.addedModels,
    videoModels: typeData.video.addedModels,
    availableImageModels: typeData.image.availableModels,
    availableAudioModels: typeData.audio.availableModels,
    availableMusicModels: typeData.music.availableModels,
    availableVideoModels: typeData.video.availableModels,
    models: typeData.image.addedModels,
    availableModels: typeData.image.availableModels,
  };
}

export function buildMediaProviders({
  catalog = [],
  imageModels = [],
  audioModels = [],
  musicModels = [],
  videoModels = [],
} = {}) {
  const result = {};
  const presetMap = new Map(IMAGE_PROVIDER_PRESETS.map((preset) => [preset.id, preset]));
  const groupedModels = {
    image: modelsByProvider(imageModels, "image"),
    audio: modelsByProvider(audioModels, "audio"),
    music: modelsByProvider(musicModels, "music"),
    video: modelsByProvider(videoModels, "video"),
  };

  for (const entry of catalog || []) {
    const providerId = String(entry?.id || "").trim();
    if (!providerId) continue;
    const provider = buildProviderResult({
      providerId,
      entry,
      preset: presetMap.get(providerId),
      modelsByType: groupedModels,
    });
    if (provider) result[providerId] = provider;
  }

  return result;
}
