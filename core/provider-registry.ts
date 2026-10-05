/**
 * ProviderRegistry -声明-provider 插件注册- *
 * 职责- * - 管理所有已-provider 的静态声明（能力、协议、认证类型）
 * - 将插件声明与 added-models.yaml 用户配置合并-ProviderEntry
 * - 读取 provider 凭证（api_key / base_url / api- * - 管理 provider 的模型列表（CRUD + 持久化）
 *
 * 设计来源：OpenClaw 的插件注册表模式
 */

import fs from "fs";
import path from "path";
import YAML from "js-yaml";
import { safeReadYAMLSync } from "../shared/safe-fs.ts";
import { fromRoot } from "../shared/app-root.ts";
import { lookupKnown } from "../shared/known-models.ts";
import { normalizeModelType, resolveModelTypeFromModelId } from "../shared/model-type-inference.ts";
import {
  assertValidProviderCredentialPatch,
  normalizeProviderApiKey,
  normalizeProviderHeaders,
  normalizeProviderAuthType,
  providerCredentialAllowsMissingApiKey,
} from "../shared/provider-auth.ts";
import { validateProviderModels } from "../shared/provider-model-validation.ts";
import {
  normalizeModelProtocolCompat,
  normalizeToolUseContract,
  normalizeVisionCapabilities,
} from "../shared/model-capabilities.ts";
import { validateProviderRuntime } from "./media-runtime-contract.ts";
import { capabilityKey, inferMediaProtocolId, MEDIA_CAPABILITY_KEYS } from "./media-protocols.ts";
import { ProviderCatalogStore } from "./provider-catalog.ts";
import {
  isLocalProviderPlugin,
  isSafeLocalProviderPluginProviderId,
  LocalProviderPluginStore,
  mergeProviderModelEntries,
  providerConfigHasLocalDefinition,
  providerPluginToCatalogDefinition,
  splitLocalProviderConfig,
} from "./local-provider-plugin-store.ts";

const _defaultModels = JSON.parse(
  fs.readFileSync(fromRoot("lib", "default-models.json"), "utf-8"),
);

const MALFORMED_PROVIDER_CONFIG = "malformed_provider_config";
const INVALID_MODELS_CONFIG = "invalid_models_config";
const DELETED_PROVIDERS_KEY = "_deleted_providers";
const PROVIDER_RUNTIME_META_KEYS = new Set(["_config_error"]);
const THINKING_LEVEL_VALUES = new Set(["auto", "off", "low", "medium", "high", "xhigh"]);
const MEDIA_USER_CONFIG_KEYS = {
  imageGeneration: "image_generation",
  videoGeneration: "video_generation",
  speechGeneration: "speech_generation",
  speechRecognition: "speech_recognition",
  musicGeneration: "music_generation",
};
const MEDIA_TYPE_SET = new Set(["image", "video", "audio", "speech", "music"]);
const MEDIA_MODEL_FIELD_KEYS = {
  imageGeneration: ["imageModels"],
  videoGeneration: ["videoModels"],
  speechGeneration: ["speechModels", "audioModels"],
  speechRecognition: ["speechModels", "audioModels"],
  musicGeneration: ["musicModels"],
};

type AnyRecord = Record<string, any>;

function isPlainObject(value: any): value is AnyRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function cloneData(value) {
  return structuredClone(value);
}

function normalizeDeletedProviders(value) {
  return Array.isArray(value)
    ? [...new Set(value.filter((id) => typeof id === "string" && id.trim()).map((id) => id.trim()))]
    : [];
}

function normalizeModelDefaults(value) {
  if (!isPlainObject(value)) return {};
  const out: AnyRecord = {};
  for (const [rawModelId, rawEntry] of Object.entries(value)) {
    const modelId = typeof rawModelId === "string" ? rawModelId.trim() : "";
    if (!modelId || !isPlainObject(rawEntry)) continue;
    const rawLevel = rawEntry.thinking_level ?? rawEntry.thinkingLevel;
    if (typeof rawLevel !== "string" || !THINKING_LEVEL_VALUES.has(rawLevel)) continue;
    out[modelId] = { thinking_level: rawLevel };
  }
  return out;
}

function normalizeProviderUserConfig(value) {
  if (!isPlainObject(value)) {
    return { _config_error: MALFORMED_PROVIDER_CONFIG };
  }

  const next = { ...value };
  if (Object.prototype.hasOwnProperty.call(next, "models") && !Array.isArray(next.models)) {
    delete next.models;
    next._config_error = next._config_error || INVALID_MODELS_CONFIG;
  } else if (Array.isArray(next.models)) {
    const models = [];
    for (const model of next.models) {
      if (typeof model === "string" && model.trim()) {
        models.push(model.trim());
        continue;
      }
      if (isPlainObject(model) && typeof model.id === "string" && model.id.trim()) {
        models.push({ ...model, id: model.id.trim() });
        continue;
      }
      next._config_error = next._config_error || INVALID_MODELS_CONFIG;
    }
    next.models = models;
  }
  if (Object.prototype.hasOwnProperty.call(next, "model_defaults")) {
    const modelDefaults = normalizeModelDefaults(next.model_defaults);
    if (Object.keys(modelDefaults).length > 0) {
      next.model_defaults = modelDefaults;
    } else {
      delete next.model_defaults;
    }
  }
  return next;
}

function normalizeProviderUserConfigMap(providers) {
  if (!isPlainObject(providers)) return {};
  const normalized = {};
  for (const [providerId, config] of Object.entries(providers)) {
    if (!providerId) continue;
    normalized[providerId] = normalizeProviderUserConfig(config);
  }
  return normalized;
}

function stripProviderRuntimeMeta(config) {
  const normalized = normalizeProviderUserConfig(config);
  const clean = {};
  for (const [key, value] of Object.entries(normalized)) {
    if (PROVIDER_RUNTIME_META_KEYS.has(key)) continue;
    clean[key] = value;
  }
  return clean;
}

function stripProviderRuntimeMetaMap(providers) {
  if (!isPlainObject(providers)) return {};
  const clean = {};
  for (const [providerId, config] of Object.entries(providers)) {
    clean[providerId] = stripProviderRuntimeMeta(config);
  }
  return clean;
}

// ── 内置插件 ────────────────────────────────────────────────────────────────

function mediaUserConfigKey(capability) {
  const key = capabilityKey(capability);
  return MEDIA_USER_CONFIG_KEYS[key] || capability;
}

function defaultChatCapability(providerId) {
  return {
    runtimeProviderId: providerId,
    displayProviderId: providerId,
    projection: "models-json",
    allowListSource: "provider.models",
  };
}

function normalizeProviderSource(plugin, isBuiltin) {
  if (plugin?.source?.kind) return plugin.source;
  if (plugin?._pluginId) return { kind: "plugin", pluginId: plugin._pluginId };
  return { kind: isBuiltin ? "builtin" : "user" };
}

function getModelId(modelEntry) {
  return typeof modelEntry === "object" && modelEntry !== null ? modelEntry.id : modelEntry;
}

function getModelType(providerId, modelEntry) {
  const isObj = typeof modelEntry === "object" && modelEntry !== null;
  const id = getModelId(modelEntry);
  const known = lookupKnown(providerId, id);
  return resolveModelTypeFromModelId(id, providerId, isObj ? modelEntry.type : null, known?.type);
}

function omitUndefined(value) {
  const result: AnyRecord = {};
  for (const [key, item] of Object.entries(value || {})) {
    if (item !== undefined) result[key] = item;
  }
  return result;
}

function mediaCapabilitiesForModelType(type) {
  if (type === "image") return ["image_generation"];
  if (type === "video") return ["video_generation"];
  if (type === "audio" || type === "speech") return ["speech_generation", "speech_recognition"];
  if (type === "music") return ["music_generation"];
  return [];
}

function mediaCapabilityForModelType(type) {
  return mediaCapabilitiesForModelType(type)[0] || null;
}

function modelTypeForMediaCapability(capability) {
  const key = capabilityKey(capability);
  if (key === "imageGeneration") return "image";
  if (key === "videoGeneration") return "video";
  if (key === "musicGeneration") return "music";
  if (key === "speechGeneration" || key === "speechRecognition") return "audio";
  return null;
}

function hasExplicitModelType(model, expectedType) {
  if (!isPlainObject(model)) return false;
  const explicitType = normalizeModelType(model.type);
  return explicitType === expectedType || (expectedType === "audio" && explicitType === "speech");
}

function chatDefaultModels(providerId, models = []) {
  return (models || []).filter((model) => getModelType(providerId, model) === "chat");
}

function normalizeMediaModel(model, fallback: AnyRecord = {}) {
  if (!model) return null;
  const isObj = typeof model === "object";
  const rawModel: AnyRecord = isObj ? model : {};
  const id = isObj ? rawModel.id : model;
  if (typeof id !== "string" || !id.trim()) return null;
  const protocolId = (isObj && (rawModel.protocolId || rawModel.protocol_id)) || fallback.protocolId || fallback.protocol_id;
  return {
    ...(isObj ? rawModel : {}),
    id: id.trim(),
    displayName: (isObj && (rawModel.displayName || rawModel.display_name || rawModel.name)) || fallback.displayName || fallback.name || id.trim(),
    ...(protocolId ? { protocolId } : {}),
  };
}

function normalizeCredentialLane(lane, fallbackProviderId) {
  if (!isPlainObject(lane)) return null;
  const providerId = lane.providerId || lane.provider_id || fallbackProviderId;
  if (typeof providerId !== "string" || !providerId.trim()) return null;
  const id = lane.id || providerId;
  return {
    ...lane,
    id,
    providerId: providerId.trim(),
    label: lane.label || providerId,
  };
}

function normalizeImageGenerationCapability(capability, entry) {
  if (!capability || typeof capability !== "object") return null;
  const models = [];
  const seen = new Set();
  for (const model of capability.models || []) {
    const normalized = normalizeMediaModel(model, { protocolId: entry?.runtime?.protocolId });
    if (!normalized) continue;
    if (seen.has(normalized.id)) {
      throw new Error(`Duplicate media model "${normalized.id}" in provider "${entry.id}"`);
    }
    if (!normalized.protocolId) {
      throw new Error(`Media model "${normalized.id}" in provider "${entry.id}" missing protocolId`);
    }
    seen.add(normalized.id);
    models.push(normalized);
  }
  const credentialLanes = [];
  const laneSeen = new Set();
  for (const rawLane of capability.credentialLanes || []) {
    const lane = normalizeCredentialLane(rawLane, entry.id);
    if (!lane) continue;
    if (laneSeen.has(lane.id)) {
      throw new Error(`Duplicate credential lane "${lane.id}" in provider "${entry.id}"`);
    }
    laneSeen.add(lane.id);
    credentialLanes.push(lane);
  }
  return {
    ...capability,
    ...(credentialLanes.length > 0 ? { credentialLanes } : {}),
    models,
  };
}

function normalizeCapabilities(plugin, entry) {
  const raw = plugin?.capabilities || {};
  const capabilities = {
    ...raw,
    chat: raw.chat ? { ...defaultChatCapability(entry.id), ...raw.chat } : defaultChatCapability(entry.id),
  };
  const rawMedia = raw.media || {};
  const media = {};
  for (const [rawKey, rawCapability] of Object.entries(rawMedia)) {
    const key = capabilityKey(rawKey);
    const normalized = normalizeImageGenerationCapability(rawCapability, entry);
    if (normalized) media[key] = normalized;
    else if (rawCapability !== undefined) media[key] = rawCapability;
  }
  if (Object.keys(media).length > 0) {
    capabilities.media = media;
  }
  return capabilities;
}

function providerProtocolContext(entry) {
  return { api: entry?.api, sourceKind: entry?.source?.kind };
}

function normalizeUserMediaModels(providerId, userConfig, capabilityName, declaredModels, entry) {
  const snake = capabilityName;
  const camel = capabilityKey(capabilityName);
  const mediaConfig = userConfig?.media?.[snake] || userConfig?.media?.[camel] || {};
  const rawModels = [];
  if (Array.isArray(mediaConfig.models)) rawModels.push(...mediaConfig.models);
  for (const field of MEDIA_MODEL_FIELD_KEYS[camel] || []) {
    if (Array.isArray(userConfig?.[field])) rawModels.push(...userConfig[field]);
  }
  const declaredById = new Map(declaredModels.map((model) => [model.id, model]));
  const result = [];
  const seen = new Set();
  for (const raw of rawModels) {
    const id = getModelId(raw);
    const fallback = declaredById.get(id)
      || { protocolId: inferMediaProtocolId(providerId, capabilityName, id, providerProtocolContext(entry)) || entry?.runtime?.protocolId };
    const model = normalizeMediaModel(raw, fallback);
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    result.push(model);
  }
  return result;
}

function getUserMediaConfig(userConfig, capabilityName) {
  const snake = capabilityName;
  const camel = capabilityKey(capabilityName);
  const media = isPlainObject(userConfig.media) ? userConfig.media : null;
  return media?.[snake] || media?.[camel] || null;
}

function hasUserMediaModelList(userConfig, capabilityName) {
  const mediaConfig = getUserMediaConfig(userConfig, capabilityName);
  if (Array.isArray(mediaConfig?.models)) return true;
  const camel = capabilityKey(capabilityName);
  return (MEDIA_MODEL_FIELD_KEYS[camel] || []).some((field) => Array.isArray(userConfig?.[field]));
}

function userMediaModelExists(userConfig, modelId, capabilityName) {
  const mediaConfig = getUserMediaConfig(userConfig, capabilityName);
  if (!Array.isArray(mediaConfig?.models)) return false;
  return mediaConfig.models.some((model) => getModelId(model) === modelId);
}

function userChatModelExists(userConfig, modelId) {
  if (!Array.isArray(userConfig.models)) return false;
  return userConfig.models.some((model) => getModelId(model) === modelId);
}

function removeUserMediaModel(userConfig, modelId) {
  if (!isPlainObject(userConfig?.media)) return false;
  let changed = false;
  for (const mediaConfig of Object.values(userConfig.media)) {
    if (!isPlainObject(mediaConfig) || !Array.isArray(mediaConfig.models)) continue;
    const nextModels = mediaConfig.models.filter((model) => getModelId(model) !== modelId);
    if (nextModels.length === mediaConfig.models.length) continue;
    mediaConfig.models = nextModels;
    changed = true;
  }
  return changed;
}

function shouldUpdateUserMediaModel(userConfig, modelId, capabilityName) {
  if (userMediaModelExists(userConfig, modelId, capabilityName)) return true;
  return !userChatModelExists(userConfig, modelId);
}

function mergeModelMetadata(base, patch) {
  const merged = { ...base, ...patch };
  if (patch.compat) {
    merged.compat = {
      ...(isPlainObject(base.compat) ? base.compat : {}),
      ...patch.compat,
    };
  }
  if (!merged.name) delete merged.name;
  return merged;
}

function updateUserMediaModel(userConfig, capabilityName, modelId, safe) {
  const media = isPlainObject(userConfig.media) ? userConfig.media : {};
  userConfig.media = media;
  const mediaKey = mediaUserConfigKey(capabilityName);
  const mediaConfig = isPlainObject(media[mediaKey]) ? media[mediaKey] : {};
  media[mediaKey] = mediaConfig;
  const models = Array.isArray(mediaConfig.models) ? mediaConfig.models : [];
  const mediaSafe = { ...safe };
  delete mediaSafe.type;
  delete mediaSafe.image;
  delete mediaSafe.video;
  delete mediaSafe.reasoning;
  if (!mediaSafe.name) delete mediaSafe.name;

  let found = false;
  mediaConfig.models = models.map((model) => {
    const id = getModelId(model);
    if (id !== modelId) return model;
    found = true;
    const base = typeof model === "object" && model !== null ? model : { id };
    return mergeModelMetadata(base, { ...mediaSafe, id: modelId });
  });
  if (!found) {
    mediaConfig.models.push({ id: modelId, ...mediaSafe });
  }
}

import { dashscopePlugin } from "../lib/providers/dashscope.ts";
import { openaiPlugin } from "../lib/providers/openai.ts";
import { anthropicPlugin } from "../lib/providers/anthropic.ts";
import { deepseekPlugin } from "../lib/providers/deepseek.ts";
import { geminiPlugin } from "../lib/providers/gemini.ts";
import { openrouterPlugin } from "../lib/providers/openrouter.ts";
import { ollamaPlugin } from "../lib/providers/ollama.ts";
import { sglangPlugin } from "../lib/providers/sglang.ts";
import { minimaxPlugin } from "../lib/providers/minimax.ts";
import { minimaxTokenPlanPlugin } from "../lib/providers/minimax-token-plan.ts";
import { openaiCodexOAuthPlugin } from "../lib/providers/openai-codex-oauth.ts";
import { agnesPlugin } from "../lib/providers/agnes.ts";
import { opencodeGoPlugin } from "../lib/providers/opencode-go.ts";
// 中国
import { siliconflowPlugin } from "../lib/providers/siliconflow.ts";
import { zhipuPlugin } from "../lib/providers/zhipu.ts";
import { moonshotPlugin } from "../lib/providers/moonshot.ts";
import { baichuanPlugin } from "../lib/providers/baichuan.ts";
import { stepfunPlugin } from "../lib/providers/stepfun.ts";
import { volcenginePlugin } from "../lib/providers/volcengine.ts";
import { volcengineSpeechPlugin } from "../lib/providers/volcengine-speech.ts";
import { hunyuanPlugin } from "../lib/providers/hunyuan.ts";
import { baiduCloudPlugin } from "../lib/providers/baidu-cloud.ts";
import { modelscopePlugin } from "../lib/providers/modelscope.ts";
import { infiniPlugin } from "../lib/providers/infini.ts";
import { mimoPlugin } from "../lib/providers/mimo.ts";
import { mimoTokenPlanPlugin } from "../lib/providers/mimo-token-plan.ts";
import { systemSpeechPlugin } from "../lib/providers/system-speech.ts";
// 国际
import { groqPlugin } from "../lib/providers/groq.ts";
import { togetherPlugin } from "../lib/providers/together.ts";
import { fireworksPlugin } from "../lib/providers/fireworks.ts";
import { mistralPlugin } from "../lib/providers/mistral.ts";
import { perplexityPlugin } from "../lib/providers/perplexity.ts";
import { xaiPlugin } from "../lib/providers/xai.ts";
// Coding Plan
import { dashscopeCodingPlugin } from "../lib/providers/dashscope-coding.ts";
import { kimiCodingPlugin } from "../lib/providers/kimi-coding.ts";
import { volcegineCodingPlugin } from "../lib/providers/volcengine-coding.ts";
import { zhipuCodingPlugin } from "../lib/providers/zhipu-coding.ts";

const BUILTIN_PLUGINS = [
  dashscopePlugin,
  openaiPlugin,
  anthropicPlugin,
  deepseekPlugin,
  geminiPlugin,
  openrouterPlugin,
  opencodeGoPlugin,
  ollamaPlugin,
  sglangPlugin,
  minimaxPlugin,
  minimaxTokenPlanPlugin,
  openaiCodexOAuthPlugin,
  agnesPlugin,
  // 中国
  siliconflowPlugin,
  zhipuPlugin,
  moonshotPlugin,
  baichuanPlugin,
  stepfunPlugin,
  volcenginePlugin,
  volcengineSpeechPlugin,
  hunyuanPlugin,
  baiduCloudPlugin,
  modelscopePlugin,
  infiniPlugin,
  mimoPlugin,
  mimoTokenPlanPlugin,
  systemSpeechPlugin,
  // 国际
  groqPlugin,
  togetherPlugin,
  fireworksPlugin,
  mistralPlugin,
  perplexityPlugin,
  xaiPlugin,
  // Coding Plan
  dashscopeCodingPlugin,
  kimiCodingPlugin,
  volcegineCodingPlugin,
  zhipuCodingPlugin,
];

// ── Types (JSDoc) ─────────────────────────────────────────────────────────────

/**
 * @typedef {object} ProviderPlugin
 * @property {string} id
 * @property {string} displayName
 * @property {"api-key"|"oauth"|"none"|"optional"} authType
 * @property {string} defaultBaseUrl
 * @property {string} defaultApi
 * @property {string} [authJsonKey] - OAuth provider -auth.json 中的 key（不同于 id 时）
 */

/**
 * @typedef {object} ProviderEntry
 * @property {string} id
 * @property {string} displayName
 * @property {"api-key"|"oauth"|"none"|"optional"} authType
 * @property {string} baseUrl - 生效-base URL（用户覆-> 插件默认- * @property {string} api - 生效-API 协议
 * @property {string} [authJsonKey]
 * @property {boolean} isBuiltin - 是否为内置插- */

// ── ProviderRegistry ─────────────────────────────────────────────────────────

export class ProviderRegistry {
  declare _gsapHome: string;
  declare _catalog: ProviderCatalogStore;
  declare _localProviderPlugins: LocalProviderPluginStore;
  declare _builtinPlugins: Map<string, any>;
  declare _plugins: Map<string, any>;
  declare _entries: Map<string, any>;
  declare _addedModelsCache: any;
  declare _addedModelsMtime: number;
  declare _authJsonCache: any;
  declare _authJsonMtime: number;

  /**
 * @param {string} gsapHome - 用户数据根目录（-~/.gsap-dev- */
  constructor(gsapHome) {
    this._gsapHome = gsapHome;
    this._catalog = new ProviderCatalogStore(gsapHome);
    this._localProviderPlugins = new LocalProviderPluginStore(gsapHome);
 /** @type {Map<string, ProviderPlugin>} id -plugin */
    this._plugins = new Map();
    this._builtinPlugins = new Map();
 /** @type {Map<string, ProviderEntry>} id -entry（合并后-*/
    this._entries = new Map();

 // mtime 缓存：避免热路径上重复读盘解-YAML/JSON
    /** @private */ this._addedModelsCache = null;
    /** @private */ this._addedModelsMtime = 0;
    /** @private */ this._authJsonCache = null;
    /** @private */ this._authJsonMtime = 0;

    // 注册内置插件
    for (const plugin of BUILTIN_PLUGINS) {
      this._plugins.set(plugin.id, plugin);
      this._builtinPlugins.set(plugin.id, plugin);
    }
    this._reloadLocalProviderPlugins();
  }

  _isBuiltinPlugin(id, plugin) {
    return this._builtinPlugins.get(id) === plugin;
  }

  _reloadLocalProviderPlugins() {
    for (const [id, plugin] of [...this._plugins.entries()]) {
      if (isLocalProviderPlugin(plugin)) this._plugins.delete(id);
    }
    for (const plugin of this._localProviderPlugins.readAll()) {
      validateProviderRuntime(plugin.runtime);
      this._plugins.set(plugin.id, plugin);
    }
  }

  _mergeRawProviderConfig(providerId, overlay = {}) {
    const plugin = this._plugins.get(providerId);
    if (!isLocalProviderPlugin(plugin)) return cloneData(overlay || {});
    const definition: AnyRecord = providerPluginToCatalogDefinition(plugin);
    const rawOverlay: AnyRecord = overlay || {};
    const merged: AnyRecord = {
      ...definition,
      ...rawOverlay,
    };
    if (Object.prototype.hasOwnProperty.call(definition, "models") || Object.prototype.hasOwnProperty.call(rawOverlay, "models")) {
      merged.models = mergeProviderModelEntries(definition.models, rawOverlay.models);
    }
    return {
      ...merged,
    };
  }

  _writeLocalProviderPlugin(providerId, config, existingPlugin = null) {
    const { plugin, overlay } = splitLocalProviderConfig(providerId, config, existingPlugin);
    validateProviderRuntime(plugin.runtime);
    validateProviderModels(providerId, plugin.models, { baseUrl: plugin.defaultBaseUrl });
    const saved = this._localProviderPlugins.writeProvider(providerId, plugin);
    this._plugins.set(providerId, saved);
    return overlay;
  }

  _migrateCatalogOnlyProvidersToLocalPlugins(userConfig) {
    let changed = false;
    const nextConfig = cloneData(userConfig || {});
    for (const [providerId, config] of Object.entries(userConfig || {}) as Array<[string, any]>) {
      if (this._plugins.has(providerId)) continue;
      if (!isSafeLocalProviderPluginProviderId(providerId)) continue;
      if (!providerConfigHasLocalDefinition(config)) continue;
      nextConfig[providerId] = this._writeLocalProviderPlugin(providerId, config, null);
      changed = true;
    }
    if (!changed) return userConfig;
    this._saveAddedModels(nextConfig, {
      localProviderPluginsMigratedAt: new Date().toISOString(),
    });
    return this._loadAddedModels();
  }

  /**
   * 注册 provider 插件
 * 同一 id 注册两次会覆盖（方便测试/扩展- * @param {ProviderPlugin} plugin
   */
  register(plugin) {
    if (!plugin?.id) throw new Error("ProviderPlugin must have an id");
    validateProviderRuntime(plugin.runtime);
    this._plugins.set(plugin.id, plugin);
 // -reload() 在下次调用时重新合并
    this._entries.delete(plugin.id);
  }

  registerProviderContribution(plugin) {
    this.register(plugin);
  }

  /**
 * 一次性迁移：-agent config.models.overrides 的模型能力字段迁移到 added-models.yaml
   * @param {string} agentsDir - agents 目录
   * @param {Function} [log] - 日志函数
   */
  migrateOverridesToAddedModels(agentsDir, log: (...args: any[]) => void = () => {}) {
    const CAPABILITY_KEYS = ["context", "maxOutput", "image", "video", "reasoning"];
    const userConfig = this._loadAddedModels();
    let changed = false;

 // 扫描所-agent -config.yaml
    let agentDirs;
    try { agentDirs = fs.readdirSync(agentsDir, { withFileTypes: true }).filter(d => d.isDirectory()); }
    catch { return; }

    for (const dir of agentDirs) {
      const cfgPath = path.join(agentsDir, dir.name, "config.yaml");
      const cfg = safeReadYAMLSync(cfgPath, null, YAML);
      if (!cfg?.models?.overrides) continue;

      const overrides = cfg.models.overrides;
      let cfgChanged = false;

      for (const [modelId, ov] of Object.entries(overrides) as Array<[string, AnyRecord]>) {
        if (!ov || typeof ov !== "object") continue;
        const meta: AnyRecord = {};
        if (ov.vision !== undefined && ov.image === undefined) {
          ov.image = ov.vision;
        }
        if (ov.vision !== undefined) {
          delete ov.vision;
          cfgChanged = true;
        }
        for (const key of CAPABILITY_KEYS) {
          if (ov[key] !== undefined) {
            meta[key] = ov[key];
            delete ov[key];
            cfgChanged = true;
          }
        }
        if (Object.keys(meta).length === 0) continue;

 // 找到对应 provider 并更新条-
        for (const [, prov] of Object.entries(userConfig) as Array<[string, AnyRecord]>) {
          if (!prov.models || !Array.isArray(prov.models)) continue;
          const idx = prov.models.findIndex(m => (typeof m === "object" ? m.id : m) === modelId);
          if (idx === -1) continue;
          const existing = typeof prov.models[idx] === "object" ? prov.models[idx] : { id: modelId };
          prov.models[idx] = { ...existing, ...meta };
          changed = true;
          log(`[migrate] override ${modelId}: ${Object.keys(meta).join(",")} ??added-models.yaml`);
          break;
        }
      }

 // 清理空的 override 条目，保-config.yaml
      if (cfgChanged) {
        for (const [modelId, ov] of Object.entries(overrides) as Array<[string, AnyRecord]>) {
          if (ov && typeof ov === "object" && (Object.keys as any)(ov).length === 0) {
            delete overrides[modelId];
          }
        }
        if (Object.keys(overrides).length === 0) {
          delete cfg.models.overrides;
        }
        const header = "# G-SAP Agent 配置\n# 由设置页面管理，手动编辑也可以\n\n";
        const yamlStr = header + YAML.dump(cfg, { indent: 2, lineWidth: -1, sortKeys: false, quotingType: '"', forceQuotes: false });
        fs.writeFileSync(cfgPath, yamlStr, "utf-8");
      }
    }

    if (changed) {
      this._saveAddedModels(userConfig);
      log("[migrate] model overrides migrated to added-models.yaml");
    }
  }

 /** -_gsapHome 直接-added-models.yaml（mtime 缓存，文件未变时跳过磁盘读取-*/
  _loadAddedModels() {
    try {
      const catalog = this._catalog.load();
      const mtime = fs.statSync(this._catalog.catalogPath).mtimeMs;
      if (this._addedModelsCache && mtime === this._addedModelsMtime) {
        return cloneData(this._addedModelsCache);
      }
      this._addedModelsCache = normalizeProviderUserConfigMap(catalog.providers);
      this._addedModelsMtime = mtime;
      return cloneData(this._addedModelsCache);
    } catch {
      return {};
    }
  }

 /** -providers 对象写入 _gsapHome/added-models.yaml */
  _saveAddedModels(providers, meta: AnyRecord = {}) {
    this._catalog.saveProviders(stripProviderRuntimeMetaMap(providers), meta);
    this._addedModelsCache = null;
    this._addedModelsMtime = 0;
  }

  /**
 * -added-models.yaml 加载用户配置，与所有插件声明合- * 每次 added-models.yaml 变更后调- */
  reload() {
    this._entries.clear();
    this._reloadLocalProviderPlugins();
    const userConfig = this._migrateCatalogOnlyProvidersToLocalPlugins(this._loadAddedModels());
    const deletedProviders = new Set(this._catalog.getDeletedProviders());

 // 1. 先处理所有已注册插件（内-+ 外部注册的）
    for (const [id, plugin] of this._plugins) {
      if (deletedProviders.has(id) && !Object.prototype.hasOwnProperty.call(userConfig, id)) continue;
      const uc = userConfig[id] || {};
      this._entries.set(id, this._merge(plugin, uc, this._isBuiltinPlugin(id, plugin)));
    }

 // 2. 处理 added-models.yaml 中有但没有对应插件的条目（用户自定义 provider-
    for (const [id, uc] of Object.entries(userConfig) as Array<[string, AnyRecord]>) {
      if (this._entries.has(id)) continue;
      // 没有插件声明，从配置推断
      const syntheticPlugin = {
        id,
        displayName: uc.display_name || id,
        authType: normalizeProviderAuthType(uc.auth_type),
        defaultBaseUrl: uc.base_url || "",
        defaultApi: uc.api || "openai-completions",
        runtime: uc.runtime,
        capabilities: uc.capabilities,
        source: { kind: "user" },
      };
      this._entries.set(id, this._merge(syntheticPlugin, uc, false));
    }
  }

  /**
 * 合并插件声明和用户配- * @private
   */
  _merge(plugin, userConfig, isBuiltin) {
    const runtime = plugin.runtime ? validateProviderRuntime(plugin.runtime) : null;
    const entry: AnyRecord = {
      id: plugin.id,
      displayName: userConfig.display_name || plugin.displayName,
      authType: normalizeProviderAuthType(userConfig.auth_type || plugin.authType),
      baseUrl: userConfig.base_url || plugin.defaultBaseUrl,
      api: userConfig.api || plugin.defaultApi,
      headers: normalizeProviderHeaders(userConfig.headers || plugin.headers),
      authJsonKey: plugin.authJsonKey || plugin.id,
      isBuiltin,
      source: normalizeProviderSource(plugin, isBuiltin),
      ...(runtime ? { runtime } : {}),
    };
    entry.capabilities = normalizeCapabilities(plugin, entry);
    return entry;
  }

  /**
 * 获取所-provider entry（已合并- * @returns {Map<string, ProviderEntry>}
   */
  getAll() {
    if (this._entries.size === 0) this.reload();
    return this._entries;
  }

  /**
   * 获取单个 provider entry
   * @param {string} providerId
   * @returns {ProviderEntry|null}
   */
  get(providerId) {
    if (this._entries.size === 0) this.reload();
    const direct = this._entries.get(providerId);
    if (direct?.isBuiltin) return direct;
 // 反向查找：providerId 可能是某-OAuth provider -authJsonKey
 // -"openai-codex" -"openai-codex-oauth"
    for (const entry of this._entries.values()) {
      if (entry.authJsonKey === providerId && entry.id !== providerId) return entry;
    }
    if (direct) return direct;
    return null;
  }

  getProviderCapabilities(providerId) {
    return this.get(providerId)?.capabilities || null;
  }

  getCapabilityRegistry() {
    return cloneData(this._catalog.load().capabilities || {});
  }

  getCapabilityProviders(capability) {
    if (typeof capability !== "string" || !capability.trim()) return [];
    const config = this.getCapabilityRegistry()[capability.trim()];
    return Array.isArray(config?.providers) ? cloneData(config.providers) : [];
  }

  resolveChatProvider(providerId) {
    const entry = this.get(providerId);
    if (!entry) return null;
    const chat = entry.capabilities?.chat || defaultChatCapability(entry.id);
    return {
      originalProviderId: providerId,
      providerId: chat.runtimeProviderId || entry.id,
      displayProviderId: chat.displayProviderId || chat.runtimeProviderId || entry.id,
      projection: chat.projection || "models-json",
      allowListSource: chat.allowListSource || "provider.models",
      entry,
    };
  }

  getChatProjection(providerId) {
    return this.resolveChatProvider(providerId)?.projection || "models-json";
  }

  getChatModelIds(providerId) {
    const userConfig = this._loadAddedModels();
    const providerConfig = this._mergeRawProviderConfig(providerId, userConfig[providerId] || {});
    const models = providerConfig.models || [];
    return models
      .filter((model) => getModelType(providerId, model) === "chat")
      .map(getModelId)
      .filter(Boolean);
  }

  getMediaModels(providerId, capability) {
    if (this._entries.size === 0) this.reload();
    const entry = this._entries.get(providerId) || this.get(providerId);
    if (!entry) return [];
    const key = capabilityKey(capability);
    const declared = entry.capabilities?.media?.[key]?.models || [];
    const userConfig = this._loadAddedModels()[providerId] || {};
    const userModels = normalizeUserMediaModels(providerId, userConfig, capability, declared, entry);
    if (hasUserMediaModelList(userConfig, capability)) return userModels;
    const byId = new Map();
    for (const model of declared) byId.set(model.id, model);
    for (const model of userModels) byId.set(model.id, { ...(byId.get(model.id) || {}), ...model });
    return [...byId.values()];
  }

  getRegisteredMediaModels(providerId, capability) {
    if (this._entries.size === 0) this.reload();
    const entry = this._entries.get(providerId) || this.get(providerId);
    if (!entry) return [];
    const key = capabilityKey(capability);
    const declared = entry.capabilities?.media?.[key]?.models || [];
    const userConfig = this._loadAddedModels()[providerId] || {};
    return normalizeUserMediaModels(providerId, userConfig, capability, declared, entry);
  }

  getMediaCredentialLanes(providerId, capability = "image_generation") {
    if (this._entries.size === 0) this.reload();
    const entry = this._entries.get(providerId) || this.get(providerId);
    if (!entry) return [];
    const key = capabilityKey(capability);
    const mediaCapability = entry.capabilities?.media?.[key] || {};
    const lanes = Array.isArray(mediaCapability.credentialLanes)
      ? mediaCapability.credentialLanes
        .map((lane) => normalizeCredentialLane(lane, providerId))
        .filter(Boolean)
      : [];
    return lanes.length > 0
      ? lanes
      : [{
        id: providerId,
        providerId,
        label: entry.displayName || providerId,
        authType: entry.authType,
      }];
  }

  getMediaProviderCredentialStatus(providerId, capability = "image_generation") {
    if (this._entries.size === 0) this.reload();
    const entry = this._entries.get(providerId) || this.get(providerId);
    if (!entry) {
      return { hasCredentials: false, unavailableReason: "provider_not_found", lanes: [] };
    }
    const lanes = this.getMediaCredentialLanes(providerId, capability);
    for (const lane of lanes) {
      const laneProviderId = lane.providerId || providerId;
      const authType = normalizeProviderAuthType(lane.authType || this.getAuthType(laneProviderId) || entry.authType);
      if (authType === "none") {
        return {
          hasCredentials: true,
          unavailableReason: null,
          activeLaneId: lane.id,
          activeProviderId: laneProviderId,
          lanes,
        };
      }
      const creds = this.getCredentials(laneProviderId);
      if (creds?.apiKey || this.allowsMissingApiKey(laneProviderId, creds?.baseUrl || "")) {
        return {
          hasCredentials: true,
          unavailableReason: null,
          activeLaneId: lane.id,
          activeProviderId: laneProviderId,
          lanes,
        };
      }
    }
    return { hasCredentials: false, unavailableReason: "no_credentials", lanes };
  }

  getMediaProviders(capability) {
    if (this._entries.size === 0) this.reload();
    const providers = [];
    for (const entry of this._entries.values()) {
      const models = this.getMediaModels(entry.id, capability);
      if (models.length === 0) continue;
      providers.push({
        providerId: entry.id,
        displayName: entry.displayName,
        authType: entry.authType,
        source: entry.source,
        runtime: entry.runtime || null,
        credentialLanes: this.getMediaCredentialLanes(entry.id, capability),
        models,
      });
    }
    return providers;
  }

  resolveMediaModel(ref) {
    const providerId = ref?.providerId || ref?.provider;
    const modelId = ref?.modelId || ref?.id || ref?.model;
    const capability = ref?.capability || "image_generation";
    if (!providerId) throw new Error("Media provider required");
    if (!modelId) throw new Error("Media model required");
    const entry = this._entries.get(providerId) || this.get(providerId);
    if (!entry) throw new Error(`Media provider "${providerId}" not found`);
    const models = this.getMediaModels(providerId, capability);
    const model = models.find((item) => item.id === modelId || item.aliases?.includes?.(modelId));
    if (!model) throw new Error(`Media model "${providerId}/${modelId}" not found`);
    const key = capabilityKey(capability);
    const mediaCapability = entry.capabilities?.media?.[key] || {};
    const credentialLaneId = ref?.credentialLaneId || model.credentialLaneId;
    const credentialLane = credentialLaneId
      ? (mediaCapability.credentialLanes || []).find((lane) => lane.id === credentialLaneId)
      : null;
    if (credentialLaneId && !credentialLane) {
      throw new Error(`Credential lane "${credentialLaneId}" not found for provider "${providerId}"`);
    }
    return {
      capability,
      providerId,
      provider: entry,
      model,
      credentialLane: credentialLane || null,
      runtime: entry.runtime || null,
    };
  }

  /**
   * 批量获取 provider entry
   * @param {string[]} providerIds
   * @returns {Map<string, ProviderEntry>}
   */
  getBatch(providerIds) {
    const result = new Map();
    for (const id of providerIds) {
      const entry = this.get(id);
      if (entry) result.set(id, entry);
    }
    return result;
  }

  /**
 * 列出所-authType -"oauth" -provider id
   * @returns {string[]}
   */
  getOAuthProviderIds() {
    const all = this.getAll();
    return [...all.values()]
      .filter(e => e.authType === "oauth")
      .map(e => e.id);
  }

  /**
 * 获取 OAuth provider -auth.json 中的实际 key
 * （部-provider -authJsonKey -id 不同，如 openai-codex-oauth -openai-codex- * @param {string} providerId
   * @returns {string}
   */
  getAuthJsonKey(providerId) {
    return this.get(providerId)?.authJsonKey || providerId;
  }

  /**
 * 获取-provider 的默认模型列表（来自 lib/default-models.json- * @param {string} providerId
   * @returns {string[]}
   */
  getDefaultModels(providerId) {
    return _defaultModels[providerId] || [];
  }

  /**
 * 更新 provider 的用户配置（-added-models.yaml- * 只更新非凭证字段（base_url / api / display_name / auth_type- * @param {string} providerId
    *
   */
  setUserConfig(providerId, overrides) {
    const userConfig = this._loadAddedModels();
    userConfig[providerId] = { ...(userConfig[providerId] || {}), ...overrides };
    this._saveAddedModels(userConfig);
    // 更新内存中的 entry
    this._entries.delete(providerId);
    if (this._plugins.has(providerId)) {
      const plugin = this._plugins.get(providerId);
      this._entries.set(providerId, this._merge(plugin, userConfig[providerId], true));
    } else {
      this.reload(); // 自定义 provider 走完后 reload
    }
  }

  /**
 * 删除一-provider（仅-added-models.yaml，内置插件的插件声明保留- * @param {string} providerId
   */
  remove(providerId) {
    const userConfig = this._loadAddedModels();
    if (!Object.prototype.hasOwnProperty.call(userConfig, providerId)) return;
    delete userConfig[providerId];
    const existing = safeReadYAMLSync(path.join(this._gsapHome, "added-models.yaml"), {}, YAML) || {};
    const deletedProviders = normalizeDeletedProviders(existing[DELETED_PROVIDERS_KEY]);
    if (!deletedProviders.includes(providerId)) deletedProviders.push(providerId);
    this._saveAddedModels(userConfig, { deletedProviders });
    this._entries.delete(providerId);
 // 如果有内置插件声明，以默认值重-entry
    if (this._plugins.has(providerId) && !deletedProviders.includes(providerId)) {
      const plugin = this._plugins.get(providerId);
      this._entries.set(providerId, this._merge(plugin, {}, true));
    }
  }

  /**
 * 检查某-id 是否是已知的 OAuth provider
   * @param {string} providerId
   */
  isOAuth(providerId) {
    return this.get(providerId)?.authType === "oauth";
  }

  /**
 * 获取 provider 的标准化认证类型- * @param {string} providerId
   * @returns {"api-key"|"oauth"|"none"|"optional"}
   */
  getAuthType(providerId) {
    return normalizeProviderAuthType(this.get(providerId)?.authType);
  }

  /**
 * 判断 provider 是否允许缺省 API key- * @param {string} providerId
   * @param {string} [baseUrl]
   */
  allowsMissingApiKey(providerId, baseUrl = "") {
    return providerCredentialAllowsMissingApiKey({
      authType: this.getAuthType(providerId),
      baseUrl,
    });
  }

  // ── credential read + model CRUD ──────────────────────────────────────────

  /**
 * 读取 provider 的凭证信息（apiKey, baseUrl, api- * -added-models.yaml 读取用户配置值，baseUrl/api 不存在时回退到插件默认值- * OAuth provider -YAML -api_key，自动从 auth.json 补全 access token- * -auth.json -resourceUrl -YAML 未配 base_url，用 resourceUrl 作为 baseUrl- * @param {string} providerId
    *
   */
  clearAuthCache() {
    this._authJsonCache = null;
    this._authJsonMtime = 0;
  }

  getCredentials(providerId) {
    const userConfig = this._loadAddedModels();
    const entry = this.get(providerId);
    const candidateIds = [];
    const addCandidate = (id) => {
      if (id && !candidateIds.includes(id)) candidateIds.push(id);
    };
    addCandidate(providerId);
    addCandidate(entry?.id);
    addCandidate(entry?.authJsonKey);

    const configId = candidateIds.find(id => Object.prototype.hasOwnProperty.call(userConfig, id));
    const uc = configId ? userConfig[configId] : null;
    const plugin = this._plugins.get(entry?.id || providerId);
    const authType = normalizeProviderAuthType(uc?.auth_type || entry?.authType || plugin?.authType);
    if (!uc && authType !== "oauth") return null;

    let apiKey = uc?.api_key || "";
    let oauthBaseUrl = "";
    let oauthAccountId = "";

 // OAuth provider: YAML 没有 api_key，从 auth.json -access token + resourceUrl
    if (!apiKey) {
      if (authType === "oauth") {
        const authJsonKey = entry?.authJsonKey || plugin?.authJsonKey || providerId;
        const oauth = this._readOAuthEntry(authJsonKey);
        apiKey = oauth.token;
        oauthBaseUrl = oauth.resourceUrl;
        oauthAccountId = oauth.accountId;
      }
    }

    apiKey = normalizeProviderApiKey(apiKey);

    const headers = normalizeProviderHeaders(uc?.headers || entry?.headers || plugin?.headers);
    return {
      apiKey,
      baseUrl: uc?.base_url || oauthBaseUrl || entry?.baseUrl || plugin?.defaultBaseUrl || "",
      api: uc?.api || entry?.api || plugin?.defaultApi || "",
      authType,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
      ...(oauthAccountId ? { accountId: oauthAccountId } : {}),
    };
  }

  /**
 * -auth.json 读取 OAuth 条目（token + resourceUrl- * @private
   * @param {string} authJsonKey - auth.json 中的 key
   * @returns {{ token: string, resourceUrl: string }}
   */
  _readOAuthEntry(authJsonKey) {
    try {
      const authPath = path.join(this._gsapHome, "auth.json");
 // mtime 缓存：auth.json 只在 OAuth 回调写入时变-
      const mtime = fs.statSync(authPath).mtimeMs;
      if (!this._authJsonCache || mtime !== this._authJsonMtime) {
        this._authJsonCache = JSON.parse(fs.readFileSync(authPath, "utf-8"));
        this._authJsonMtime = mtime;
      }
      const entry = this._authJsonCache?.[authJsonKey];
      if (!entry) return { token: "", resourceUrl: "", accountId: "" };
      if (typeof entry === "string") return { token: entry, resourceUrl: "", accountId: "" };
      let token = "";
      if (typeof entry.access === "string") token = entry.access;
      else if (typeof entry.apiKey === "string") token = entry.apiKey;
      else if (typeof entry.token === "string") token = entry.token;
      return { token, resourceUrl: entry.resourceUrl || "", accountId: entry.accountId || "" };
    } catch {
      return { token: "", resourceUrl: "", accountId: "" };
    }
  }

  /**
 * 读取-provider -added-models.yaml 中的模型 ID 列表
 * 模型条目可以是字符串-{id, name-, context-, maxOutput-} 对象，统一提取 id
   * @param {string} providerId
   * @returns {string[]}
   */
  getProviderModels(providerId) {
    const userConfig = this._loadAddedModels();
    const uc = userConfig[providerId];
    if (!uc?.models || !Array.isArray(uc.models)) return [];
    return uc.models.map((m) => (typeof m === "object" ? m.id : m));
  }

  getModelDefaultThinkingLevel(providerId, modelId) {
    if (!providerId || !modelId) return null;
    const userConfig = this._loadAddedModels();
    const candidateIds = [];
    const addCandidate = (id) => {
      if (id && !candidateIds.includes(id)) candidateIds.push(id);
    };
    addCandidate(providerId);
    const entry = this.get(providerId);
    addCandidate(entry?.id);
    addCandidate(entry?.authJsonKey);
    for (const id of candidateIds) {
      const level = userConfig[id]?.model_defaults?.[modelId]?.thinking_level;
      if (typeof level === "string") return level;
    }
    return null;
  }

  setModelDefaultThinkingLevel(providerId, modelId, level) {
    if (!providerId || !modelId) {
      throw new Error("setModelDefaultThinkingLevel: providerId and modelId required");
    }
    if (typeof level !== "string" || !THINKING_LEVEL_VALUES.has(level)) {
      throw new Error(`invalid thinking level: ${level}`);
    }
    const userConfig = this._loadAddedModels();
    const entry = this.get(providerId);
    const candidateIds = [providerId, entry?.id, entry?.authJsonKey].filter(Boolean);
    const ownerProviderId = candidateIds.find(id => Object.prototype.hasOwnProperty.call(userConfig, id))
      || providerId;
    if (!userConfig[ownerProviderId]) userConfig[ownerProviderId] = {};

    const defaults = isPlainObject(userConfig[ownerProviderId].model_defaults)
      ? { ...userConfig[ownerProviderId].model_defaults }
      : {};
    const existing = isPlainObject(defaults[modelId]) ? defaults[modelId] : {};
    defaults[modelId] = { ...existing, thinking_level: level };
    userConfig[ownerProviderId].model_defaults = normalizeModelDefaults(defaults);
    this._saveAddedModels(userConfig);
    this._entries.clear();
    return { provider: ownerProviderId, modelId, thinkingLevel: level };
  }

  /**
   * 返回 added-models.yaml 的原始数据（不经过插件合并）
   * @returns {Record<string, any>}
   */
  getAllProvidersRaw() {
    const userConfig = this._loadAddedModels();
    const raw = {};
    for (const [providerId, config] of Object.entries(userConfig) as Array<[string, any]>) {
      raw[providerId] = this._mergeRawProviderConfig(providerId, config);
    }
    return raw;
  }

  _mediaModelFallback(providerId, capability, modelId) {
    const entry = this._entries.get(providerId) || this.get(providerId);
    const models = this.getMediaModels(providerId, capability);
    return models.find((item) => item.id === modelId || item.aliases?.includes?.(modelId))
      || { protocolId: inferMediaProtocolId(providerId, capability, modelId, providerProtocolContext(entry)) || entry?.runtime?.protocolId };
  }

  _ensureMediaConfig(userConfig, providerId, capability) {
    if (!providerId) throw new Error("media provider id is required");
    if (!userConfig[providerId]) userConfig[providerId] = {};
    const provider = userConfig[providerId];
    const media = isPlainObject(provider.media) ? provider.media : {};
    provider.media = media;
    const mediaKey = mediaUserConfigKey(capability);
    const mediaConfig = isPlainObject(media[mediaKey]) ? media[mediaKey] : {};
    media[mediaKey] = mediaConfig;
    if (!Array.isArray(mediaConfig.models)) mediaConfig.models = [];
    return mediaConfig;
  }

  addMediaModel(providerId, capability, model) {
    const modelId = getModelId(model);
    if (!modelId) throw new Error("media model id is required");
    const userConfig = this._loadAddedModels();
    const mediaConfig = this._ensureMediaConfig(userConfig, providerId, capability);
    const exists = mediaConfig.models.some((item) => getModelId(item) === modelId);
    if (exists) return;

    const fallback = this._mediaModelFallback(providerId, capability, modelId);
    const normalized = normalizeMediaModel(model, fallback);
    if (!normalized?.protocolId) {
      throw new Error(`Media model "${providerId}/${modelId}" missing protocolId`);
    }
    mediaConfig.models = [...mediaConfig.models, normalized];
    this._saveAddedModels(userConfig);
    this._entries.clear();
  }

  updateMediaModelEntry(providerId, capability, modelId, patch) {
    if (!modelId) throw new Error("media model id is required");
    const userConfig = this._loadAddedModels();
    const mediaConfig = this._ensureMediaConfig(userConfig, providerId, capability);
    const fallback = this._mediaModelFallback(providerId, capability, modelId);
    const safePatch = omitUndefined(patch);
    let found = false;
    mediaConfig.models = mediaConfig.models.map((item) => {
      if (getModelId(item) !== modelId) return item;
      found = true;
      const base = typeof item === "object" && item !== null ? item : { id: modelId };
      const normalized = normalizeMediaModel({ ...base, ...safePatch, id: modelId }, fallback);
      if (!normalized?.protocolId) {
        throw new Error(`Media model "${providerId}/${modelId}" missing protocolId`);
      }
      return normalized;
    });
    if (!found) {
      const normalized = normalizeMediaModel({ id: modelId, ...safePatch }, fallback);
      if (!normalized?.protocolId) {
        throw new Error(`Media model "${providerId}/${modelId}" missing protocolId`);
      }
      mediaConfig.models.push(normalized);
    }
    this._saveAddedModels(userConfig);
    this._entries.clear();
  }

  removeMediaModel(providerId, capability, modelId) {
    const userConfig = this._loadAddedModels();
    const provider = userConfig[providerId] || {};
    const hadExplicitList = hasUserMediaModelList(provider, capability);
    const mediaConfig = this._ensureMediaConfig(userConfig, providerId, capability);
    const sourceModels = hadExplicitList ? mediaConfig.models : this.getMediaModels(providerId, capability);
    mediaConfig.models = sourceModels.filter((item) => getModelId(item) !== modelId);
    this._saveAddedModels(userConfig);
    this._entries.clear();
  }

  /**
 * 向某 provider -models 列表添加一个模型，立即持久- * 不会添加重复项（-id 判断- * @param {string} providerId
    *
   */
  addModel(providerId, model) {
    const userConfig = this._loadAddedModels();
    if (!userConfig[providerId]) userConfig[providerId] = {};
    if (!Array.isArray(userConfig[providerId].models)) {
      userConfig[providerId].models = [];
    }

    const newId = typeof model === "object" ? model.id : model;
    const exists = userConfig[providerId].models.some(
      (m) => (typeof m === "object" ? m.id : m) === newId,
    );
    if (exists) return;

    const nextModels = [...userConfig[providerId].models, model];
    validateProviderModels(providerId, nextModels, { baseUrl: userConfig[providerId].base_url });
    userConfig[providerId].models = nextModels;
    this._saveAddedModels(userConfig);
    this._entries.clear();
  }

  /**
 * 从某 provider -models 列表移除一个模型（-id 匹配），立即持久- * @param {string} providerId
   * @param {string} modelId
   */
  removeModel(providerId, modelId) {
    const userConfig = this._loadAddedModels();
    const uc = userConfig[providerId];
    if (!uc) return;

    if (Array.isArray(uc.models)) {
      uc.models = uc.models.filter(
        (m) => (typeof m === "object" ? m.id : m) !== modelId,
      );
    }
    removeUserMediaModel(uc, modelId);
    this._saveAddedModels(userConfig);
    this._entries.clear();
  }

  /**
 * 更新-provider 的模型条目（-id 查找并替换），立即持久化
 * 裸字符串条目会被升级为对- * @param {string} providerId
   * @param {string} modelId
    *
   */
  updateModelEntry(providerId, modelId, meta) {
    const userConfig = this._loadAddedModels();
    if (!userConfig[providerId]) userConfig[providerId] = {};
    if (!Array.isArray(userConfig[providerId].models)) {
      userConfig[providerId].models = [];
    }
    const uc = userConfig[providerId];

 // 白名单：只允许模型能力字-
    if (meta && typeof meta === "object" && meta.vision !== undefined && meta.image === undefined) {
      meta = { ...meta, image: meta.vision };
    }
    if (meta && typeof meta === "object" && meta.contextWindow !== undefined && meta.context === undefined) {
      meta = { ...meta, context: meta.contextWindow };
    }
    if (meta && typeof meta === "object" && meta.maxTokens !== undefined && meta.maxOutput === undefined) {
      meta = { ...meta, maxOutput: meta.maxTokens };
    }
    if (meta && typeof meta === "object" && meta.maxOutputTokens !== undefined && meta.maxOutput === undefined) {
      meta = { ...meta, maxOutput: meta.maxOutputTokens };
    }

    const ALLOWED = ["name", "context", "maxOutput", "image", "video", "audio", "reasoning", "xhigh", "thinkingLevels", "type", "defaultThinkingLevel"];
    const safe: AnyRecord = {};
    for (const key of ALLOWED) {
      if (meta[key] !== undefined) safe[key] = meta[key];
    }
    const compat = normalizeModelProtocolCompat(meta?.compat);
    if (compat) safe.compat = compat;
    const toolUse = normalizeToolUseContract(meta?.toolUse);
    if (meta?.toolUse !== undefined && !toolUse) {
      throw new Error(`invalid toolUse contract for model "${modelId}"`);
    }
    if (toolUse) safe.toolUse = toolUse;
    const visionCapabilities = normalizeVisionCapabilities(meta?.visionCapabilities);
    if (visionCapabilities) safe.visionCapabilities = visionCapabilities;

    const resolvedType = resolveModelTypeFromModelId(modelId, providerId, safe.type, lookupKnown(providerId, modelId)?.type);
    const mediaCapability = mediaCapabilityForModelType(resolvedType);
    if (mediaCapability && shouldUpdateUserMediaModel(uc, modelId, mediaCapability)) {
      updateUserMediaModel(uc, mediaCapability, modelId, safe);
      uc.models = uc.models.filter((m) => (typeof m === "object" ? m.id : m) !== modelId);
      validateProviderModels(providerId, uc.models, { baseUrl: uc.base_url });
      this._saveAddedModels(userConfig);
      this._entries.clear();
      return;
    }

    let found = false;
    const nextModels = uc.models.map((m) => {
      const mid = typeof m === "object" ? m.id : m;
      if (mid !== modelId) return m;
      found = true;
      const base = typeof m === "object" ? m : { id: mid };
      const cleaned = { ...base };
      delete cleaned.vision;
      return mergeModelMetadata(cleaned, safe);
    });

 // upsert：模型不在列表中时自动添-
    if (!found) {
      nextModels.push({ id: modelId, ...safe });
    }

    validateProviderModels(providerId, nextModels, { baseUrl: uc.base_url });
    uc.models = nextModels;
    this._saveAddedModels(userConfig);
    this._entries.clear();
  }

  /**
 * 创建或更新一-provider 条目（合并写-added-models.yaml- * @param {string} providerId
   * @param {Record<string, any>} data - 要写入的字段（api_key, base_url, api, models 等）
   */
  saveProvider(providerId, data) {
    assertValidProviderCredentialPatch(data, `providers.${providerId}`);
    const userConfig = this._loadAddedModels();
    const { seed_default_models: seedDefaultModels, ...providerData } = data || {};
    if (Object.prototype.hasOwnProperty.call(providerData, "headers")) {
      providerData.headers = normalizeProviderHeaders(providerData.headers);
    }
    let nextProvider = { ...(userConfig[providerId] || {}), ...providerData };
    if (seedDefaultModels && (!Array.isArray(nextProvider.models) || nextProvider.models.length === 0)) {
      const defaults = chatDefaultModels(providerId, this.getDefaultModels(providerId));
      if (defaults.length > 0) nextProvider.models = [...defaults];
    }
    const existingPlugin = this._plugins.get(providerId);
    if (
      isSafeLocalProviderPluginProviderId(providerId)
      && providerConfigHasLocalDefinition(nextProvider)
      && (!existingPlugin || isLocalProviderPlugin(existingPlugin))
    ) {
      nextProvider = this._writeLocalProviderPlugin(providerId, nextProvider, existingPlugin || null);
    } else {
      validateProviderModels(providerId, nextProvider.models, { baseUrl: nextProvider.base_url });
    }
    userConfig[providerId] = nextProvider;
    const existing = safeReadYAMLSync(path.join(this._gsapHome, "added-models.yaml"), {}, YAML) || {};
    const deletedProviders = normalizeDeletedProviders(existing[DELETED_PROVIDERS_KEY])
      .filter((id) => id !== providerId);
    this._saveAddedModels(userConfig, { deletedProviders });
    this._entries.clear();
  }

  /**
 * 删除一-provider（remove 的显式别名）
   * @param {string} providerId
   */
  removeProvider(providerId) {
    this.remove(providerId);
  }

  /**
   * Get models of a specific type for a provider.
 * Type resolution: model entry type field -known-models.json type -default "chat"
   * @param {string} providerId
   * @param {string} type - "chat" | "image" | ...
    *
   */
  getModelsByType(providerId, type) {
    const requestedType = normalizeModelType(type) || type;
    const raw = this._loadAddedModels();
    const userConfig = this._mergeRawProviderConfig(providerId, raw[providerId] || {});
    const models = userConfig.models || [];
    const results = [];
    const seen = new Set();
    for (const m of models) {
      const isObj = typeof m === "object" && m !== null;
      const id = isObj ? m.id : m;
      if (!id) continue;
      const explicitType = isObj ? normalizeModelType(m.type) : null;
      const isMediaType = MEDIA_TYPE_SET.has(requestedType);
      if (isMediaType) {
        if (!hasExplicitModelType(m, requestedType)) continue;
        if (seen.has(id)) continue;
        seen.add(id);
        results.push({ id, name: (isObj && m.name) || id, type: requestedType === "speech" ? "audio" : requestedType });
        continue;
      }
      if (requestedType !== "chat" && explicitType !== requestedType) continue;
      const known = lookupKnown(providerId, id);
      const resolvedType = resolveModelTypeFromModelId(id, providerId, explicitType, known?.type);
      if (resolvedType !== requestedType) continue;
      if (seen.has(id)) continue;
      seen.add(id);
      results.push({ id, name: (isObj && m.name) || known?.name || id, type: resolvedType });
    }

    for (const mediaCapability of mediaCapabilitiesForModelType(requestedType)) {
      const entry = this._entries.get(providerId) || this.get(providerId);
      const userModels = normalizeUserMediaModels(providerId, userConfig, mediaCapability, [], entry);
      for (const model of userModels) {
        if (!model?.id || seen.has(model.id)) continue;
        seen.add(model.id);
        results.push({
          id: model.id,
          name: model.name || model.displayName || model.id,
          type: modelTypeForMediaCapability(mediaCapability) || requestedType,
          ...(model.protocolId ? { protocolId: model.protocolId } : {}),
        });
      }
    }
    return results;
  }

  /**
   * Get all models of a specific type across all providers.
   * @param {string} type
    *
   */
  getAllModelsByType(type) {
    const raw = this._loadAddedModels();
    const results = [];
    for (const providerId of Object.keys(raw)) {
      for (const entry of this.getModelsByType(providerId, type)) {
        results.push({ ...entry, provider: providerId });
      }
    }
    return results;
  }
}
