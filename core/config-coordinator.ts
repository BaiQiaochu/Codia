// @ts-nocheck
/**
 * ConfigCoordinator -运行时配置管- *
  * */
import { createModuleLogger } from "../lib/debug-log.ts";
import { findModel, parseModelRef } from "../shared/model-ref.ts";
import { allowsMissingApiKey } from "../shared/net-utils.ts";
import { t } from "../lib/i18n.ts";
import { resolveDefaultWorkspacePath } from "../shared/default-workspace.ts";
import {
  AUTO_SEARCH_PROVIDER,
  isSearchApiProvider,
  mergeSearchApiKeys,
  normalizeSearchApiKeys,
  normalizeSearchProvider,
} from "../shared/search-providers.ts";
import {
  classifyWorkspacePathForGc,
  pruneMissingWorkspaceConfig,
} from "../shared/workspace-persistence-gc.ts";

const log = createModuleLogger("config");

export const ACCESS_MODE_OPERATE = "operate";
export const ACCESS_MODE_READ_ONLY = "read_only";

/** Plan Mode / Bridge 只读工具名白名单 */
export const READ_ONLY_BUILTIN_TOOLS = ["read", "grep", "find", "ls"];

export const READ_ONLY_TOOL_NAMES = [
  ...READ_ONLY_BUILTIN_TOOLS,
  "search_memory",
  "web_search",
  "web_fetch",
  "current_status",
  "recall_experience",
  "browser",
];

const READ_ONLY_TOOL_NAME_SET = new Set(READ_ONLY_TOOL_NAMES);

export function isReadOnlyAccessMode(mode) {
  return normalizeAccessMode(mode) === ACCESS_MODE_READ_ONLY;
}

export function filterReadOnlyToolNames(toolNames) {
  return (toolNames || []).filter((name) => READ_ONLY_TOOL_NAME_SET.has(name));
}

export function normalizeAccessMode(mode, { legacyPlanMode = false } = {}) {
  if (mode === ACCESS_MODE_READ_ONLY) return ACCESS_MODE_READ_ONLY;
  if (mode === ACCESS_MODE_OPERATE) return ACCESS_MODE_OPERATE;
  return legacyPlanMode ? ACCESS_MODE_READ_ONLY : ACCESS_MODE_OPERATE;
}

/** 全局共享模型字段 -preferences key 映射 */
export const SHARED_MODEL_KEYS = [
  ["utility",        "utility_model"],
  ["utility_large",  "utility_large_model"],
  ["vision",         "vision_model"],
  ["summarizer",     "summarizer_model"],
  ["compiler",       "compiler_model"],
];

export const VISION_AUXILIARY_ENABLED_PREF_KEY = "vision_auxiliary_enabled";

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

export function sharedModelsPatchRequiresModelSync(patch) {
  if (!patch || typeof patch !== "object") return false;
  return SHARED_MODEL_KEYS.some(([field]) => hasOwn(patch, field));
}

export function normalizeSharedModelsPatch(partial) {
  if (!partial || typeof partial !== "object" || Array.isArray(partial)) {
    throw new Error("shared models patch must be an object");
  }

  const result = {};
  for (const [field] of SHARED_MODEL_KEYS) {
    if (!hasOwn(partial, field)) continue;
    const raw = partial[field];
    if (raw === undefined) continue;
    if (raw === null || raw === "") {
      result[field] = null;
      continue;
    }

    const parsed = parseModelRef(raw);
    if (!parsed?.id) {
      throw new Error(`shared model ${field}: missing id`);
    }
    if (parsed.provider) {
      result[field] = { id: parsed.id, provider: parsed.provider };
      continue;
    }
    if (typeof raw === "string") {
      result[field] = raw.trim();
      continue;
    }
    throw new Error(`shared model ${field}: missing provider`);
  }
  if (hasOwn(partial, "vision_enabled")) {
    const raw = partial.vision_enabled;
    if (raw !== undefined) {
      if (typeof raw !== "boolean") {
        throw new Error("shared model vision_enabled must be a boolean");
      }
      result.vision_enabled = raw;
    }
  }
  return result;
}

export class ConfigCoordinator {
  /**
   * @param {object} deps
   * @param {string} deps.codiaHome
   * @param {string} deps.agentsDir
 * @param {() => object} deps.getAgent - 当前焦点 agent
    *
 * @param {() => string} deps.getActiveAgentId - 当前焦点 agent ID
  *
   * @param {() => import('./model-manager.ts').ModelManager} deps.getModels
   * @param {() => import('./preferences-manager.ts').PreferencesManager} deps.getPrefs
   * @param {() => import('./skill-manager.ts').SkillManager} deps.getSkills
 * @param {() => object|null} deps.getSession - 当前 session
   * @param {() => import('./session-coordinator.ts').SessionCoordinator|null} deps.getSessionCoordinator
   * @param {() => object|null} deps.getHub
   * @param {(event, sp) => void} deps.emitEvent
    *
   * @param {() => string|null} deps.getCurrentModel - currentModel name
   */
  constructor(deps) {
    this._d = deps;
  }

  // ── Home Folder ──

  /**
 * @param {string} [agentId] - 指定 agent；省略时查主 agent
 * @returns {string} 工作目录（保证返回有效路径）
   */
  getHomeFolder(agentId) {
    const explicit = this.getExplicitHomeFolder(agentId);
    if (explicit) return explicit;
    return resolveDefaultWorkspacePath();
  }

  getExplicitHomeFolder(agentId) {
    const targetId = agentId || this._getPrimaryAgentId();
    if (!targetId) return null;
    const agent = this._d.getAgentById(targetId);
    const status = classifyWorkspacePathForGc(agent?.config?.desk?.home_folder);
    if (status.status === "present" || status.status === "unknown") return status.path;
    if (status.status === "missing") {
      agent?.updateConfig?.({ desk: { home_folder: null } });
    }
    return null;
  }

  getLegacyHomeFolder(agentId) {
 // 1. 指定 agent 自己-config
    if (agentId) {
      const agent = this._d.getAgentById(agentId);
      const folder = agent?.config?.desk?.home_folder;
      if (folder) return folder;
    }

 //
    const primaryId = this._getPrimaryAgentId();
    if (primaryId && primaryId !== agentId) {
      const primary = this._d.getAgentById(primaryId);
      const folder = primary?.config?.desk?.home_folder;
      if (folder) return folder;
    }

    //
    return resolveDefaultWorkspacePath();
  }

  /**
   * @param {string} agentId
   * @param {string|null} folder
   */
  setHomeFolder(agentId, folder) {
    const agent = this._d.getAgentById(agentId);
    if (!agent) {
      log.warn(`setHomeFolder: agent ${agentId} not found`);
      return;
    }
    if (folder) {
      agent.updateConfig({ desk: { home_folder: folder } });
    } else {
 //
      agent.updateConfig({ desk: { home_folder: null } });
    }
    log.log(`setHomeFolder(${agentId}): ${folder || "(cleared)"}`);
  }

  // ── Shared Models ──

  gcWorkspaceConfig(agentId, options = {}) {
    const targetId = agentId || this._getPrimaryAgentId();
    if (!targetId) return { changed: false, patch: {} };
    const agent = this._d.getAgentById(targetId);
    if (!agent) return { changed: false, patch: {} };
    const result = pruneMissingWorkspaceConfig(agent.config || {}, options);
    if (result.changed) {
      agent.updateConfig(result.patch);
    }
    return result;
  }

  gcAllWorkspaceConfigs(options = {}) {
    const agents = this._d.getAgents?.();
    const ids = agents instanceof Map ? [...agents.keys()] : [];
    if (ids.length === 0) {
      return [this.gcWorkspaceConfig(undefined, options)];
    }
    return ids.map((id) => this.gcWorkspaceConfig(id, options));
  }

  getSharedModels() {
    const prefs = this._prefs();
    const result = {};
    for (const [field, prefKey] of SHARED_MODEL_KEYS) {
      const raw = prefs[prefKey];
      if (typeof raw === "object" && raw?.id) result[field] = raw;
      else if (raw) result[field] = raw;
      else result[field] = null;
    }
    result.vision_enabled = prefs[VISION_AUXILIARY_ENABLED_PREF_KEY] === true;
    return result;
  }

  setSharedModels(partial) {
    const normalized = normalizeSharedModelsPatch(partial);
    const prefs = this._prefs();
    const changed = [];
    let shouldSyncAgentRuntimeModels = false;
    for (const [field, prefKey] of SHARED_MODEL_KEYS) {
      if (hasOwn(normalized, field)) {
        if (normalized[field] !== null && normalized[field] !== "") prefs[prefKey] = normalized[field];
        else delete prefs[prefKey];
        const v = normalized[field];
        const repr = !v ? "(cleared)"
          : typeof v === "object" ? `${v.provider || "?"}/${v.id || "?"}`
          : String(v);
        changed.push(`${field}=${repr}`);
        if (field === "utility" || field === "utility_large") {
          shouldSyncAgentRuntimeModels = true;
        }
      }
    }
    if (hasOwn(normalized, "vision_enabled")) {
      if (normalized.vision_enabled) prefs[VISION_AUXILIARY_ENABLED_PREF_KEY] = true;
      else delete prefs[VISION_AUXILIARY_ENABLED_PREF_KEY];
      changed.push(`vision_enabled=${normalized.vision_enabled ? "on" : "off"}`);
    }
    this._savePrefs(prefs);
    if (shouldSyncAgentRuntimeModels) {
      const fresh = this.getSharedModels();
      this._syncSharedModelsToAgents(fresh);
    }
    if (changed.length) {
      log.log(`setSharedModels: ${changed.join(", ")}`);
    }
  }

  _syncSharedModelsToAgents(sharedModels) {
    const agents = this._d.getAgents?.();
    if (agents instanceof Map && agents.size) {
      for (const agent of agents.values()) {
        this._syncSharedModelsToAgent(agent, sharedModels);
      }
      return;
    }
    this._syncSharedModelsToAgent(this._d.getAgent?.(), sharedModels);
  }

  _syncSharedModelsToAgent(agent, sharedModels) {
    if (!agent) return;
    const chatModel = agent.config?.models?.chat || null;
    agent.setUtilityModel?.(sharedModels.utility || agent.config?.models?.utility || chatModel);
    agent.setMemoryModel?.(sharedModels.utility_large || agent.config?.models?.utility_large || chatModel);
  }

  // ── Search Config ──

  getSearchConfig() {
    const prefs = this._prefs();
    const provider = normalizeSearchProvider(prefs.search_provider) || AUTO_SEARCH_PROVIDER;
    const apiKeys = normalizeSearchApiKeys(prefs.search_api_keys);
    const legacyProvider = normalizeSearchProvider(prefs.search_provider);
    if (isSearchApiProvider(legacyProvider) && typeof prefs.search_api_key === "string" && prefs.search_api_key.trim()) {
      apiKeys[legacyProvider] = apiKeys[legacyProvider] || prefs.search_api_key.trim();
    }
    const apiKey = isSearchApiProvider(provider)
      ? apiKeys[provider] || (typeof prefs.search_api_key === "string" ? prefs.search_api_key.trim() : "") || null
      : null;
    return {
      provider,
      api_key: apiKey,
      api_keys: apiKeys,
    };
  }

  setSearchConfig(partial) {
    const prefs = this._prefs();
    const previousProvider = normalizeSearchProvider(prefs.search_provider);
    let apiKeys = normalizeSearchApiKeys(prefs.search_api_keys);
    if (isSearchApiProvider(previousProvider) && typeof prefs.search_api_key === "string" && prefs.search_api_key.trim()) {
      apiKeys[previousProvider] = apiKeys[previousProvider] || prefs.search_api_key.trim();
    }
    const nextProvider = partial.provider !== undefined
      ? normalizeSearchProvider(partial.provider)
      : previousProvider || AUTO_SEARCH_PROVIDER;

    if (partial.provider !== undefined) {
      if (nextProvider) prefs.search_provider = nextProvider;
      else delete prefs.search_provider;
    }
    if (partial.api_keys !== undefined) {
      apiKeys = mergeSearchApiKeys(apiKeys, partial.api_keys);
    }
    if (partial.api_key !== undefined) {
      if (isSearchApiProvider(nextProvider)) {
        const apiKey = typeof partial.api_key === "string" ? partial.api_key.trim() : "";
        if (apiKey) apiKeys[nextProvider] = apiKey;
        else delete apiKeys[nextProvider];
      }
    }
    if (Object.keys(apiKeys).length > 0) prefs.search_api_keys = apiKeys;
    else delete prefs.search_api_keys;

    if (isSearchApiProvider(nextProvider) && apiKeys[nextProvider]) {
      prefs.search_api_key = apiKeys[nextProvider];
    } else {
      delete prefs.search_api_key;
    }
    this._savePrefs(prefs);
    log.log(`setSearchConfig: provider=${nextProvider || "(cleared)"}`);
  }

  // ── Utility API ──

  getUtilityApi() {
    const prefs = this._prefs();
    return {
      provider: prefs.utility_api_provider || null,
      base_url: prefs.utility_api_base_url || null,
      api_key: prefs.utility_api_key || null,
    };
  }

  setUtilityApi(partial) {
    const prefs = this._prefs();
    for (const [key, prefKey] of [
      ["provider", "utility_api_provider"],
      ["base_url", "utility_api_base_url"],
      ["api_key", "utility_api_key"],
    ]) {
      if (partial[key] !== undefined) {
        if (partial[key]) prefs[prefKey] = partial[key];
        else delete prefs[prefKey];
      }
    }
    this._savePrefs(prefs);
    log.log(`setUtilityApi: provider=${partial.provider || "-"}, base_url=${partial.base_url || "-"}`);
  }

  resolveUtilityConfig(options = {}) {
    const { agentId } = options || {};
    const agent = agentId ? this._d.getAgentById?.(agentId) : this._d.getAgent();
    if (!agent) {
      throw new Error(`resolveUtilityConfig: agent ${agentId || "(focus)"} not found`);
    }
    const models = this._d.getModels();
    return models.resolveUtilityConfig(
      agent.config,
      this.getSharedModels(),
      this.getUtilityApi(),
    );
  }

  // ── Agent Order ──

  traceUtilityConfig(options = {}) {
    const { agentId } = options || {};
    const agent = agentId ? this._d.getAgentById?.(agentId) : this._d.getAgent();
    if (!agent) {
      throw new Error(`traceUtilityConfig: agent ${agentId || "(focus)"} not found`);
    }
    const models = this._d.getModels();
    return models.traceUtilityConfig(
      agent.config,
      this.getSharedModels(),
      this.getUtilityApi(),
    );
  }

  readAgentOrder() {
    return this._prefs().agentOrder || [];
  }

  saveAgentOrder(order) {
    const prefs = this._prefs();
    prefs.agentOrder = order;
    this._savePrefs(prefs);
  }

  // ── Model / Thinking ──

  async syncAndRefresh() {
    const models = this._d.getModels();
    const synced = await models.syncAndRefresh();
    this.normalizeUtilityApiPreferences();
    return synced;
  }

  /**
  * */
  setPendingModel(modelId, provider) {
    if (!modelId || !provider) {
      throw new Error(`setPendingModel: modelId and provider both required (got ${modelId}, ${provider})`);
    }
    const models = this._d.getModels();
    const model = findModel(models.availableModels, modelId, provider);
    if (!model) throw new Error(t("error.modelNotFound", { id: `${provider}/${modelId}` }));
    const sessionCoord = this._d.getSessionCoordinator();
    sessionCoord?.setPendingModel(model);
    return model;
  }

  /**
  * */
  async setDefaultModel(modelId, provider, { agentId } = {}) {
    if (!modelId || !provider) {
      throw new Error(`setDefaultModel: modelId and provider both required (got ${modelId}, ${provider})`);
    }
    const models = this._d.getModels();
    const model = findModel(models.availableModels, modelId, provider);
    if (!model) throw new Error(t("error.modelNotFound", { id: `${provider}/${modelId}` }));
    await this.updateConfig(
      { models: { chat: { id: modelId, provider } } },
      agentId ? { agentId } : {},
    );
    log.log(`default model set to: ${model.provider}/${model.id}${agentId ? ` agentId=${agentId}` : ""}`);
    return model;
  }

  setThinkingLevel(level) {
 //
    this._d.getPrefs().setThinkingLevel(level);
  }

 /** */
  getThinkingLevel() {
    return this._d.getPrefs().getThinkingLevel();
  }

  // ── Memory ──

  setMemoryEnabled(val) {
    this._d.getAgent().setMemoryEnabled(val);
    this.persistSessionMeta();
  }

  setMemoryMasterEnabled(agentId, val) {
    const ag = this._d.getAgents().get(agentId);
    if (ag) ag.setMemoryMasterEnabled(val);
  }

  persistSessionMeta(partial = null) {
    const session = this._d.getSession();
    const sessPath = session?.sessionManager?.getSessionFile?.();
    if (!sessPath) return;
    const agent = this._d.getAgent();
    const sessionCoord = this._d.getSessionCoordinator();
    return sessionCoord.writeSessionMeta(sessPath, partial || {
 //
    });
  }

  // ── updateConfig ──

  async updateConfig(partial, { agentId } = {}) {
    const keys = Object.keys(partial);
    if (keys.length) log.log(`updateConfig: keys=[${keys.join(",")}]${agentId ? ` agentId=${agentId}` : ""}`);

 //
    const agent = (agentId && this._d.getAgentById?.(agentId)) || this._d.getAgent();
    const models = this._d.getModels();
    const isFocusAgent = !agentId || agentId === this._d.getActiveAgentId?.();

 //
    agent.updateConfig(partial);

 // 模型切换只在焦点 agent 时生-
    if (isFocusAgent && partial.models?.chat) {
      const parsed = parseModelRef(partial.models.chat);
      if (!parsed?.id || !parsed?.provider) {
        log.warn(`updateConfig: models.chat 缺少 provider，已忽略 (got ${JSON.stringify(partial.models.chat)})`);
      } else {
        const newModel = findModel(models.availableModels, parsed.id, parsed.provider);
        if (newModel) {
          models.defaultModel = newModel;
          log.log(`default model updated to: ${newModel.provider}/${newModel.id}`);
        }
      }
    }

    if (partial.skills) {
      this._d.getSkills().syncAgentSkills(agent);
    }

 //
    if (partial.desk) {
      const scheduler = this._d.getHub()?.scheduler;
      const resolvedAgentId = agentId || this._d.getActiveAgentId?.();
      if ("heartbeat_interval" in partial.desk && scheduler) {
 //
        this._d.emitDevLog(`[heartbeat] interval updated: ${partial.desk.heartbeat_interval} minutes`);
        await scheduler.reloadHeartbeat(resolvedAgentId);
      } else if ("heartbeat_enabled" in partial.desk) {
        const hb = scheduler?.getHeartbeat(resolvedAgentId);
        if (hb) {
          if (partial.desk.heartbeat_enabled === false) {
            this._d.emitDevLog("[heartbeat] disabled");
            await hb.stop();
          } else if (this.getHeartbeatMaster() !== false) {
            this._d.emitDevLog("[heartbeat] enabled");
            hb.start();
          }
        }
      }
    }
  }

  normalizeUtilityApiPreferences(logFn = null) {
    const prefs = this._prefs();
    const hasOverride =
      !!prefs.utility_api_provider ||
      !!prefs.utility_api_base_url ||
      !!prefs.utility_api_key;
    if (!hasOverride) return false;

    const shared = this.getSharedModels();
    const utilityRef = shared.utility || this._d.getAgent()?.config?.models?.utility || null;
    const parsed = parseModelRef(utilityRef);
    const utilityEntry = (parsed?.id && parsed?.provider)
      ? findModel(this._d.getModels().availableModels, parsed.id, parsed.provider)
      : null;

    let reason = "";
    const utilityProviderEntry = prefs.utility_api_provider
      ? this._d.getModels().providerRegistry.get(prefs.utility_api_provider)
      : null;
    const canUseWithoutKey = allowsMissingApiKey({
      baseUrl: prefs.utility_api_base_url,
      authType: utilityProviderEntry?.authType,
    });
    if (!prefs.utility_api_provider || !prefs.utility_api_base_url || (!prefs.utility_api_key && !canUseWithoutKey)) {
      reason = "override incomplete";
    } else if (!utilityEntry?.provider) {
      reason = "utility model unavailable";
    } else if (prefs.utility_api_provider !== utilityEntry.provider) {
      reason = `provider mismatch (${prefs.utility_api_provider} != ${utilityEntry.provider})`;
    }

    if (!reason) return false;

    delete prefs.utility_api_provider;
    delete prefs.utility_api_base_url;
    delete prefs.utility_api_key;
    this._savePrefs(prefs);
    const logger = logFn || log.log.bind(log);
    logger(`[config] cleared invalid utility_api override: ${reason}`);
    return true;
  }

  // ── Channels Master ──

  getChannelsEnabled() {
    return this._d.getPrefs().getChannelsEnabled();
  }

  async setChannelsEnabled(enabled) {
    const next = !!enabled;
    const prefs = this._d.getPrefs();
    const prev = prefs.getChannelsEnabled();
    prefs.setChannelsEnabled(next);
    log.log(`setChannelsEnabled: ${next}`);

    if (prev === next) return;

    const hub = this._d.getHub();
    if (hub && typeof hub.toggleChannels === "function") {
      await hub.toggleChannels(next);
    }
  }

  // ── Heartbeat Master ──

  getHeartbeatMaster() {
    return this._prefs().heartbeat_master !== false;
  }

  setHeartbeatMaster(enabled) {
    const prefs = this._prefs();
    prefs.heartbeat_master = !!enabled;
    this._savePrefs(prefs);
    log.log(`setHeartbeatMaster: ${enabled}`);

 //
    const scheduler = this._d.getHub()?.scheduler;
    if (!scheduler) return;
    const agents = this._d.getAgents();
    for (const [, agent] of agents) {
      const hb = scheduler.getHeartbeat(agent.id);
      if (!hb) continue;
      if (!enabled) {
        hb.stop();
      } else if (agent.config?.desk?.heartbeat_enabled === true) {
        hb.start();
      }
    }
  }

  // ── helpers ──

  _getPrimaryAgentId() {
    const prefsManager = this._d.getPrefs();
    if (typeof prefsManager.getPrimaryAgent === 'function') {
      return prefsManager.getPrimaryAgent();
    }
    const prefs = this._prefs();
    return prefs.primaryAgent || null;
  }

  _prefs() { return this._d.getPrefs().getPreferences(); }
  _savePrefs(prefs) { return this._d.getPrefs().savePreferences(prefs); }
}
