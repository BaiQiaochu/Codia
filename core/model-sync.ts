// @ts-nocheck
import fs from "fs";
import { getPiModel } from "../lib/pi-sdk/index.ts";
import { lookupKnown } from "../shared/known-models.ts";
import { atomicWriteSync } from "../shared/safe-fs.ts";
import {
  normalizeVisionCapabilities,
  withThinkingFormatCompat,
} from "../shared/model-capabilities.ts";
import {
  normalizeProviderApiKey,
  normalizeProviderHeaders,
  providerCredentialAllowsMissingApiKey,
} from "../shared/provider-auth.ts";
import { validateProviderModels } from "../shared/provider-model-validation.ts";
import { normalizeProviderBaseUrl, shouldUseBearerAuth } from "../shared/provider-endpoints.ts";
import { normalizeThinkingLevelForModel } from "./session-thinking-level.ts";

const DEFAULT_CONTEXT_WINDOW = 128_000;
const THIRD_PARTY_SAFE_OUTPUT_TOKENS = 64_000;
const PI_BUILTIN_PROVIDER_REUSE = new Set(["kimi-coding"]);

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function lower(value) {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function humanizeName(id) {
  let name = String(id || "").replace(/-(\d{6})$/, "");
  name = name.replace(/[-_]/g, " ").replace(/\b\w/g, c => c.toUpperCase());
  name = name.replace(/(\d) (\d)/g, "$1.$2");
  return name;
}

function extractApiKey(entry) {
  if (!entry) return "";
  if (typeof entry === "string") return entry;
  if (typeof entry?.apiKey === "string") return entry.apiKey;
  if (typeof entry?.access === "string") return entry.access;
  if (typeof entry?.token === "string") return entry.token;
  return "";
}

function getModelId(modelEntry) {
  return typeof modelEntry === "object" && modelEntry !== null ? modelEntry.id : modelEntry;
}

function getProviderModelDefaultThinkingLevel(modelDefaults, modelId) {
  if (!modelDefaults || !modelId) return undefined;
  const entry = modelDefaults[modelId];
  const level = entry?.thinking_level ?? entry?.thinkingLevel;
  return typeof level === "string" ? level : undefined;
}

function buildPiInputModalities({ image = false } = {}) {
  return [
    "text",
    ...(image ? ["image"] : []),
  ];
}

function addCompat(model, patch) {
  return {
    ...model,
    compat: {
      ...(isPlainObject(model.compat) ? model.compat : {}),
      ...patch,
    },
  };
}

function withHanaVideoInputCompat(model, enabled) {
  if (!isPlainObject(model) || enabled !== true) return model;
  if (model.compat?.hanaVideoInput === true) return model;
  return addCompat(model, { hanaVideoInput: true });
}

function withHanaAudioInputCompat(model, enabled) {
  if (!isPlainObject(model) || enabled !== true) return model;
  if (model.compat?.hanaAudioInput === true) return model;
  return addCompat(model, { hanaAudioInput: true });
}

function normalizeProviderBaseUrlForRuntime({ provider, baseUrl, api } = {}) {
  const raw = String(baseUrl || "").trim();
  if (!raw) return raw;

  const providerId = lower(provider);
  if (
    (providerId === "ollama" && api === "openai-completions")
    || (
      api === "anthropic-messages"
      && (providerId === "minimax" || providerId === "minimax-token-plan")
    )
  ) {
    return normalizeProviderBaseUrl({ provider, baseUrl: raw, api });
  }

  return raw;
}

function isZhipuOpenAICompat(provider, baseUrl, api) {
  return api === "openai-completions" && (
    provider === "zhipu"
    || lower(baseUrl).includes("open.bigmodel.cn")
  );
}

function buildModelOverride(modelEntry, modelDefaults = {}) {
  const modelDefaultThinkingLevel = getProviderModelDefaultThinkingLevel(modelDefaults, getModelId(modelEntry));
  if (typeof modelEntry !== "object" || modelEntry === null) {
    return modelDefaultThinkingLevel !== undefined
      ? { defaultThinkingLevel: modelDefaultThinkingLevel }
      : null;
  }

  const override = {};
  if (modelEntry.name !== undefined) override.name = modelEntry.name;
  if (modelEntry.context !== undefined) override.contextWindow = modelEntry.context;
  if (modelEntry.contextWindow !== undefined) override.contextWindow = modelEntry.contextWindow;
  if (modelEntry.maxOutput !== undefined) override.maxTokens = modelEntry.maxOutput;
  if (modelEntry.maxTokens !== undefined) override.maxTokens = modelEntry.maxTokens;
  const defaultThinkingLevel = modelEntry.defaultThinkingLevel ?? modelDefaultThinkingLevel;
  if (defaultThinkingLevel !== undefined) override.defaultThinkingLevel = defaultThinkingLevel;

  const image = modelEntry.image ?? modelEntry.vision;
  const video = modelEntry.video;
  const audio = modelEntry.audio;
  if (image !== undefined || video !== undefined || audio !== undefined) {
    override.input = buildPiInputModalities({ image: image === true });
  }
  if (modelEntry.reasoning !== undefined) override.reasoning = modelEntry.reasoning;

  let finalOverride = video === true ? withHanaVideoInputCompat(override, true) : override;
  finalOverride = audio === true ? withHanaAudioInputCompat(finalOverride, true) : finalOverride;
  return Object.keys(finalOverride).length > 0 ? finalOverride : null;
}

function getPiBuiltinModel(provider, modelId) {
  if (!PI_BUILTIN_PROVIDER_REUSE.has(provider) || !modelId) return null;
  try {
    return getPiModel(provider, modelId) || null;
  } catch {
    return null;
  }
}

function shouldReusePiBuiltinModel(provider, modelId, api) {
  return api === "anthropic-messages" && !!getPiBuiltinModel(provider, modelId);
}

function modelTypeFor(provider, modelEntry) {
  const isObj = typeof modelEntry === "object" && modelEntry !== null;
  const id = getModelId(modelEntry);
  const known = lookupKnown(provider, id);
  return (isObj && modelEntry.type) || known?.type || "chat";
}

function filterChatModelEntries(provider, models) {
  return models.filter(model => modelTypeFor(provider, model) === "chat");
}

function buildModelEntry(modelEntry, provider, baseUrl = "", api = "openai-completions", modelDefaults = {}) {
  const isObj = typeof modelEntry === "object" && modelEntry !== null;
  const id = getModelId(modelEntry);
  const known = lookupKnown(provider, id);
  const piBuiltin = getPiBuiltinModel(provider, id);

  const userImage = isObj ? (modelEntry.image ?? modelEntry.vision) : undefined;
  const knownImage = known?.image ?? known?.vision;
  const image = userImage !== undefined ? userImage : (knownImage === true);
  const userVideo = isObj ? modelEntry.video : undefined;
  const knownVideo = known?.video;
  const video = userVideo !== undefined ? userVideo : (knownVideo === true);
  const userAudio = isObj ? modelEntry.audio : undefined;
  const knownAudio = known?.audio;
  const audio = userAudio !== undefined ? userAudio : (knownAudio === true);

  const entry = {
    id,
    name: (isObj && modelEntry.name) || known?.name || humanizeName(id),
    input: buildPiInputModalities({ image: image === true }),
    contextWindow: (isObj && modelEntry.context) || known?.context || DEFAULT_CONTEXT_WINDOW,
    reasoning: (isObj && modelEntry.reasoning !== undefined)
      ? modelEntry.reasoning
      : (known?.reasoning === true),
  };

  const maxOutput = (isObj && modelEntry.maxOutput) || known?.maxOutput;
  if (maxOutput) entry.maxTokens = maxOutput;
  if (!entry.maxTokens && provider === "sglang") entry.maxTokens = THIRD_PARTY_SAFE_OUTPUT_TOKENS;

  const defaultThinkingLevel = isObj
    ? (modelEntry.defaultThinkingLevel ?? getProviderModelDefaultThinkingLevel(modelDefaults, id))
    : getProviderModelDefaultThinkingLevel(modelDefaults, id);
  if (defaultThinkingLevel !== undefined) {
    entry.defaultThinkingLevel = normalizeThinkingLevelForModel(
      defaultThinkingLevel,
      { ...entry, provider, api, baseUrl },
    );
  }

  if (known?.quirks?.length) entry.quirks = known.quirks;
  if (piBuiltin?.headers) entry.headers = { ...piBuiltin.headers };
  if (provider === "kimi-coding" && api === "openai-completions") {
    entry.headers = { ...(entry.headers || {}), "User-Agent": "KimiCLI/1.5" };
  }

  const rawVisionCapabilities = isObj && modelEntry.visionCapabilities !== undefined
    ? modelEntry.visionCapabilities
    : known?.visionCapabilities;
  const visionCapabilities = image ? normalizeVisionCapabilities(rawVisionCapabilities) : null;
  if (visionCapabilities) entry.visionCapabilities = visionCapabilities;

  if (provider !== "openai") {
    const explicitCompat = isObj && isPlainObject(modelEntry.compat) ? modelEntry.compat : {};
    const compat = { ...explicitCompat, supportsDeveloperRole: false };
    if (api === "openai-completions" && (
      provider === "gemini"
      || baseUrl.includes("generativelanguage.googleapis.com")
    )) {
      compat.supportsStore = false;
    }
    if (isZhipuOpenAICompat(provider, baseUrl, api)) {
      compat.supportsStore = false;
      compat.supportsReasoningEffort = false;
      compat.thinkingFormat = compat.thinkingFormat || "zhipu";
      compat.reasoningProfile = compat.reasoningProfile || "zhipu-openai";
    }
    entry.compat = compat;
  } else if (isObj && isPlainObject(modelEntry.compat)) {
    entry.compat = { ...modelEntry.compat };
  }

  let mediaAwareEntry = video === true ? withHanaVideoInputCompat(entry, true) : entry;
  mediaAwareEntry = audio === true ? withHanaAudioInputCompat(mediaAwareEntry, true) : mediaAwareEntry;
  return withThinkingFormatCompat(mediaAwareEntry, { provider, api, baseUrl });
}

export function syncModels(providers, opts = {}) {
  const modelsJsonPath = opts.modelsJsonPath;
  const authJsonPath = opts.authJsonPath;
  const oauthKeyMap = opts.oauthKeyMap || {};
  const chatProjectionMap = opts.chatProjectionMap || {};

  let authJson;
  function getAuthJson() {
    if (authJson !== undefined) return authJson;
    if (!authJsonPath) {
      authJson = {};
      return authJson;
    }
    try {
      authJson = JSON.parse(fs.readFileSync(authJsonPath, "utf-8")) || {};
    } catch {
      authJson = {};
    }
    return authJson;
  }

  const newProviders = {};

  for (const [name, p] of Object.entries(providers || {})) {
    const projection = chatProjectionMap[name] || "models-json";
    if (projection === "sdk-auth-alias" || projection === "none") continue;
    if (!p.base_url) continue;
    if (!p.models || p.models.length === 0) continue;
    validateProviderModels(name, p.models, { baseUrl: p.base_url });

    let apiKey = normalizeProviderApiKey(p.api_key);
    const hasLiteralApiKey = apiKey.length > 0;
    if (!apiKey) {
      const authKey = oauthKeyMap[name] || name;
      apiKey = normalizeProviderApiKey(extractApiKey(getAuthJson()[authKey]));
    }

    const headers = normalizeProviderHeaders(p.headers);
    const hasHeaders = Object.keys(headers).length > 0;
    if (!apiKey && !hasHeaders && !providerCredentialAllowsMissingApiKey({
      authType: p.auth_type,
      baseUrl: p.base_url,
    })) {
      continue;
    }

    const effectiveApiKey = apiKey || (hasHeaders ? "headers" : "local");
    const effectiveApi = p.api || "openai-completions";
    const effectiveBaseUrl = normalizeProviderBaseUrlForRuntime({
      provider: name,
      baseUrl: p.base_url,
      api: effectiveApi,
    });
    const modelDefaults = p.model_defaults || {};
    const chatModels = filterChatModelEntries(name, p.models);
    const customModels = [];
    const modelOverrides = {};

    for (const modelEntry of chatModels) {
      const id = getModelId(modelEntry);
      if (shouldReusePiBuiltinModel(name, id, effectiveApi)) {
        const override = buildModelOverride(modelEntry, modelDefaults);
        if (override) modelOverrides[id] = override;
        continue;
      }
      customModels.push(buildModelEntry(modelEntry, name, effectiveBaseUrl, effectiveApi, modelDefaults));
    }

    const providerConfig = {
      baseUrl: effectiveBaseUrl,
      api: effectiveApi,
      // Secret values now live in ModelRuntime's credential overlay. Do not
      // serialize synthetic key references into models.json: PI 1.x treats
      // config keys as literal/template values and correctly gives credentials
      // precedence when the configured key is absent.
      ...(!hasLiteralApiKey && !hasHeaders && effectiveApiKey === "local"
        ? { apiKey: effectiveApiKey }
        : {}),
    };
    if (shouldUseBearerAuth({ provider: name, api: effectiveApi, baseUrl: effectiveBaseUrl })) {
      providerConfig.authHeader = true;
    }
    if (hasHeaders) providerConfig.headers = headers;
    if (customModels.length > 0) providerConfig.models = customModels;
    if (Object.keys(modelOverrides).length > 0) providerConfig.modelOverrides = modelOverrides;

    newProviders[name] = providerConfig;
  }

  const newJson = { providers: newProviders };
  const newStr = JSON.stringify(newJson, null, 4) + "\n";

  let oldStr = "";
  try {
    oldStr = fs.readFileSync(modelsJsonPath, "utf-8");
  } catch {
    // Missing file means it needs to be written.
  }
  if (oldStr === newStr) return false;

  atomicWriteSync(modelsJsonPath, newStr);
  return true;
}
