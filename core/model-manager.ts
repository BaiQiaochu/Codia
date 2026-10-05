// @ts-nocheck
/**
  *
  * */
import path from "path";
import fs from "fs";
import { ModelRuntime, createModelRegistry } from "../lib/pi-sdk/index.ts";
import { t } from "../lib/i18n.ts";
import { ProviderRegistry } from "./provider-registry.ts";
import { ExecutionRouter } from "./execution-router.ts";
import { findModel, parseModelRef } from "../shared/model-ref.ts";
import { allowsMissingApiKey } from "../shared/net-utils.ts";
import { normalizeProviderApiKey } from "../shared/provider-auth.ts";
import { runtimeApiKeyRefProvider } from "../shared/runtime-api-key-ref.ts";
import { syncModels } from "./model-sync.ts";
import { atomicWriteSync } from "../shared/safe-fs.ts";
import { enrichModelFromKnownMetadata } from "./model-known-enrichment.ts";
import { migrateLegacyApiKeyAuthToProviders } from "./provider-auth-migration.ts";
import {
  normalizeSessionThinkingLevel,
  normalizePiSdkThinkingLevel,
  normalizeThinkingLevelChoices,
  normalizeThinkingLevelForModel,
  resolveModelDefaultThinkingLevel,
} from "./session-thinking-level.ts";

function isRecord(value): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function modelEntryId(modelEntry: unknown) {
  return isRecord(modelEntry) ? modelEntry.id : modelEntry;
}

function modelMetadataKey(provider, modelId) {
  return `${provider || ""}\0${modelId || ""}`;
}

function providerModelDefault(rawProvider: Record<string, unknown>, modelId: string) {
  const modelDefaults = isRecord(rawProvider.model_defaults) ? rawProvider.model_defaults : null;
  const entry = isRecord(modelDefaults?.[modelId]) ? modelDefaults[modelId] : null;
  const level = entry?.thinking_level ?? entry?.thinkingLevel;
  return typeof level === "string" ? level : undefined;
}

function buildProviderModelMetadataMap(rawProviders: unknown) {
  const map = new Map<string, Record<string, unknown>>();
  const providers = isRecord(rawProviders) ? rawProviders : {};
  for (const [provider, rawProviderValue] of Object.entries(providers)) {
    const rawProvider = isRecord(rawProviderValue) ? rawProviderValue : {};
    const models = Array.isArray(rawProvider.models) ? rawProvider.models : [];
    for (const modelEntry of models) {
      const modelId = modelEntryId(modelEntry);
      if (typeof modelId !== "string" || !modelId) continue;
      const meta: Record<string, unknown> = {};
      if (isRecord(modelEntry)) {
        if (modelEntry.xhigh !== undefined) meta.xhigh = modelEntry.xhigh === true;
        if (modelEntry.defaultThinkingLevel !== undefined) meta.defaultThinkingLevel = modelEntry.defaultThinkingLevel;
        const thinkingLevels = normalizeThinkingLevelChoices(modelEntry.thinkingLevels);
        if (thinkingLevels) meta.thinkingLevels = thinkingLevels;
        if (modelEntry.toolUse !== undefined) meta.toolUse = structuredClone(modelEntry.toolUse);
        if (modelEntry.visionCapabilities !== undefined) meta.visionCapabilities = structuredClone(modelEntry.visionCapabilities);
      }
      const defaultThinkingLevel = providerModelDefault(rawProvider, modelId);
      if (defaultThinkingLevel !== undefined) meta.defaultThinkingLevel = defaultThinkingLevel;
      if (Array.isArray(meta.thinkingLevels) && meta.thinkingLevels.includes("max") && meta.xhigh === undefined) {
        meta.xhigh = true;
      }
      if (Object.keys(meta).length > 0) {
        map.set(modelMetadataKey(provider, modelId), meta);
      }
    }
  }
  return map;
}

function applyProviderModelMetadata(model, metadataByModel) {
  const meta = metadataByModel.get(modelMetadataKey(model?.provider, model?.id));
  if (!meta) return model;
  const merged = { ...model, ...meta };
  const thinkingLevels = normalizeThinkingLevelChoices(merged.thinkingLevels);
  if (thinkingLevels) {
    merged.thinkingLevels = thinkingLevels;
    if (thinkingLevels.includes("max")) merged.xhigh = true;
  } else {
    delete merged.thinkingLevels;
  }
  if (typeof merged.defaultThinkingLevel === "string") {
    merged.defaultThinkingLevel = normalizeThinkingLevelForModel(merged.defaultThinkingLevel, merged);
  }
  return merged;
}

export class ModelManager {
  constructor({ gsapHome, hanakoHome } = {}) {
    this._gsapHome = gsapHome || hanakoHome;
    this._modelRegistry = null;
    this._modelRuntime = null;
    this._defaultModel = null;
    this._availableModels = [];

    this.providerRegistry = new ProviderRegistry(gsapHome);
    this.executionRouter = null;
  }

  async init() {
    fs.mkdirSync(this._gsapHome, { recursive: true });
    const authJsonPath = path.join(this._gsapHome, "auth.json");
    if (!fs.existsSync(authJsonPath)) fs.writeFileSync(authJsonPath, "{}\n", { mode: 0o600 });
    this.providerRegistry.reload();
    await this._removeApiKeyProviderAuthEntries();
    this._modelRuntime = await ModelRuntime.create({
      authPath: authJsonPath,
      modelsPath: path.join(this._gsapHome, "models.json"),
      allowModelNetwork: false,
    });
    await this._applyRuntimeApiKeyOverrides(this.providerRegistry.getAllProvidersRaw());
    this._modelRegistry = createModelRegistry(this._modelRuntime);

    this.executionRouter = new ExecutionRouter(
      (ref) => this._resolveFromAvailable(ref),
      this.providerRegistry,
    );
  }

  get modelRegistry() { return this._modelRegistry; }
  get modelRuntime() { return this._modelRuntime; }
  get defaultModel() { return this._defaultModel; }
  set defaultModel(m) { this._defaultModel = m; }
  get currentModel() { return this._defaultModel; }
  get availableModels() { return this._availableModels; }
  get modelsJsonPath() { return path.join(this._gsapHome, "models.json"); }
  get authJsonPath() { return path.join(this._gsapHome, "auth.json"); }

  /**
  *
  *
   * - "provider/id"
   *
  * */
  _resolveFromAvailable(ref) {
    const parsed = parseModelRef(ref);
    if (!parsed?.id || !parsed?.provider) return null;
    return findModel(this._availableModels, parsed.id, parsed.provider) || null;
  }

  _getPersistedModelDefaultThinkingLevel(model) {
    if (!model?.provider || !model.id) return null;
    if (typeof this.providerRegistry.getModelDefaultThinkingLevel !== "function") return null;
    return this.providerRegistry.getModelDefaultThinkingLevel(model.provider, model.id);
  }

  _withPersistedModelDefaultThinkingLevel(model) {
    const level = this._getPersistedModelDefaultThinkingLevel(model);
    return level ? { ...model, defaultThinkingLevel: level } : model;
  }

  _allowsRuntimeDiscoveredModel(model) {
    if (!model?.provider) return false;
    const resolved = this.providerRegistry.resolveChatProvider?.(model.provider);
    if (resolved) return resolved.projection !== "none";
    return !!this.providerRegistry.get?.(model.provider);
  }

  async refreshAvailable() {
    const allModels = await this._modelRegistry.getAvailable();
    const rawProviders = this.providerRegistry.getAllProvidersRaw();
    const userModelSets = new Map();
    for (const [name, raw] of Object.entries(rawProviders)) {
      if (!raw.models?.length) continue;
      const chatIds = typeof this.providerRegistry.getChatModelIds === "function"
        ? this.providerRegistry.getChatModelIds(name)
        : raw.models.map((m) => typeof m === "object" ? m.id : m);
      const ids = new Set(chatIds);
      userModelSets.set(name, ids);
      const authKey = this.providerRegistry.getAuthJsonKey(name);
      if (authKey !== name) userModelSets.set(authKey, ids);
    }
    const metadataByModel = buildProviderModelMetadataMap(rawProviders);
    this._availableModels = allModels.filter((m) => {
      const allowed = userModelSets.get(m.provider);
      if (!allowed) return this._allowsRuntimeDiscoveredModel(m);
      return allowed.has(m.id);
    })
      .map(m => applyProviderModelMetadata(m, metadataByModel))
      .map(enrichModelFromKnownMetadata)
      .map(m => this._withPersistedModelDefaultThinkingLevel(m));
    return this._availableModels;
  }

  /**
  * */
  async syncAndRefresh() {
    this._removeApiKeyProviderAuthEntries();
    const rawProviders = this.providerRegistry.getAllProvidersRaw();
    const providers = {};
    for (const [name, raw] of Object.entries(rawProviders)) {
      const entry = this.providerRegistry.get(name);
      providers[name] = {
        ...raw,
        base_url: raw.base_url || entry?.baseUrl || "",
        api: raw.api || entry?.api || "openai-completions",
        auth_type: raw.auth_type || entry?.authType || "api-key",
        headers: raw.headers || entry?.headers || {},
      };
    }
    const changed = syncModels(providers, {
      modelsJsonPath: this.modelsJsonPath,
      authJsonPath: this.authJsonPath,
      oauthKeyMap: this._buildOAuthKeyMap(),
      chatProjectionMap: this._buildChatProjectionMap(),
    });
    await this._applyRuntimeApiKeyOverrides(providers);
    if (changed) {
      await this._modelRegistry.refresh();
      await this.refreshAvailable();
      this._rebindDefaultModel();
    }
    return changed;
  }

  async _applyRuntimeApiKeyOverrides(providers) {
    if (!this._modelRuntime?.setRuntimeApiKey) return;
    for (const [providerId, provider] of Object.entries(providers || {})) {
      const configuredApiKey = normalizeProviderApiKey(provider?.api_key);
      const referencedProviderId = runtimeApiKeyRefProvider(configuredApiKey);
      if (referencedProviderId === providerId) continue;
      const referencedCredential = referencedProviderId
        ? this.providerRegistry.getCredentials?.(referencedProviderId)
        : null;
      if (runtimeApiKeyRefProvider(referencedCredential?.apiKey)) continue;
      const apiKey = referencedProviderId
        ? normalizeProviderApiKey(referencedCredential?.apiKey)
        : configuredApiKey;
      const piProvider = this._modelRuntime.getProvider(providerId);
      const hasNativeApiKeyAuth = !!piProvider?.auth?.apiKey;
      if (apiKey && !hasNativeApiKeyAuth && this.providerRegistry.getAuthType(providerId) !== "oauth") {
        this._modelRuntime.registerProvider(providerId, {
          name: this.providerRegistry.get(providerId)?.name || providerId,
          baseUrl: provider?.base_url || this.providerRegistry.get(providerId)?.baseUrl,
          api: provider?.api || this.providerRegistry.get(providerId)?.api || "openai-completions",
          apiKey: "$GSAP_RUNTIME_API_KEY",
          headers: provider?.headers,
          authHeader: provider?.auth_header,
        });
      }
      if (apiKey) {
        await this._modelRuntime.setRuntimeApiKey(providerId, apiKey);
      } else {
        await this._modelRuntime.removeRuntimeApiKey(providerId);
      }
    }
  }

  _rebindDefaultModel() {
    if (!this._defaultModel) return;
    const { id, provider } = this._defaultModel;
    if (!id || !provider) {
      this._defaultModel = null;
      return;
    }
    this._defaultModel = findModel(this._availableModels, id, provider) || null;
  }

  _buildOAuthKeyMap() {
    const map = {};
    for (const id of this.providerRegistry.getOAuthProviderIds()) {
      const authKey = this.providerRegistry.getAuthJsonKey(id);
      if (authKey !== id) map[id] = authKey;
    }
    return map;
  }

  _buildChatProjectionMap() {
    const map = {};
    for (const id of Object.keys(this.providerRegistry.getAllProvidersRaw())) {
      const projection = this.providerRegistry.getChatProjection?.(id);
      if (projection && projection !== "models-json") map[id] = projection;
    }
    return map;
  }

  async _removeApiKeyProviderAuthEntries() {
    if (!this.providerRegistry) return;
    migrateLegacyApiKeyAuthToProviders({
      gsapHome: this._gsapHome,
      providerRegistry: this.providerRegistry,
    });
    let credentials = {};
    try { credentials = JSON.parse(fs.readFileSync(path.join(this._gsapHome, "auth.json"), "utf8")); } catch {}
    let changed = false;
    for (const entry of this.providerRegistry.getAll().values()) {
      if (entry.authType === "oauth") continue;
      const authKeys = new Set([entry.id, entry.authJsonKey]);
      for (const authKey of authKeys) {
        if (!authKey) continue;
        if (credentials[authKey]?.type === "api_key") {
          delete credentials[authKey];
          changed = true;
        }
      }
    }
    if (changed) atomicWriteSync(path.join(this._gsapHome, "auth.json"), `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
  }

  setDefaultModel(modelId, provider) {
    const model = findModel(this._availableModels, modelId, provider);
    if (!model) throw new Error(t("error.modelNotFound", { id: modelId }));
    this._defaultModel = model;
    return model;
  }

  resolveThinkingLevel(level) {
    return normalizePiSdkThinkingLevel(level);
  }

  _resolveModelForThinkingDefault(modelRef) {
    if (!modelRef) return this.currentModel;
    if (typeof modelRef !== "string") return modelRef;
    const ref = modelRef.trim();
    if (!ref) return this.currentModel;

    const model = this._resolveFromAvailable(ref);
    if (model) return model;

    throw new Error(t("error.modelNotFound", { id: ref }));
  }

  resolveModelThinkingLevel(modelRef, fallback = "medium") {
    const model = this._resolveModelForThinkingDefault(modelRef);
    const effectiveModel = model || this.currentModel || {};
    return resolveModelDefaultThinkingLevel(effectiveModel, normalizeSessionThinkingLevel(fallback));
  }

  async setModelDefaultThinkingLevel(modelRef, level) {
    const model = this._resolveModelForThinkingDefault(modelRef);
    if (!model?.id || !model.provider) {
      throw new Error("setModelDefaultThinkingLevel: model id and provider required");
    }
    const nextLevel = normalizeThinkingLevelForModel(level, model);
    this.providerRegistry.setModelDefaultThinkingLevel(model.provider, model.id, nextLevel);
    await this.syncAndRefresh();
    await this.refreshAvailable();
    this._rebindDefaultModel();
    const refreshed = findModel(this._availableModels, model.id, model.provider)
      || { ...model, defaultThinkingLevel: nextLevel };
    return {
      model: refreshed,
      thinkingLevel: resolveModelDefaultThinkingLevel(refreshed, nextLevel),
    };
  }

  resolveExecutionModel(modelRef) {
    if (!modelRef) return this.currentModel;
    if (typeof modelRef !== "string") return modelRef;
    const ref = modelRef.trim();
    if (!ref) return this.currentModel;

    const model = this._resolveFromAvailable(ref);
    if (model) return model;

    throw new Error(t("error.modelNotFound", { id: ref }));
  }

  resolveProviderCredentials(provider) {
    if (!provider) return { api_key: "", base_url: "", api: "" };
    const cred = this.providerRegistry.getCredentials(provider);
    if (cred) {
      return {
        api_key: cred.apiKey || "",
        base_url: cred.baseUrl || "",
        api: cred.api || "",
        auth_type: cred.authType || "api-key",
        headers: cred.headers || {},
      };
    }
    return { api_key: "", base_url: "", api: "" };
  }

  async resolveProviderCredentialsFresh(provider) {
    if (!provider) return { api_key: "", base_url: "", api: "" };
    const entry = this.providerRegistry.get(provider);
    let refreshedOAuthKey = null;
    if (entry && this.providerRegistry.getAuthType(provider) === "oauth" && this._modelRuntime) {
      const model = this._modelRuntime.getModels(provider).find((candidate) => candidate.id === entry.defaultModelId)
        || this._modelRuntime.getModels(provider)[0];
      const resolved = model ? await this._modelRuntime.getAuth(model) : undefined;
      refreshedOAuthKey = normalizeProviderApiKey(resolved?.auth?.apiKey) || null;
    }
    const cred = this.providerRegistry.getCredentials(provider);
    if (entry && this.providerRegistry.getAuthType(provider) === "oauth" && !refreshedOAuthKey) {
      return {
        api_key: "",
        base_url: cred?.baseUrl || entry.baseUrl || "",
        api: cred?.api || entry.api || "",
        headers: cred?.headers || entry.headers || {},
        ...(cred?.accountId ? { accountId: cred.accountId } : {}),
      };
    }
    if (cred) {
      return {
        api_key: refreshedOAuthKey || cred.apiKey || "",
        base_url: cred.baseUrl || "",
        api: cred.api || "",
        auth_type: cred.authType || "api-key",
        headers: cred.headers || {},
        ...(cred.accountId ? { accountId: cred.accountId } : {}),
      };
    }
    return { api_key: "", base_url: "", api: "" };
  }

  async reloadAndSync() {
    this.providerRegistry.reload();
    await this.syncAndRefresh();
  }

  resolveModelWithCredentials(modelRef) {
    const entry = this.resolveExecutionModel(modelRef);
    const provider = entry?.provider;
    if (!provider) {
      throw new Error(t("error.modelNoProvider", { role: "resolve", model: String(modelRef) }));
    }
    const creds = this.resolveProviderCredentials(provider);
    if (!creds.api) {
      throw new Error(t("error.providerMissingApi", { provider }));
    }
    const canUseWithoutKey = allowsMissingApiKey({
      baseUrl: creds.base_url,
      authType: creds.auth_type,
    });
    const headers = creds.headers || {};
    const hasHeaders = Object.keys(headers).length > 0;
    if (!creds.base_url || (!creds.api_key && !hasHeaders && !canUseWithoutKey)) {
      throw new Error(t("error.providerMissingCreds", { provider }));
    }
    const modelWithHeaders = hasHeaders
      ? { ...entry, headers: { ...(entry.headers || {}), ...headers } }
      : entry;
    return {
      model: modelWithHeaders,
      provider,
      api: creds.api,
      api_key: creds.api_key || (canUseWithoutKey ? "local" : ""),
      base_url: creds.base_url,
      headers,
    };
  }

  resolveUtilityConfig(agentConfig, sharedModels, utilApi) {
    if (!this.executionRouter) {
      throw new Error(t("error.noUtilityModel"));
    }
    return this.executionRouter.resolveUtilityConfig(agentConfig, sharedModels, utilApi);
  }

  traceUtilityConfig(agentConfig, sharedModels, utilApi) {
    if (!this.executionRouter) {
      throw new Error(t("error.noUtilityModel"));
    }
    return this.executionRouter.traceUtilityConfig(agentConfig, sharedModels, utilApi);
  }

  getRegistryModelsForProvider(name) {
    const authKey = this.providerRegistry.getAuthJsonKey(name);
    const all = this._modelRegistry.getAll();
    return all.filter((m) => m.provider === name || m.provider === authKey);
  }
}
