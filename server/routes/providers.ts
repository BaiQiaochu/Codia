// @ts-nocheck
/**
 * 供应商管-REST 路由
 */
import fs from "fs";
import path from "path";
import os from "os";
import { Hono } from "hono";
import { emitAppEvent } from "../app-events.ts";
import { routeError, strictJson } from "../hono-helpers.ts";
import { clearConfigCache } from "../../lib/memory/config-loader.ts";
import { denySecretMutationWithoutScope, denyWithoutScope } from "../http/capability-guard.ts";
import { buildProviderRequestHeaders, probeProvider } from "../../lib/llm/provider-client.ts";
import { listKnownProviderModels, lookupKnown } from "../../shared/known-models.ts";
import { modelSupportsImageInput, modelSupportsVideoInput, resolveModelInputModalities } from "../../shared/model-capabilities.ts";
import { resolveModelTypeFromModelId } from "../../shared/model-type-inference.ts";
import { OPENAI_IMAGE_MODELS } from "../../shared/openai-image-models.ts";
import { filterDiscoveredProviderModels } from "../../shared/provider-model-validation.ts";
import { buildAnthropicModelsUrl, buildOpenAiModelsUrl, normalizeProviderBaseUrl } from "../../shared/provider-endpoints.ts";
import { collectSecretPatchPaths, isMaskedSecretValue, maskSecretValue } from "../../shared/secret-custody.ts";
import { runtimeApiKeyRefProvider } from "../../shared/runtime-api-key-ref.ts";
import {
  collectProviderHeaderSecretPatchPaths,
  maskProviderHeaders,
  normalizeProviderApiKey,
  normalizeProviderHeaders,
  resolveProviderHeadersPatch,
} from "../../shared/provider-auth.ts";

// ── Models-cache helpers ──

function getCachePath(engine) {
  return path.join(engine.codiaHome, "models-cache.json");
}

function readModelsCache(engine) {
  try {
    return JSON.parse(fs.readFileSync(getCachePath(engine), "utf-8"));
  } catch {
    return {};
  }
}

/** Atomic write: tmp + rename to avoid partial reads */
function writeModelsCache(engine, cache) {
  const target = getCachePath(engine);
  const tmp = target + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2) + os.EOL);
  fs.renameSync(tmp, target);
}

export function createProvidersRoute(engine: any) {
  const route = new Hono<any>();

  function resolveDiscoveredModelType(providerName, modelId, explicitType) {
    const known = lookupKnown(providerName, modelId);
    return resolveModelTypeFromModelId(modelId, providerName, explicitType, known?.type);
  }

  function normalizeDiscoveredModel(providerName, model) {
    const id = typeof model === "object" && model !== null ? model.id : model;
    if (!id) return null;
    const provider = (typeof model === "object" && model?.provider) || providerName;
    const sourceModel = typeof model === "object" && model !== null ? { ...model, id, provider } : { id, provider };
    const supportsImage = modelSupportsImageInput(sourceModel);
    const supportsVideo = modelSupportsVideoInput(sourceModel);
    return {
      id,
      name: (typeof model === "object" && (model.name || model.display_name)) || id,
      type: resolveDiscoveredModelType(provider, id, typeof model === "object" ? model.type : null),
      context: typeof model === "object" ? (model.contextWindow ?? model.context ?? null) : null,
      maxOutput: typeof model === "object" ? (model.maxOutputTokens ?? model.maxOutput ?? null) : null,
      input: resolveModelInputModalities(sourceModel),
      image: supportsImage,
      ...(supportsVideo ? { video: true } : {}),
      vision: supportsImage,
    };
  }

  // ── Cache helper: persist discovered models per-provider ──
  function saveToCache(providerName, models) {
    if (!providerName || !models?.length) return;
    try {
      const cache = readModelsCache(engine);
      cache[providerName] = { models, fetchedAt: new Date().toISOString() };
      writeModelsCache(engine, cache);
    } catch { /* best-effort; cache miss is harmless */ }
  }

  // ── Provider Summary ──

  /**
 * 统一概览：合-added-models.yaml + OAuth status + SDK 模型
 * 前端-ProvidersTab 的核心数据源
   */
  route.get("/providers/summary", async (c) => {
    const rawProviders = engine.providerRegistry.getAllProvidersRaw();
 // 补全凭证和模型列表（getAllProvidersRaw 返回的是 added-models.yaml 原始数据-
    const providers: Record<string, any> = {};
    for (const [name, p] of Object.entries(rawProviders as Record<string, any>)) {
      const entry = engine.providerRegistry.get(name);
      const authType = p.auth_type || entry?.authType || "api-key";
      providers[name] = {
        base_url: p.base_url || entry?.baseUrl || "",
        api_key: maskSecretValue(p.api_key || ""),
        api: p.api || entry?.api || "",
        headers: p.headers || entry?.headers || {},
        auth_type: authType,
        models: p.models || [],
        config_error: p._config_error || null,
      };
    }

 // ProviderRegistry -OAuth 判断的唯一权威
 // 只有-ProviderRegistry 中注册为 authType:"oauth" -provider 才是 OAuth provider
 // Pi SDK 内置的危-OAuth（anthropic/github-copilot 等）不在 Registry 中，不会泄露
    const provRegistry = engine.providerRegistry;

 // OAuth provider 登录状态（Pi SDK AuthStorage，key -authJsonKey-
    const oauthProviders = (engine.modelRuntime?.getProviders?.() || [])
      .filter((provider) => !!provider.auth?.oauth);
    const oauthLoginMap = new Map();
    for (const p of oauthProviders) {
      const authStatus = engine.modelRuntime.getProviderAuthStatus(p.id);
      oauthLoginMap.set(p.id, {
        name: p.name,
        loggedIn: authStatus.configured && engine.modelRuntime.isUsingOAuth(p.id),
      });
    }

 // OAuth 自定义模-
    const oauthCustom = engine.preferences.getOAuthCustomModels();

    const result: Record<string, any> = {};

 // OAuth 登录信息查找（oauthLoginMap -authJsonKey 索引-
    function getOAuthLoginInfo(name) {
      if (oauthLoginMap.has(name)) return oauthLoginMap.get(name);
      const authKey = provRegistry.getAuthJsonKey(name);
      if (authKey !== name && oauthLoginMap.has(authKey)) return oauthLoginMap.get(authKey);
      return null;
    }

 // 先处-added-models.yaml 中的 provider（保持顺序）
    for (const [name, p] of Object.entries(providers)) {
      const isOAuth = provRegistry.isOAuth(name);
      const authType = provRegistry.getAuthType?.(name) || p.auth_type || (isOAuth ? "oauth" : "api-key");
      const oauthInfo = getOAuthLoginInfo(name);
      // added-models.yaml 是模型列表的唯一信源
      const rawModels = p.models || [];
      const customModels = oauthCustom[name] || [];
      const allowsMissingApiKey = !!p.base_url && provRegistry.allowsMissingApiKey?.(name, p.base_url);
      const hasHeaders = Object.keys(p.headers || {}).length > 0;
      const hasCredentials = !!(p.api_key || hasHeaders || (isOAuth && oauthInfo?.loggedIn) || (!isOAuth && allowsMissingApiKey));
      const missingFields = [];
      if (!isOAuth) {
        if (!p.base_url) missingFields.push("base_url");
        if (!hasCredentials) missingFields.push("api_key");
      }
      if (rawModels.length === 0 && customModels.length === 0) missingFields.push("models");

      result[name] = {
        type: isOAuth ? "oauth" : "api-key",
        display_name: oauthInfo?.name || name,
        base_url: p.base_url || "",
        api: p.api || "",
        api_key: maskSecretValue(p.api_key || ""),
        headers: maskProviderHeaders(p.headers || {}),
        auth_type: authType,
        models: rawModels,
        custom_models: customModels,
        has_credentials: hasCredentials,
        logged_in: isOAuth ? !!oauthInfo?.loggedIn : undefined,
        supports_oauth: isOAuth,
        is_coding_plan: name.endsWith("-coding"),
        is_configured: true,
        can_delete: !isOAuth || Object.prototype.hasOwnProperty.call(providers, name),
        config_status: p.config_error ? "invalid" : (missingFields.length > 0 ? "needs_setup" : "ok"),
        config_error: p.config_error || null,
        missing_fields: missingFields,
      };
    }

 // 追加 OAuth-only provider（有 auth.json 但没-added-models.yaml 里）
 // 遍历已注册的 OAuth plugin，用 authJsonKey -oauthLoginMap
    for (const oauthId of provRegistry.getOAuthProviderIds()) {
      if (result[oauthId]) continue;
      const authKey = provRegistry.getAuthJsonKey(oauthId);
      const loginInfo = oauthLoginMap.get(authKey);
      if (!loginInfo) continue;
      const customModels = oauthCustom[authKey] || oauthCustom[oauthId] || [];
      result[oauthId] = {
        type: "oauth",
        display_name: loginInfo.name || oauthId,
        base_url: "",
        api: "",
        api_key: "",
        auth_type: "oauth",
        models: [],
        custom_models: customModels,
        has_credentials: !!loginInfo.loggedIn,
        logged_in: !!loginInfo.loggedIn,
        supports_oauth: true,
        is_coding_plan: false,
        is_configured: true,
        can_delete: false,
        config_status: customModels.length > 0 && loginInfo.loggedIn ? "ok" : "needs_setup",
        config_error: null,
        missing_fields: customModels.length > 0 ? [] : ["models"],
      };
    }

    // 追加 ProviderRegistry 中已声明但尚未出现的 provider（未配置状态）
 // 让用户在设置页看到所有可用供应商，点击即可配-
    if (provRegistry) {
      for (const [id, entry] of provRegistry.getAll()) {
        if (result[id]) continue;
        if (entry.authType === "oauth") continue; // OAuth provider 走上面的白名单逻辑
        result[id] = {
          type: "api-key",
          display_name: entry.displayName || id,
          base_url: entry.baseUrl || "",
          api: entry.api || "",
          api_key: "",
          auth_type: entry.authType || "api-key",
          models: [],
          custom_models: [],
          has_credentials: false,
          logged_in: undefined,
          supports_oauth: false,
          is_coding_plan: id.endsWith("-coding"),
          is_configured: false,
          can_delete: false,
          config_status: "needs_setup",
          config_error: null,
          missing_fields: [
            ...(entry.authType === "none" ? [] : ["api_key"]),
            "models",
          ],
        };
      }
    }

    return c.json({ providers: result });
  });

  /**
   * Explicitly reveal a saved provider API key.
   * Provider summaries stay masked; plaintext must go through this narrow,
   * scope-protected endpoint.
   */
  route.get("/providers/:name/api-key", async (c) => {
    const scopeDenied = denyWithoutScope(c, "providers.manage");
    if (scopeDenied) return scopeDenied;
    const secretDenied = denyWithoutScope(c, "secrets.write", {
      error: "secret_read_scope_required",
    });
    if (secretDenied) return secretDenied;

    const providerName = c.req.param("name");
    const creds = engine.resolveProviderCredentials?.(providerName) || {};
    let apiKey = typeof creds.api_key === "string" ? creds.api_key : "";
    const runtimeProviderId = runtimeApiKeyRefProvider(apiKey);
    if (runtimeProviderId) {
      const model = engine.modelRuntime?.getModels?.(runtimeProviderId)?.[0];
      const resolved = model ? await engine.modelRuntime.getAuth(model) : undefined;
      const runtimeKey = resolved?.auth?.apiKey || "";
      const legacyKey = !runtimeKey
        ? await engine.authStorage?.getApiKey?.(runtimeProviderId)
        : "";
      const key = runtimeKey || legacyKey || "";
      apiKey = runtimeApiKeyRefProvider(key) ? "" : normalizeProviderApiKey(key);
    }
    return c.json({ api_key: apiKey });
  });

  // ── Fetch / Test ──

  function normalizeRegistryModels(models, providerName) {
    return models
      .map((model) => normalizeDiscoveredModel(providerName, model))
      .filter(Boolean);
  }

  function modelItemsFrom(value) {
    if (Array.isArray(value)) return value;
    if (!value || typeof value !== "object") return [];
    return Object.entries(value).map(([id, model]) => {
      if (model && typeof model === "object" && !Array.isArray(model)) {
        return { id, ...model };
      }
      return id;
    });
  }

  function firstModelItems(data, keys) {
    for (const key of keys) {
      const items = modelItemsFrom(data?.[key]);
      if (items.length > 0) return items;
    }
    return modelItemsFrom(data);
  }

  function modelIdFrom(item) {
    if (typeof item === "string") return item.trim();
    if (!item || typeof item !== "object") return "";
    const raw = item.id || item.model || item.model_id || item.name || item.display_name || item.displayName || "";
    return String(raw).replace(/^models\//, "").trim();
  }

  function normalizeGenericRemoteModel(providerName, item) {
    const id = modelIdFrom(item);
    if (!id) return null;
    if (typeof item === "string") return normalizeDiscoveredModel(providerName, id);
    return normalizeDiscoveredModel(providerName, {
      id,
      name: item.display_name || item.displayName || item.name || id,
      context: item.context_length || item.context_window || item.max_context_length || item.max_context_tokens || item.context || item.inputTokenLimit || null,
      maxOutput: item.max_completion_tokens || item.max_output_tokens || item.outputTokenLimit || item.maxOutputTokens || item.maxOutput || null,
      type: item.type,
    });
  }

  function normalizeRemoteModels(data, providerName, api) {
    if (api === "anthropic-messages") {
      return firstModelItems(data, ["data", "models"])
        .map((m) => {
          const id = modelIdFrom(m);
          if (!id) return null;
          if (typeof m === "string") return normalizeDiscoveredModel(providerName, id);
          return normalizeDiscoveredModel(providerName, {
            id,
            name: m.display_name || m.displayName || m.name || id,
            context: m.max_input_tokens ?? m.context_length ?? m.context_window ?? null,
            maxOutput: m.max_tokens ?? m.max_output_tokens ?? null,
          });
        })
        .filter(Boolean);
    }

    if (api === "google-generative-ai") {
      return firstModelItems(data, ["models", "data"])
        .map((m) => {
          const id = m?.baseModelId || modelIdFrom(m);
          if (!id) return null;
          return normalizeDiscoveredModel(providerName, {
            id,
            name: m.displayName || id,
            context: m.inputTokenLimit ?? null,
            maxOutput: m.outputTokenLimit ?? null,
          });
        })
        .filter(Boolean);
    }

    return firstModelItems(data, ["data", "models"])
      .map(m => normalizeGenericRemoteModel(providerName, m))
      .filter(Boolean);
  }

  function filterProviderModels(name, models, baseUrl = "") {
    const { models: filtered, ignoredModels } = filterDiscoveredProviderModels(name, models, { baseUrl });
    const payload: Record<string, any> = { models: filtered };
    if (ignoredModels.length > 0) payload.ignoredModels = ignoredModels;
    return payload;
  }

  function normalizeRequestedModelType(value) {
    const type = String(value || "").trim().toLowerCase();
    if (["chat", "image", "audio", "music", "video"].includes(type)) return type;
    if (type === "llm" || type === "text") return "chat";
    if (type === "image_generation" || type === "text-to-image") return "image";
    if (type === "video_generation" || type === "text-to-video") return "video";
    return "";
  }

  function filterModelsByRequestedType(payload, requestedType) {
    if (!requestedType) return payload;
    return {
      ...payload,
      models: (payload.models || []).filter((model) => model?.type === requestedType),
    };
  }

  function knownCatalogModel(provider, id) {
    const known = lookupKnown(provider, id);
    return normalizeDiscoveredModel(provider, {
      id,
      name: known?.displayName || known?.name || id,
      context: known?.context ?? null,
      maxOutput: known?.maxOutput ?? null,
      type: known?.type,
    });
  }

  function supplementRemoteModels(name, remoteModels, { api = "", requestedType = "" } = {}) {
    const addZhipuCatalog = name === "zhipu";
    const remoteHasImageModels = remoteModels.some((model) => model?.type === "image");
    const remoteHasGptImageModels = remoteModels.some((model) => (
      /^gpt-image(?:-|$)/i.test(String(model?.id || ""))
      || String(model?.id || "").toLowerCase() === "chatgpt-image-latest"
    ));
    const addOpenAIImageCatalog = (
      requestedType === "image"
      || (!requestedType && remoteHasImageModels && !remoteHasGptImageModels)
    )
      && (
        String(name || "").toLowerCase() === "openai"
        || ["openai", "openai-completions", "openai-responses"].includes(String(api || "").toLowerCase())
      );
    if (!addZhipuCatalog && !addOpenAIImageCatalog) return remoteModels;
    const seen = new Set();
    const merged = [];
    const append = (model) => {
      const id = typeof model === "string" ? model : model?.id;
      if (!id || seen.has(id)) return;
      seen.add(id);
      const normalized = typeof model === "string" ? knownCatalogModel(name, id) : model;
      if (normalized) merged.push(normalized);
    };

    for (const model of remoteModels) append(model);
    if (addZhipuCatalog) {
      for (const id of engine.providerRegistry.getDefaultModels?.(name) || []) append(id);
      for (const id of listKnownProviderModels(name)) append(id);
    }
    if (addOpenAIImageCatalog) {
      for (const model of OPENAI_IMAGE_MODELS) {
        append(normalizeDiscoveredModel(name, { ...model, type: "image" }));
      }
    }
    return merged;
  }

  function mediaCapabilitiesForRequestedType(requestedType) {
    if (requestedType === "image") return ["image_generation"];
    if (requestedType === "video") return ["video_generation"];
    if (requestedType === "audio") return ["speech_generation", "speech_recognition"];
    if (requestedType === "music") return ["music_generation"];
    if (requestedType) return [];
    return ["image_generation", "video_generation", "speech_generation", "speech_recognition", "music_generation"];
  }

  function modelTypeForMediaCapability(capability) {
    if (capability === "image_generation") return "image";
    if (capability === "video_generation") return "video";
    if (capability === "music_generation") return "music";
    return "audio";
  }

  function normalizeMediaRegistryModel(providerName, model, fallbackType) {
    const id = typeof model === "object" && model !== null ? model.id : model;
    if (!id) return null;
    const sourceModel = typeof model === "object" && model !== null
      ? {
          ...model,
          id,
          name: model.name || model.displayName || model.display_name || id,
          type: model.type || fallbackType,
        }
      : { id, type: fallbackType };
    const normalized = normalizeDiscoveredModel(providerName, sourceModel);
    if (!normalized) return null;
    return {
      ...normalized,
      type: fallbackType,
      ...(sourceModel.protocolId ? { protocolId: sourceModel.protocolId } : {}),
      ...(sourceModel.inputs ? { inputs: sourceModel.inputs } : {}),
      ...(sourceModel.outputs ? { outputs: sourceModel.outputs } : {}),
    };
  }

  function registryMediaFallback(name, requestedType = "") {
    if (!name || typeof engine.providerRegistry?.getMediaModels !== "function") {
      return { models: [] };
    }
    const models = [];
    const seen = new Set();
    for (const capability of mediaCapabilitiesForRequestedType(requestedType)) {
      const fallbackType = modelTypeForMediaCapability(capability);
      const registryModels = typeof engine.providerRegistry.getRegisteredMediaModels === "function"
        ? engine.providerRegistry.getRegisteredMediaModels(name, capability)
        : engine.providerRegistry.getMediaModels(name, capability);
      for (const model of registryModels || []) {
        const normalized = normalizeMediaRegistryModel(name, model, fallbackType);
        if (!normalized?.id || seen.has(normalized.id)) continue;
        seen.add(normalized.id);
        models.push(normalized);
      }
    }
    return filterProviderModels(name, models);
  }

  function rawProviderConfigFor(name) {
    if (!name || typeof engine.providerRegistry?.getAllProvidersRaw !== "function") return null;
    const raw = engine.providerRegistry.getAllProvidersRaw() || {};
    return raw[name] || raw.providers?.[name] || null;
  }

  function savedModelsFallback(name, requestedType = "", baseUrl = "") {
    const config = rawProviderConfigFor(name);
    const savedModels = Array.isArray(config?.models) ? config.models : [];
    if (savedModels.length === 0) return null;
    const normalized = savedModels
      .map((model) => normalizeDiscoveredModel(name, model))
      .filter(Boolean);
    const payload = filterModelsByRequestedType(filterProviderModels(name, normalized, baseUrl), requestedType);
    if (payload.models.length === 0) return null;
    saveToCache(name, payload.models);
    return { source: "saved", ...payload };
  }

  function cleanApiKey(value) {
    return String(value || "").replace(/[^\x20-\x7E]/g, "").trim();
  }

  function quarantineSavedApiKey(value) {
    return normalizeProviderApiKey(value).trim();
  }

  async function refreshProviderModels() {
    clearConfigCache();
    await engine.onProviderChanged();
    emitAppEvent(engine, "models-changed", { agentId: engine.currentAgentId || null });
  }

 /** Registry -defaults 两级 fallback，fetch-models -Anthropic 路径共用 */
  function hasRemoteCatalogCredentials(name, baseUrl, apiKey, headers, hasInlineBaseUrl) {
    if (hasInlineBaseUrl) return true;
    if (!name) return true;
    if (apiKey) return true;
    if (Object.keys(headers || {}).length > 0) return true;
    const registryCreds = engine.providerRegistry?.getCredentials?.(name);
    const registryEntry = engine.providerRegistry?.get?.(name);
    const authType = String(registryCreds?.authType || registryEntry?.authType || "").toLowerCase();
    if (authType === "none" || authType === "optional") return true;
    return engine.providerRegistry?.allowsMissingApiKey?.(name, baseUrl) === true;
  }

  function registryOrDefaultsFallback(name, requestedType = "") {
    if (!name) {
      return { error: "name is required for model discovery fallback", models: [] };
    }

    // 尝试 Pi SDK registry（含内置 OAuth 模型 + models.json 模型，不经过 availableModels 白名单）
    const registryModels = engine.getRegistryModelsForProvider(name);
    if (registryModels.length > 0) {
      const normalized = normalizeRegistryModels(registryModels, name);
      const payload = filterModelsByRequestedType(filterProviderModels(name, normalized), requestedType);
      if (payload.models.length === 0 && payload.ignoredModels?.length > 0) {
        return {
          source: "registry",
          error: `Registry only returned invalid model ids for provider "${name}": ${payload.ignoredModels.join(", ")}`,
          models: [],
          ignoredModels: payload.ignoredModels,
        };
      }
      if (payload.models.length > 0 || !requestedType) {
        saveToCache(name, payload.models);
        return { source: "registry", ...payload };
      }
    }

 // 回退-default-models.json（用 authJsonKey 兜底，如 openai-codex-oauth -openai-codex-
    const savedPayload = savedModelsFallback(name, requestedType);
    if (savedPayload) return savedPayload;

    if (requestedType && requestedType !== "chat") {
      const payload = registryMediaFallback(name, requestedType);
      if (payload.models.length > 0) {
        saveToCache(name, payload.models);
        return { source: "media", ...payload };
      }
    }

    const authKey = engine.providerRegistry.getAuthJsonKey(name);
    const defaults = engine.providerRegistry.getDefaultModels(name)
      || engine.providerRegistry.getDefaultModels(authKey)
      || [];
    if (defaults.length > 0) {
      const builtinModels = defaults
        .map(id => normalizeDiscoveredModel(name, id))
        .filter(Boolean);
      const payload = filterModelsByRequestedType(filterProviderModels(name, builtinModels), requestedType);
      saveToCache(name, payload.models);
      return { source: "builtin", ...payload };
    }

    if (!requestedType) {
      const payload = registryMediaFallback(name);
      if (payload.models.length > 0) {
        saveToCache(name, payload.models);
        return { source: "media", ...payload };
      }
    }

    return { error: `No models found for provider "${name}"`, models: [] };
  }

  /**
   * 从供应商拉取模型列表
   * Flow: credentials -> remote model catalog -> registry fallback -> defaults fallback.
    *
   * OpenAI-compatible providers use GET {base}/models.
    *
   */
  function probeModelIdForProvider(name, body = {}) {
    const explicit = modelIdFrom(body.model_id || body.modelId || body.model);
    if (explicit) return explicit;
    if (!name) return "";

    const registryModels = typeof engine.getRegistryModelsForProvider === "function"
      ? engine.getRegistryModelsForProvider(name) || []
      : [];
    for (const model of registryModels) {
      const id = modelIdFrom(model);
      if (id) return id;
    }

    const authKey = engine.providerRegistry?.getAuthJsonKey?.(name);
    const defaults = [
      ...(engine.providerRegistry?.getDefaultModels?.(name) || []),
      ...(authKey && authKey !== name ? engine.providerRegistry?.getDefaultModels?.(authKey) || [] : []),
    ];
    for (const model of defaults) {
      const id = modelIdFrom(model);
      if (id) return id;
    }

    return "";
  }

  async function discoverProbeModelId({ name, baseUrl, api, apiKey, headers }) {
    if (!name || api !== "anthropic-messages" || !baseUrl) return "";
    try {
      const base = String(baseUrl || "").replace(/\/+$/, "");
      const url = buildAnthropicModelsUrl(base, { provider: name, api });
      const buildCatalogHeaders = (anthropicAuthScheme) => buildProviderRequestHeaders({
        api,
        apiKey,
        headers,
        provider: name,
        baseUrl,
        allowMissingApiKey: true,
        anthropicAuthScheme,
      });
      let res = await fetch(url, {
        headers: buildCatalogHeaders(undefined),
        signal: AbortSignal.timeout(10000),
      });
      if (apiKey && (res.status === 401 || res.status === 403)) {
        res = await fetch(url, {
          headers: buildCatalogHeaders("bearer"),
          signal: AbortSignal.timeout(10000),
        });
      }
      if (!res.ok) return "";
      const data = await res.json();
      const models = normalizeRemoteModels(data, name, api);
      if (models.length > 0) saveToCache(name, models);
      return models.find(model => model?.id)?.id || "";
    } catch {
      return "";
    }
  }

  route.post("/providers/fetch-models", async (c) => {
    let body;
    try {
      body = await strictJson(c);
    } catch (err) {
      return routeError(c, err);
    }
    const scopeDenied = denyWithoutScope(c, "providers.manage");
    if (scopeDenied) return scopeDenied;
    const secretDenied = denySecretMutationWithoutScope(c, [
      ...collectSecretPatchPaths(body, ["api_key"] as any),
      ...collectProviderHeaderSecretPatchPaths(body.headers, "headers"),
    ]);
    if (secretDenied) return secretDenied;
    const { name, base_url, api: explicitApi, api_key } = body;
    const requestedType = normalizeRequestedModelType(body.model_type || body.type || body.media_type);
    const hasInlineBaseUrl = typeof base_url === "string" && base_url.trim().length > 0;
    if (!name && !base_url) {
      return c.json({ error: "name or base_url is required" }, 400);
    }

 // ── 1. 凭证解析：请求体 > resolveProviderCredentials（统一路径-──
    const saved = name ? engine.resolveProviderCredentials(name) : { api_key: "", base_url: "", api: "" };

    const effectiveKey = isMaskedSecretValue(api_key)
      ? quarantineSavedApiKey(saved.api_key)
      : cleanApiKey(api_key) || quarantineSavedApiKey(saved.api_key) || "";
    const effectiveApi = explicitApi || saved.api || "";
    const effectiveBaseUrl = normalizeProviderBaseUrl({
      provider: name,
      baseUrl: base_url || saved.base_url || "",
      api: effectiveApi,
    });
    const endpointProvider = name;
    const effectiveHeaders = Object.prototype.hasOwnProperty.call(body, "headers")
      ? resolveProviderHeadersPatch({ patch: body.headers, existing: saved.headers || {} })
      : normalizeProviderHeaders(saved.headers);
    const hasEffectiveRemoteCredentials = !!effectiveKey || Object.keys(effectiveHeaders || {}).length > 0;

    // 2. Remote model catalog. Skip credentialed cloud catalogs until a key/header is available.
    if (effectiveBaseUrl && hasRemoteCatalogCredentials(name, effectiveBaseUrl, effectiveKey, effectiveHeaders, hasInlineBaseUrl)) {
      try {
        const isAnthropic = effectiveApi === "anthropic-messages";
        const base = effectiveBaseUrl.replace(/\/+$/, "");
        const url = isAnthropic
          ? buildAnthropicModelsUrl(base, { provider: endpointProvider, api: effectiveApi })
          : buildOpenAiModelsUrl(base);
        if (effectiveKey && !effectiveApi) {
          return c.json({ error: "api is required when api_key is present", models: [] });
        }
        const buildCatalogHeaders = (anthropicAuthScheme) => buildProviderRequestHeaders({
          api: effectiveApi,
          apiKey: effectiveKey,
          headers: effectiveHeaders,
          provider: endpointProvider,
          baseUrl: effectiveBaseUrl,
          allowMissingApiKey: true,
          anthropicAuthScheme,
        });
        let res = await fetch(url, {
          headers: buildCatalogHeaders(undefined),
          signal: AbortSignal.timeout(15000),
        });
        if (isAnthropic && effectiveKey && (res.status === 401 || res.status === 403)) {
          res = await fetch(url, {
            headers: buildCatalogHeaders("bearer"),
            signal: AbortSignal.timeout(15000),
          });
        }

        // 401/403：凭证问题，直接返回错误，不 fallback
        if (res.status === 401 || res.status === 403) {
          if (hasEffectiveRemoteCredentials) {
            return c.json({ error: `HTTP ${res.status}: ${res.statusText}`, models: [] });
          }
        }

        if (res.ok) {
          const data = await res.json();
          const remoteModels = supplementRemoteModels(
            name,
            normalizeRemoteModels(data, name, effectiveApi),
            { api: effectiveApi, requestedType },
          );
          const payload = filterModelsByRequestedType(
            filterProviderModels(name, remoteModels, effectiveBaseUrl),
            requestedType,
          );
          if (payload.models.length === 0 && payload.ignoredModels?.length > 0) {
            return c.json({
              error: `Remote catalog only returned invalid model ids for provider "${name}": ${payload.ignoredModels.join(", ")}`,
              models: [],
              ignoredModels: payload.ignoredModels,
            });
          }
          saveToCache(name, payload.models);
          return c.json(payload);
        }

        // 404 and other non-auth failures fall through to registry/defaults.
      } catch {
        // Network failures fall through to registry/defaults.
      }
    }

    // 3. Registry + defaults fallback.
    return c.json(registryOrDefaultsFallback(name, requestedType));
  });

  /**
   * 读取供应商已发现但尚未添加的模型（缓存）
   * GET /api/providers/:name/discovered-models
   */
  route.get("/providers/:name/discovered-models", (c) => {
    const scopeDenied = denyWithoutScope(c, "providers.manage");
    if (scopeDenied) return scopeDenied;
    const providerName = c.req.param("name");
    const cache = readModelsCache(engine);
    const entry = cache[providerName];
    if (!entry) return c.json({ models: [], fetchedAt: null });
    const creds = engine.resolveProviderCredentials?.(providerName) || {};
    const payload = filterProviderModels(providerName, entry.models || [], creds.base_url || "");
    return c.json({ ...payload, fetchedAt: entry.fetchedAt || null });
  });

  /**
 * 测试供应商连- * body: { name-, base_url-, api-, api_key- }
 * 凭证解析优先级与 fetch-models 一致：请求-> resolveProviderCredentials > 插件默认- */
  route.post("/providers/test", async (c) => {
    let body;
    try {
      body = await strictJson(c);
    } catch (err) {
      return routeError(c, err);
    }
    const scopeDenied = denyWithoutScope(c, "providers.manage");
    if (scopeDenied) return scopeDenied;
    const secretDenied = denySecretMutationWithoutScope(c, [
      ...collectSecretPatchPaths(body, ["api_key"] as any),
      ...collectProviderHeaderSecretPatchPaths(body.headers, "headers"),
    ]);
    if (secretDenied) return secretDenied;
    const { name } = body;
    // 清洗 API key：去除非 ASCII 字符（防止粘贴时输入法带入中文）
    const bodyKey = isMaskedSecretValue(body.api_key) ? "" : cleanApiKey(body.api_key);

 // ── 凭证解析：请求体 > resolveProviderCredentials（统一路径-──
    const saved = name ? engine.resolveProviderCredentials(name) : { api_key: "", base_url: "", api: "" };

    const api_key = bodyKey || quarantineSavedApiKey(saved.api_key) || "";
    const api = body.api || saved.api || "";
    const base_url = normalizeProviderBaseUrl({
      provider: name,
      baseUrl: body.base_url || saved.base_url || "",
      api,
    });
    const endpointProvider = name;
    const headers = Object.prototype.hasOwnProperty.call(body, "headers")
      ? resolveProviderHeadersPatch({ patch: body.headers, existing: saved.headers || {} })
      : normalizeProviderHeaders(saved.headers);
    const hasInlineProviderConfig = !!(body.base_url || body.api || body.api_key || body.headers);

    if (!base_url) {
      return c.json({ error: "base_url is required" }, 400);
    }
    if (api_key && !api) {
      return c.json({ error: "api is required when api_key is present" }, 400);
    }

    try {
      const registryProbeModelId = probeModelIdForProvider(name, body);
      const discoveredProbeModelId = registryProbeModelId || (hasInlineProviderConfig
        ? await discoverProbeModelId({ name, baseUrl: base_url, api, apiKey: api_key, headers })
        : "");
      const result = await probeProvider({
        baseUrl: base_url,
        api,
        apiKey: api_key,
        modelId: registryProbeModelId || discoveredProbeModelId,
        provider: endpointProvider,
        headers,
      });
      return c.json(result);
    } catch (err) {
      return c.json({ ok: false, error: err.message });
    }
  });

  /**
 * 更新模型元数据（context/vision/reasoning/maxOutput/name- * 写回 added-models.yaml -触发 model-sync -SDK 模型对象更新
   */
  route.put("/providers/:name/models/:modelId", async (c) => {
    const scopeDenied = denyWithoutScope(c, "providers.manage");
    if (scopeDenied) return scopeDenied;
    const providerName = c.req.param("name");
    const modelId = decodeURIComponent(c.req.param("modelId"));
    let body;
    try {
      body = await strictJson(c);
    } catch (err) {
      return routeError(c, err);
    }
    if (!body || typeof body !== "object") {
      return c.json({ error: "invalid body" }, 400);
    }
    try {
      engine.providerRegistry.updateModelEntry(providerName, modelId, body);
      await refreshProviderModels();
      return c.json({ ok: true });
    } catch (err) {
      const status = err.message?.includes("not found") ? 404 : 500;
      return c.json({ error: err.message }, status);
    }
  });

  route.delete("/providers/:name/models/:modelId", async (c) => {
    const scopeDenied = denyWithoutScope(c, "providers.manage");
    if (scopeDenied) return scopeDenied;
    const providerName = c.req.param("name");
    const modelId = decodeURIComponent(c.req.param("modelId"));
    try {
      engine.providerRegistry.removeModel(providerName, modelId);
      await refreshProviderModels();
      return c.json({ ok: true });
    } catch (err) {
      const status = err.message?.includes("not found") ? 404 : 500;
      return c.json({ error: err.message }, status);
    }
  });

  return route;
}
