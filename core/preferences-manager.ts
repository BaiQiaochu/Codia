// @ts-nocheck
/**
  *
 *
  * */
import fs from "fs";
import path from "path";
import { atomicWriteSync } from "../shared/safe-fs.ts";
import { normalizePublicBaseUrl } from "../shared/net-utils.ts";
import {
  approveComputerUseApp,
  normalizeComputerUseSettings,
  revokeComputerUseApp,
} from "./computer-use/settings.ts";
import {
  SESSION_PERMISSION_MODES,
  normalizeBridgePermissionMode,
  normalizeSessionPermissionMode,
} from "./session-permission-mode.ts";
import {
  getWorkspaceUiStateEntry,
  upsertWorkspaceUiState,
} from "../shared/workspace-ui-state.ts";
import { pruneMissingWorkspaceUiState } from "../shared/workspace-persistence-gc.ts";
import {
  mergeSidebarUiPrefs,
  normalizeSidebarUiPrefs,
} from "../shared/sidebar-ui-state.ts";
import { normalizeWorkspacePath } from "../shared/workspace-history.ts";
import { normalizeNetworkProxyConfig } from "../shared/network-proxy.ts";
import { mergeEditorTypography, normalizeEditorTypography } from "../shared/editor-typography.ts";
import { mergeChatLayout, normalizeChatLayout } from "../shared/chat-layout.ts";
import { normalizeSessionThinkingLevel } from "./session-thinking-level.ts";
import {
  mergeNotificationPreferences,
  normalizeNotificationPreferences,
} from "../shared/notification-preferences.ts";
import {
  mergeQuickChatPreferences,
  normalizeQuickChatPreferences,
} from "../shared/quick-chat-preferences.ts";
import {
  mergeBrowserPreferences,
  normalizeBrowserPreferences,
} from "../shared/browser-preferences.ts";

const RETIRED_EXPERIMENT_IDS = new Set([
  "memory.cache_snapshot_reflection",
]);

function stripRetiredExperimentValues(prefs) {
  const experiments = prefs?.experiments;
  if (!experiments || typeof experiments !== "object" || Array.isArray(experiments)) {
    return prefs;
  }
  let changed = false;
  const nextExperiments = { ...experiments };
  for (const id of RETIRED_EXPERIMENT_IDS) {
    if (Object.prototype.hasOwnProperty.call(nextExperiments, id) && nextExperiments[id] !== "off") {
      nextExperiments[id] = "off";
      changed = true;
    }
  }
  if (!changed) return prefs;
  return { ...prefs, experiments: nextExperiments };
}

function normalizedStringArray(value) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim())
    : [];
}

function normalizePluginUiPrefs(raw = {}) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  return {
    tabOrder: normalizedStringArray(source.tabOrder || source.pluginTabOrder),
    pinnedWidgets: normalizedStringArray(source.pinnedWidgets || source.pluginPinnedWidgets),
    hiddenTabs: normalizedStringArray(source.hiddenTabs || source.pluginHiddenTabs),
    hiddenWidgets: normalizedStringArray(source.hiddenWidgets || source.pluginHiddenWidgets),
  };
}

function mergePluginUiPrefs(current = {}, partial = {}) {
  const next = normalizePluginUiPrefs(current);
  if (Array.isArray(partial.tabOrder) || Array.isArray(partial.pluginTabOrder)) {
    next.tabOrder = normalizedStringArray(partial.tabOrder || partial.pluginTabOrder);
  }
  if (Array.isArray(partial.pinnedWidgets) || Array.isArray(partial.pluginPinnedWidgets)) {
    next.pinnedWidgets = normalizedStringArray(partial.pinnedWidgets || partial.pluginPinnedWidgets);
  }
  if (Array.isArray(partial.hiddenTabs) || Array.isArray(partial.pluginHiddenTabs)) {
    next.hiddenTabs = normalizedStringArray(partial.hiddenTabs || partial.pluginHiddenTabs);
  }
  if (Array.isArray(partial.hiddenWidgets) || Array.isArray(partial.pluginHiddenWidgets)) {
    next.hiddenWidgets = normalizedStringArray(partial.hiddenWidgets || partial.pluginHiddenWidgets);
  }
  return next;
}

export class PreferencesManager {
  /**
   * @param {object} opts
 * @param {string} opts.userDir - 用户数据目录（preferences.json 所在）
 * @param {string} opts.agentsDir - agents 根目录（findFirstAgent 用）
   */
  constructor({ userDir, agentsDir }) {
    this._userDir = userDir;
    this._agentsDir = agentsDir;
    this._path = path.join(userDir, "preferences.json");
    this._cache = this._readFromDisk();
    this._migrateRetiredExperiments();
    this._migrateLegacyDefaults();
    this.gcWorkspaceUiState();
  }

  _migrateRetiredExperiments() {
    const next = stripRetiredExperimentValues(this._cache);
    if (next === this._cache) return;
    this.savePreferences(next);
  }

  _migrateLegacyDefaults() {
    if (this._cache._defaultsRelaxedMigrated) return;
    const next = { ...this._cache };
    if (next.sandbox_network === false) delete next.sandbox_network;
    next._defaultsRelaxedMigrated = true;
    this.savePreferences(next);
  }

 /** */
  getPreferences() {
    return structuredClone(this._cache);
  }

 /** 写入全局 preferences（更新缓-+ 原子写磁盘） */
  savePreferences(prefs) {
    const next = this._preserveDiskSetupComplete(structuredClone(prefs));
    fs.mkdirSync(this._userDir, { recursive: true });
    atomicWriteSync(this._path, JSON.stringify(next, null, 2) + "\n");
    this._cache = this._readFromDiskStrict();
  }

 /** @private 从磁盘读取（仅构造时调用丢次） */
  _readFromDisk() {
    try {
      return this._readFromDiskStrict();
    } catch (err) {
      if (err.code === "ENOENT") return {};
      console.warn(`[preferences] failed to read ${this._path}: ${err.message}`);
      return {};
    }
  }

  _readFromDiskStrict() {
    return JSON.parse(fs.readFileSync(this._path, "utf-8"));
  }

  _preserveDiskSetupComplete(prefs) {
    if (prefs.setupComplete === true) return prefs;
    try {
      const stored = this._readFromDiskStrict();
      if (stored?.setupComplete === true) return { ...prefs, setupComplete: true, setupMode: stored.setupMode || 'ai' };
    } catch {}
    return prefs;
  }

 //
 //

 /** @private 获取可修改的浅拷贝（setter 专用-*/
  _mutableCopy() {
    return { ...this._cache };
  }

 /** 读取沙盒模式偏好 */
  getSandbox() {
    return this._cache.sandbox !== false;
  }

 /** 保存沙盒模式偏好 */
  setSandbox(enabled) {
    const prefs = this._mutableCopy();
    prefs.sandbox = typeof enabled === "string" ? enabled === "true" : !!enabled;
    this.savePreferences(prefs);
  }

  /** Read whether sandboxed commands may access the network. Default is on. */
  getSandboxNetwork() {
    return this._cache.sandbox_network !== false;
  }

  /** Save whether sandboxed commands may access the network. */
  setSandboxNetwork(enabled) {
    const prefs = this._mutableCopy();
    prefs.sandbox_network = typeof enabled === "string" ? enabled === "true" : !!enabled;
    this.savePreferences(prefs);
    return prefs.sandbox_network;
  }

  getNetworkProxy() {
    return normalizeNetworkProxyConfig(this._cache.network_proxy);
  }

  setNetworkProxy(config) {
    const normalized = normalizeNetworkProxyConfig(config, { strict: true });
    const prefs = this._mutableCopy();
    prefs.network_proxy = normalized;
    this.savePreferences(prefs);
    return normalized;
  }

  /** Read the default permission mode for newly created sessions. */
  getSessionPermissionModeDefault() {
    return normalizeSessionPermissionMode({ permissionMode: this._cache.session_permission_mode_default });
  }

  /** Save the default permission mode for newly created sessions. */
  setSessionPermissionModeDefault(mode) {
    const prefs = this._mutableCopy();
    prefs.session_permission_mode_default = normalizeSessionPermissionMode(mode);
    this.savePreferences(prefs);
    return prefs.session_permission_mode_default;
  }

 /** 读取文件备份配置 */
  getFileBackup() {
    const cfg = this._cache.file_backup;
    if (!cfg) return { enabled: false, retention_days: 1, max_file_size_kb: 1024 };
    return {
      enabled: !!cfg.enabled,
      retention_days: cfg.retention_days || 1,
      max_file_size_kb: cfg.max_file_size_kb || 1024,
    };
  }

 /** 合并写入文件备份配置 */
  setFileBackup(partial) {
    const prefs = this._mutableCopy();
    prefs.file_backup = { ...(prefs.file_backup || {}), ...partial };
    this.savePreferences(prefs);
  }

  getEditor() {
    return normalizeEditorTypography(this._cache.editor);
  }

  setEditor(editor) {
    const prefs = this._mutableCopy();
    prefs.editor = mergeEditorTypography(prefs.editor, editor);
    this.savePreferences(prefs);
    return prefs.editor;
  }

  getChat() {
    return normalizeChatLayout(this._cache.chat);
  }

  setChat(chat) {
    const prefs = this._mutableCopy();
    prefs.chat = mergeChatLayout(prefs.chat, chat);
    this.savePreferences(prefs);
    return prefs.chat;
  }

  /** Read a global experiment value. Unknown ids are validated by the experiment registry. */
  getExperimentValue(id) {
    const experiments = this._cache.experiments;
    if (!experiments || typeof experiments !== "object" || Array.isArray(experiments)) return undefined;
    return experiments[id];
  }

  /** Save a global experiment value without mixing registry definitions into preferences. */
  setExperimentValue(id, value) {
    const prefs = this._mutableCopy();
    const current = prefs.experiments && typeof prefs.experiments === "object" && !Array.isArray(prefs.experiments)
      ? prefs.experiments
      : {};
    prefs.experiments = { ...current, [id]: value };
    this.savePreferences(prefs);
  }

  /** Read the global channels master switch. Default is off. */
  getChannelsEnabled() {
    return this._cache.channels_enabled === true;
  }

  /** Save the global channels master switch. */
  setChannelsEnabled(enabled) {
    const prefs = this._mutableCopy();
    prefs.channels_enabled = !!enabled;
    this.savePreferences(prefs);
  }

  /** Read the global bridge permission mode. Defaults to automatic review. */
  getBridgePermissionMode() {
    return normalizeBridgePermissionMode(this._cache.bridge || {});
  }

  /** Save the global bridge permission mode and preserve legacy readOnly. */
  setBridgePermissionMode(mode) {
    const normalized = normalizeBridgePermissionMode({ permissionMode: mode });
    const prefs = this._mutableCopy();
    const bridge = { ...(prefs.bridge || {}) };
    bridge.permissionMode = normalized;
    if (normalized === SESSION_PERMISSION_MODES.READ_ONLY) bridge.readOnly = true;
    else delete bridge.readOnly;
    prefs.bridge = bridge;
    this.savePreferences(prefs);
    return normalized;
  }

  /** Read the global bridge read-only switch. Default is off. */
  getBridgeReadOnly() {
    return this.getBridgePermissionMode() === SESSION_PERMISSION_MODES.READ_ONLY;
  }

  /** Save the global bridge read-only switch. */
  setBridgeReadOnly(enabled) {
    const prefs = this._mutableCopy();
    const bridge = { ...(prefs.bridge || {}) };
    if (enabled) {
      bridge.readOnly = true;
      if (bridge.permissionMode === SESSION_PERMISSION_MODES.READ_ONLY) delete bridge.permissionMode;
    } else {
      delete bridge.readOnly;
      if (bridge.permissionMode === SESSION_PERMISSION_MODES.READ_ONLY) {
        bridge.permissionMode = SESSION_PERMISSION_MODES.AUTO;
      }
    }
    if (Object.keys(bridge).length === 0) delete prefs.bridge;
    else prefs.bridge = bridge;
    this.savePreferences(prefs);
  }

  /** Read the global bridge receipt switch. Default is on. */
  getBridgeReceiptEnabled() {
    return this._cache.bridge?.receiptEnabled !== false;
  }

  /** Save the global bridge receipt switch. */
  setBridgeReceiptEnabled(enabled) {
    const prefs = this._mutableCopy();
    const bridge = { ...(prefs.bridge || {}) };
    if (enabled === false) bridge.receiptEnabled = false;
    else delete bridge.receiptEnabled;
    if (Object.keys(bridge).length === 0) delete prefs.bridge;
    else prefs.bridge = bridge;
    this.savePreferences(prefs);
  }

  /** Read whether bridge replies should stream rich content. Default is on. */
  getBridgeRichStreamingEnabled() {
    return this._cache.bridge?.richStreamingEnabled !== false;
  }

  /** Save whether bridge replies should stream rich content. */
  setBridgeRichStreamingEnabled(enabled) {
    const prefs = this._mutableCopy();
    const bridge = { ...(prefs.bridge || {}) };
    if (enabled === false) bridge.richStreamingEnabled = false;
    else delete bridge.richStreamingEnabled;
    if (Object.keys(bridge).length === 0) delete prefs.bridge;
    else prefs.bridge = bridge;
    this.savePreferences(prefs);
  }

  /** Read the Bridge media public base URL. Empty means use environment fallback. */
  getBridgeMediaPublicBaseUrl() {
    return normalizeBridgeMediaPublicBaseUrl(this._cache.bridge?.mediaPublicBaseUrl || "");
  }

  /** Save the Bridge media public base URL. Empty clears the persisted setting. */
  setBridgeMediaPublicBaseUrl(value) {
    const normalized = normalizeBridgeMediaPublicBaseUrl(value);
    const prefs = this._mutableCopy();
    const bridge = { ...(prefs.bridge || {}) };
    if (normalized) bridge.mediaPublicBaseUrl = normalized;
    else delete bridge.mediaPublicBaseUrl;
    if (Object.keys(bridge).length === 0) delete prefs.bridge;
    else prefs.bridge = bridge;
    this.savePreferences(prefs);
    return normalized;
  }

  getSpeechRecognitionConfig() {
    const raw = this._cache.speechRecognition;
    const defaultModel = raw?.defaultModel && typeof raw.defaultModel === "object" && !Array.isArray(raw.defaultModel)
      ? {
        provider: typeof raw.defaultModel.provider === "string" ? raw.defaultModel.provider : "",
        id: typeof raw.defaultModel.id === "string" ? raw.defaultModel.id : "",
      }
      : null;
    return {
      enabled: raw?.enabled === true,
      ...(defaultModel?.provider && defaultModel?.id ? { defaultModel } : {}),
    };
  }

  setSpeechRecognitionConfig(config) {
    const prefs = this._mutableCopy();
    const next = {
      enabled: config?.enabled === true,
      ...(config?.defaultModel?.provider && config?.defaultModel?.id ? {
        defaultModel: {
          provider: String(config.defaultModel.provider),
          id: String(config.defaultModel.id),
        },
      } : {}),
    };
    prefs.speechRecognition = next;
    this.savePreferences(prefs);
    return this.getSpeechRecognitionConfig();
  }

  getImageGenerationConfig() {
    return normalizeImageGenerationConfig(this._cache.imageGeneration);
  }

  hasImageGenerationLegacyConfigMigrated() {
    return this._cache._imageGenerationLegacyConfigMigrated === true;
  }

  migrateImageGenerationConfigFromLegacy(legacyConfig) {
    if (this.hasImageGenerationLegacyConfigMigrated()) {
      return this.getImageGenerationConfig();
    }
    const prefs = this._mutableCopy();
    prefs.imageGeneration = mergeImageGenerationConfig(
      normalizeImageGenerationConfig(legacyConfig),
      normalizeImageGenerationConfig(prefs.imageGeneration),
    );
    prefs._imageGenerationLegacyConfigMigrated = true;
    this.savePreferences(prefs);
    return this.getImageGenerationConfig();
  }

  setImageGenerationConfig(config) {
    const prefs = this._mutableCopy();
    prefs.imageGeneration = normalizeImageGenerationConfig(config);
    this.savePreferences(prefs);
    return this.getImageGenerationConfig();
  }

  getVideoGenerationConfig() {
    return normalizeVideoGenerationConfig(this._cache.videoGeneration);
  }

  setVideoGenerationConfig(config) {
    const prefs = this._mutableCopy();
    prefs.videoGeneration = normalizeVideoGenerationConfig(config);
    this.savePreferences(prefs);
    return this.getVideoGenerationConfig();
  }

  getQuickChatPreferences() {
    return normalizeQuickChatPreferences(this._cache.quick_chat || {});
  }

  setQuickChatPreferences(partial) {
    const prefs = this._mutableCopy();
    prefs.quick_chat = mergeQuickChatPreferences(prefs.quick_chat || {}, partial || {});
    this.savePreferences(prefs);
    return this.getQuickChatPreferences();
  }

  getNotificationPreferences() {
    return normalizeNotificationPreferences(this._cache.notifications || {});
  }

  setNotificationPreferences(partial) {
    const prefs = this._mutableCopy();
    prefs.notifications = mergeNotificationPreferences(prefs.notifications || {}, partial || {});
    this.savePreferences(prefs);
    return this.getNotificationPreferences();
  }

  getBrowserPreferences() {
    return normalizeBrowserPreferences(this._cache.browser || {});
  }

  setBrowserPreferences(partial) {
    const prefs = this._mutableCopy();
    prefs.browser = mergeBrowserPreferences(prefs.browser || {}, partial || {});
    this.savePreferences(prefs);
    return prefs.browser;
  }

  /** Read global Computer Use provider, platform and approval settings. */
  getComputerUseSettings() {
    return normalizeComputerUseSettings(this._cache.computer_use || {});
  }

  /** Merge and save global Computer Use settings. */
  setComputerUseSettings(partial) {
    const prefs = this._mutableCopy();
    prefs.computer_use = normalizeComputerUseSettings({
      ...(prefs.computer_use || {}),
      ...(partial || {}),
    });
    this.savePreferences(prefs);
    return prefs.computer_use;
  }

  /** Approve a Computer Use app/window scope. */
  approveComputerUseApp(approval) {
    const prefs = this._mutableCopy();
    prefs.computer_use = approveComputerUseApp(prefs.computer_use || {}, approval);
    this.savePreferences(prefs);
    return prefs.computer_use;
  }

  /** Revoke a Computer Use app/window scope. */
  revokeComputerUseApp(approval) {
    const prefs = this._mutableCopy();
    prefs.computer_use = revokeComputerUseApp(prefs.computer_use || {}, approval);
    this.savePreferences(prefs);
    return prefs.computer_use;
  }

 /** 读取自学抢能配置（全局，跨 agent-*/
  getLearnSkills() {
    const cfg = this._cache.learn_skills;
    if (!cfg) return { enabled: true, safety_review: true };
    return cfg;
  }

 /** 合并写入自学抢能配-*/
  setLearnSkills(partial) {
    const prefs = this._mutableCopy();
    prefs.learn_skills = { ...(prefs.learn_skills || {}), ...partial };
    this.savePreferences(prefs);
  }

 /** */
  getLocale() {
    return this._cache.locale || "system";
  }

 /** 保存语言偏好 */
  getSetupComplete() {
    return this._cache.setupComplete === true;
  }

  getSetupMode() { return this._cache.setupMode === 'files-only' ? 'files-only' : 'ai'; }

  markSetupComplete(mode = 'ai') {
    if (!['ai', 'files-only'].includes(mode)) throw new Error('invalid setup mode');
    const prefs = this._mutableCopy();
    prefs.setupComplete = true;
    prefs.setupMode = mode;
    this.savePreferences(prefs);
    if (!this.getSetupComplete()) {
      throw new Error("setupComplete read-back verification failed");
    }
    return { setupComplete: true, setupMode: this.getSetupMode() };
  }

  setLocale(locale) {
    const prefs = this._mutableCopy();
    prefs.locale = locale || "";
    this.savePreferences(prefs);
  }

  /** Read appearance preferences shared by desktop and PWA surfaces. */
  getAppearance() {
    return normalizeAppearance(this._cache.appearance || {});
  }

  /** Merge appearance preferences without dropping previously synced fields. */
  setAppearance(partial) {
    const prefs = this._mutableCopy();
    prefs.appearance = normalizeAppearance({
      ...(prefs.appearance || {}),
      ...(partial || {}),
    });
    this.savePreferences(prefs);
    return prefs.appearance;
  }

  /** Read persisted UI state for a workspace root. */
  getWorkspaceUiState(workspaceRoot, surface) {
    const workspace = normalizeWorkspacePath(workspaceRoot);
    if (!workspace) return null;
    this.gcWorkspaceUiState();
    return getWorkspaceUiStateEntry(this._cache.workspace_ui_state || {}, workspace, { surface });
  }

  /** Persist UI state for a workspace root. */
  setWorkspaceUiState(workspaceRoot, surface, entry) {
    const workspace = normalizeWorkspacePath(workspaceRoot);
    if (!workspace) return null;
    const prefs = this._mutableCopy();
    prefs.workspace_ui_state = upsertWorkspaceUiState(
      prefs.workspace_ui_state || {},
      workspace,
      entry,
      { surface },
    );
    this.savePreferences(prefs);
    return getWorkspaceUiStateEntry(prefs.workspace_ui_state, workspace, { surface });
  }

 /** */
  /** Read sidebar UI preferences shared by the desktop session list. */
  gcWorkspaceUiState(options = {}) {
    const prefs = this._mutableCopy();
    const { state, changed } = pruneMissingWorkspaceUiState(prefs.workspace_ui_state || {}, options);
    if (changed || prefs.workspace_ui_state) {
      prefs.workspace_ui_state = state;
    }
    if (changed) this.savePreferences(prefs);
    return state;
  }

  getSidebarUiPrefs() {
    return normalizeSidebarUiPrefs(this._cache.sidebar_ui || {});
  }

  /** Merge sidebar UI preferences without dropping other sidebar fields. */
  setSidebarUiPrefs(partial) {
    const prefs = this._mutableCopy();
    prefs.sidebar_ui = mergeSidebarUiPrefs(prefs.sidebar_ui || {}, partial || {});
    this.savePreferences(prefs);
    return this.getSidebarUiPrefs();
  }

  getPluginUiPrefs() {
    return normalizePluginUiPrefs(this._cache.plugin_ui || {});
  }

  setPluginUiPrefs(partial) {
    const prefs = this._mutableCopy();
    prefs.plugin_ui = mergePluginUiPrefs(prefs.plugin_ui || {}, partial || {});
    this.savePreferences(prefs);
    return this.getPluginUiPrefs();
  }

  getTimezone() {
    return this._cache.timezone || "";
  }

 /** 保存时区偏好 */
  setTimezone(tz) {
    const prefs = this._mutableCopy();
    prefs.timezone = tz || "";
    this.savePreferences(prefs);
  }

 /** */
  getThinkingLevel() {
    return normalizeSessionThinkingLevel(this._cache.thinking_level);
  }

  /** 保存 thinking level 偏好 */
  setThinkingLevel(level) {
    const prefs = this._mutableCopy();
    prefs.thinking_level = normalizeSessionThinkingLevel(level);
    this.savePreferences(prefs);
  }

 /** */
  getExternalSkillPaths() {
    return this._cache.external_skill_paths || [];
  }

 /** */
  setExternalSkillPaths(paths) {
    const prefs = this._mutableCopy();
    prefs.external_skill_paths = paths;
    this.savePreferences(prefs);
  }

 /** 读取 OAuth 自定义模-{ provider: ["model-id", ...] }
  *
    * */
  getOAuthCustomModels() {
    const src = this._cache.oauth_custom_models;
    if (!src) return {};
    const copy = {};
    for (const [k, v] of Object.entries(src)) {
      copy[k] = Array.isArray(v) ? [...v] : v;
    }
    return copy;
  }

 /** 设置某个 OAuth provider 的自定义模型列表 */
  setOAuthCustomModels(provider, modelIds) {
    const prefs = this._mutableCopy();
    if (!prefs.oauth_custom_models) prefs.oauth_custom_models = {};
    if (modelIds.length === 0) {
      delete prefs.oauth_custom_models[provider];
    } else {
      prefs.oauth_custom_models[provider] = modelIds;
    }
    this.savePreferences(prefs);
  }

 /** 读取网页接入 key 配置 */
  getWebAccess() {
    const cfg = this._cache.web_access || {};
    return {
      enabled: !!cfg.enabled && !!cfg.api_key,
      api_key: cfg.api_key || "",
      created_at: cfg.created_at || null,
      external_enabled: !!cfg.external_enabled,
      public_base_url: normalizePublicBaseUrl(cfg.public_base_url || ""),
    };
  }

  /** 保存网页接入 key 配置 */
  setWebAccess({ api_key, created_at = new Date().toISOString(), enabled = true, external_enabled, public_base_url }) {
    const prefs = this._mutableCopy();
    const previous = prefs.web_access || {};
    prefs.web_access = {
      enabled: !!enabled && !!api_key,
      api_key: api_key || "",
      created_at: api_key ? created_at : null,
      external_enabled: external_enabled === undefined ? !!previous.external_enabled : !!external_enabled,
      public_base_url: normalizePublicBaseUrl(
        public_base_url === undefined ? previous.public_base_url || "" : public_base_url,
      ),
    };
    this.savePreferences(prefs);
  }

  /** 清空网页接入 key 配置 */
  clearWebAccess() {
    const prefs = this._mutableCopy();
    delete prefs.web_access;
    this.savePreferences(prefs);
  }

 /** 读取是否允许 full-access 社区插件运行 */
  getAllowFullAccessPlugins() {
    return this._cache.allow_full_access_plugins || false;
  }

 /** 保存是否允许 full-access 社区插件运行 */
  setAllowFullAccessPlugins(value) {
    const prefs = this._mutableCopy();
    prefs.allow_full_access_plugins = !!value;
    this.savePreferences(prefs);
  }

  /** Read whether Agent-visible plugin development tools are enabled. */
  getPluginDevToolsEnabled() {
    return this._cache.plugin_dev_tools?.enabled === true;
  }

  /** Save whether Agent-visible plugin development tools are enabled. */
  setPluginDevToolsEnabled(value) {
    const prefs = this._mutableCopy();
    prefs.plugin_dev_tools = {
      ...(prefs.plugin_dev_tools || {}),
      enabled: value === true,
    };
    this.savePreferences(prefs);
    return prefs.plugin_dev_tools.enabled;
  }

 /** */
  getDisabledPlugins() {
    return this._cache.disabled_plugins || [];
  }

 /** */
  setDisabledPlugins(list) {
    const prefs = this._mutableCopy();
    prefs.disabled_plugins = Array.isArray(list) ? list : [];
    this.savePreferences(prefs);
  }

 /** */
  getUpdateChannel() {
    return this._cache.update_channel || "stable";
  }

 /** 保存更新通道偏好 */
  setUpdateChannel(channel) {
    const prefs = this._mutableCopy();
    prefs.update_channel = channel === "beta" ? "beta" : "stable";
    this.savePreferences(prefs);
  }

  /** Read the automatic update-check preference. Default is on. */
  getAutoCheckUpdates() {
    return this._cache.auto_check_updates !== false;
  }

  /** Save the automatic update-check preference. */
  setAutoCheckUpdates(value) {
    const prefs = this._mutableCopy();
    prefs.auto_check_updates = value !== false;
    this.savePreferences(prefs);
  }

  /** Read the desktop hardware acceleration preference. Default is on. */
  getHardwareAcceleration() {
    return this._cache.hardware_acceleration !== false;
  }

  /** Save the desktop hardware acceleration preference. Takes effect after restart. */
  setHardwareAcceleration(value) {
    const prefs = this._mutableCopy();
    prefs.hardware_acceleration = normalizeBooleanPreference(value, true);
    this.savePreferences(prefs);
  }

 /** 读取 primary agent ID */
  getPrimaryAgent() {
    return this._cache.primaryAgent || null;
  }

  /** 保存 primary agent ID */
  savePrimaryAgent(agentId) {
    const prefs = this._mutableCopy();
    prefs.primaryAgent = agentId;
    this.savePreferences(prefs);
  }

  /**
 * 找到 agents/ 目录下第丢个合法的 agent
   * @returns {string|null}
   */
  findFirstAgent() {
    try {
      const entries = fs.readdirSync(this._agentsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (fs.existsSync(path.join(this._agentsDir, entry.name, "config.yaml"))) {
          return entry.name;
        }
      }
    } catch {}
    return null;
  }
}

function normalizeBridgeMediaPublicBaseUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("bridge media public base URL must be a valid URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("bridge media public base URL must use http or https");
  }
  if (parsed.search || parsed.hash) {
    throw new Error("bridge media public base URL must not include query or hash");
  }
  return raw.replace(/\/+$/, "");
}

function normalizeAppearance(value) {
  const src = value && typeof value === "object" ? value : {};
  const out = {};
  if (typeof src.theme === "string" && src.theme.trim()) out.theme = src.theme.trim();
  if (typeof src.serif === "boolean") out.serif = src.serif;
  if (typeof src.paperTexture === "boolean") out.paperTexture = src.paperTexture;
  if (typeof src.leavesOverlay === "boolean") out.leavesOverlay = src.leavesOverlay;
  return out;
}

function normalizeBooleanPreference(value, fallback) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return fallback;
}

export function normalizeImageGenerationConfig(value) {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const defaultModel = raw.defaultImageModel && typeof raw.defaultImageModel === "object" && !Array.isArray(raw.defaultImageModel)
    ? {
      provider: typeof raw.defaultImageModel.provider === "string" ? raw.defaultImageModel.provider.trim() : "",
      id: typeof raw.defaultImageModel.id === "string" ? raw.defaultImageModel.id.trim() : "",
    }
    : null;
  const providerDefaults = raw.providerDefaults && typeof raw.providerDefaults === "object" && !Array.isArray(raw.providerDefaults)
    ? structuredClone(raw.providerDefaults)
    : null;
  return {
    ...(defaultModel?.provider && defaultModel.id ? { defaultImageModel: defaultModel } : {}),
    ...(providerDefaults ? { providerDefaults } : {}),
  };
}

export function normalizeVideoGenerationConfig(value) {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const defaultModel = raw.defaultVideoModel && typeof raw.defaultVideoModel === "object" && !Array.isArray(raw.defaultVideoModel)
    ? {
      provider: typeof raw.defaultVideoModel.provider === "string" ? raw.defaultVideoModel.provider.trim() : "",
      id: typeof raw.defaultVideoModel.id === "string" ? raw.defaultVideoModel.id.trim() : "",
    }
    : null;
  const providerDefaults = raw.providerDefaults && typeof raw.providerDefaults === "object" && !Array.isArray(raw.providerDefaults)
    ? structuredClone(raw.providerDefaults)
    : null;
  return {
    ...(defaultModel?.provider && defaultModel.id ? { defaultVideoModel: defaultModel } : {}),
    ...(providerDefaults ? { providerDefaults } : {}),
  };
}

export function mergeImageGenerationConfig(base, override) {
  const left = normalizeImageGenerationConfig(base);
  const right = normalizeImageGenerationConfig(override);
  const next: any = {};
  const defaultModel = right.defaultImageModel || left.defaultImageModel || null;
  if (defaultModel) next.defaultImageModel = defaultModel;
  const providerDefaults = mergeProviderDefaults(left.providerDefaults, right.providerDefaults);
  if (providerDefaults) next.providerDefaults = providerDefaults;
  return next;
}

function mergeProviderDefaults(base, override) {
  const left = base && typeof base === "object" && !Array.isArray(base) ? base : {};
  const right = override && typeof override === "object" && !Array.isArray(override) ? override : {};
  const providerIds = new Set([...Object.keys(left), ...Object.keys(right)]);
  if (providerIds.size === 0) return null;
  const next = {};
  for (const providerId of providerIds) {
    const baseValue = left[providerId];
    const overrideValue = right[providerId];
    if (
      baseValue && typeof baseValue === "object" && !Array.isArray(baseValue)
      && overrideValue && typeof overrideValue === "object" && !Array.isArray(overrideValue)
    ) {
      next[providerId] = { ...structuredClone(baseValue), ...structuredClone(overrideValue) };
    } else if (overrideValue !== undefined) {
      next[providerId] = structuredClone(overrideValue);
    } else {
      next[providerId] = structuredClone(baseValue);
    }
  }
  return next;
}
