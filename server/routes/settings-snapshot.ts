import fs from "fs/promises";
import path from "path";
import YAML from "js-yaml";
import { Hono } from "hono";
import { injectGlobalFields } from "../../shared/config-scope.ts";
import { computeSettingsAvailableToolNames } from "../../shared/tool-categories.ts";
import { readPinnedMemoryItems } from "../../lib/memory/pinned-memory-store.ts";
import { listExperienceDocuments } from "../../lib/tools/experience.ts";
import { createAccessSummary, getLanAddresses } from "./access.ts";
import { buildComputerUsePreferences } from "./preferences.ts";
import { normalizeNotificationPreferences } from "../../shared/notification-preferences.ts";
import { normalizeQuickChatPreferences } from "../../shared/quick-chat-preferences.ts";
import { normalizeBrowserPreferences } from "../../shared/browser-preferences.ts";
import { normalizeSearchApiKeys, SEARCH_API_PROVIDER_IDS } from "../../shared/search-providers.ts";
import { maskObjectSecrets, maskSecretValue } from "../../shared/secret-custody.ts";
import { listResolvedExperiments } from "../../lib/experiments/registry.ts";
import { normalizeBridgePermissionMode } from "../../core/session-permission-mode.ts";
import { agentExists, validateId } from "../utils/validation.ts";
import { readAuthPrincipal } from "../http/capability-guard.ts";
import { isLocalOwnerPrincipal } from "../http/route-security.ts";

type UnknownRecord = Record<string, unknown>;
type AgentLike = UnknownRecord & {
  id?: string;
  config?: UnknownRecord & { bridge?: UnknownRecord };
  experienceEnabled?: boolean;
  tools?: { name?: string }[];
};
type EngineLike = UnknownRecord & {
  agentsDir: string;
  currentAgentId?: string;
  getAgent?: (id: string) => AgentLike | null | undefined;
  getAutomationPermissionMode?: () => unknown;
  getBridgePermissionMode?: () => unknown;
  getBridgeReadOnly?: () => unknown;
  getBridgeReceiptEnabled?: () => unknown;
  getBridgeRichStreamingEnabled?: () => unknown;
  getBrowserPreferences?: () => unknown;
  getComputerUseSettings?: () => { enabled?: boolean } | null | undefined;
  getHeartbeatMaster?: () => unknown;
  getKeepAwake?: () => unknown;
  getNotificationPreferences?: () => unknown;
  getPluginDevToolsEnabled?: () => unknown;
  getPrimaryAgent?: () => string | null | undefined;
  getQuickChatPreferences?: () => unknown;
  getSearchConfig?: () => UnknownRecord | null | undefined;
  getSharedModels?: () => unknown;
  getSpeechRecognitionConfig?: () => unknown;
  getThinkingLevel?: () => unknown;
  getUtilityApi?: () => UnknownRecord | null | undefined;
  listAgents?: () => { id?: string }[];
  pluginManager?: UnknownRecord & {
    getAllTools?: () => { name?: string }[];
    getAllowFullAccess?: () => boolean;
    getSettingsTabs?: () => {
      icon?: string;
      id?: string;
      nativeComponent?: string;
      pluginId?: string;
      title?: string;
    }[];
    getUserPluginsDir?: () => string;
  };
  preferences?: unknown;
  providerRegistry?: {
    get: (name: string) => { api?: string; baseUrl?: string } | null | undefined;
    getAllProvidersRaw: () => Record<string, UnknownRecord>;
  };
  speechRecognition?: { getConfig?: () => unknown };
  userDir: string;
};
type BridgeManagerLike = { getStatus?: () => Record<string, UnknownRecord> };
type BridgeManagerRefLike = BridgeManagerLike | { get?: () => BridgeManagerLike | null | undefined } | null | undefined;
type SettingsSnapshotOptions = UnknownRecord & {
  bridgeManagerRef?: BridgeManagerRefLike;
  listLanAddresses?: typeof getLanAddresses;
  platform?: NodeJS.Platform;
  runtimeState?: unknown;
};

function errorMessage(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}

function agentDir(engine: EngineLike, id: string) {
  return path.join(engine.agentsDir, id);
}

function hideDisabledGlobalToolsForSettings(toolNames: string[], engine: EngineLike) {
  const computerUseEnabled = engine?.getComputerUseSettings?.()?.enabled === true;
  if (computerUseEnabled) return toolNames;
  return (toolNames || []).filter((name) => name !== "computer");
}

function normalizeExperienceConfigForResponse(config: UnknownRecord) {
  const current = isObject(config.experience) ? config.experience : {};
  config.experience = {
    ...current,
    enabled: current.enabled === true,
  };
}

async function readTextFile(filePath: string) {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch (err: unknown) {
    if (isObjectWithCode(err, "ENOENT")) return "";
    throw err;
  }
}

function readPinned(agentBaseDir: string) {
  return readPinnedMemoryItems(agentBaseDir).map((item) => item.content);
}

function isObject(value: unknown): value is UnknownRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isObjectWithCode(value: unknown, code: string) {
  return isObject(value) && value.code === code;
}

function isExperienceEnabled(engine: EngineLike, id: string, config: UnknownRecord) {
  const agent = typeof engine.getAgent === "function" ? engine.getAgent(id) : null;
  if (typeof agent?.experienceEnabled === "boolean") return agent.experienceEnabled === true;
  return isObject(config.experience) && config.experience.enabled === true;
}

function readExperience(engine: EngineLike, id: string, config: UnknownRecord) {
  if (!isExperienceEnabled(engine, id, config)) return "";
  try {
    const expDir = path.join(agentDir(engine, id), "experience");
    const docs = listExperienceDocuments(expDir).sort((a, b) => a.title.localeCompare(b.title));
    if (docs.length === 0) return "";
    return docs.map((doc) => `# ${doc.title}\n${doc.body.trimEnd()}`).join("\n\n") + "\n";
  } catch (err: unknown) {
    if (isObjectWithCode(err, "ENOENT")) return "";
    throw err;
  }
}

function maskSearchApiKeys(apiKeys: unknown) {
  const normalized = normalizeSearchApiKeys(apiKeys);
  return Object.fromEntries(
    SEARCH_API_PROVIDER_IDS.map((provider: string) => [provider, maskSecretValue(normalized[provider] || "")]),
  );
}

function buildGlobalModels(engine: EngineLike) {
  const search = engine.getSearchConfig?.() || {};
  const utilityApi = engine.getUtilityApi?.() || {};
  return {
    models: engine.getSharedModels?.() || {},
    thinking_level: engine.getThinkingLevel?.() || "medium",
    search: {
      provider: search.provider || "",
      api_key: maskSecretValue(search.api_key || ""),
      api_keys: maskSearchApiKeys(search.api_keys || {}),
    },
    utility_api: {
      provider: utilityApi.provider || "",
      base_url: utilityApi.base_url || "",
      api_key: maskSecretValue(utilityApi.api_key || ""),
    },
  };
}

function addProviderSummary(config: UnknownRecord, engine: EngineLike) {
  try {
    const rawProviders = engine.providerRegistry?.getAllProvidersRaw?.() || {};
    const providerEntries: Record<string, unknown> = {};
    for (const [name, p] of Object.entries(rawProviders)) {
      const entry = engine.providerRegistry?.get?.(name);
      providerEntries[name] = {
        base_url: p.base_url || entry?.baseUrl || "",
        api: p.api || entry?.api || "",
        api_key: maskSecretValue(p.api_key || ""),
        models: Array.isArray(p.models) ? p.models : [],
        model_count: Array.isArray(p.models) ? p.models.length : 0,
      };
    }
    config.providers = providerEntries;
  } catch {
    config.providers = {};
  }
}

function addAvailableTools(config: UnknownRecord, engine: EngineLike, id: string) {
  const agent = engine.getAgent?.(id);
  const pluginTools = (engine.pluginManager?.getAllTools?.() || [])
    .map((tool) => ({ _pluginId: typeof tool.name === "string" ? tool.name : undefined }));
  const runtimeToolNames = (agent?.tools || [])
    .map((tool) => tool.name)
    .filter(Boolean);
  config.availableTools = hideDisabledGlobalToolsForSettings(
    computeSettingsAvailableToolNames(runtimeToolNames, { pluginTools }),
    engine,
  );
}

function addRuntimeGlobalFields(config: UnknownRecord, engine: EngineLike) {
  if (typeof engine.getKeepAwake === "function") {
    config.keep_awake = engine.getKeepAwake();
  }
  if (typeof engine.getHeartbeatMaster === "function") {
    const desk = isObject(config.desk) ? config.desk : {};
    config.desk = desk;
    desk.heartbeat_master = engine.getHeartbeatMaster();
  }
  if (typeof engine.getAutomationPermissionMode === "function") {
    const automation = isObject(config.automation) ? config.automation : {};
    config.automation = automation;
    automation.permission_mode = engine.getAutomationPermissionMode();
  }
}

async function buildAgentConfig(engine: EngineLike, id: string): Promise<UnknownRecord> {
  const configPath = path.join(agentDir(engine, id), "config.yaml");
  const config = (YAML.load(await fs.readFile(configPath, "utf-8")) as UnknownRecord | null) || {};
  normalizeExperienceConfigForResponse(config);
  const api = isObject(config.api) ? config.api : {};
  const embeddingApi = isObject(config.embedding_api) ? config.embedding_api : {};
  const utilityApi = isObject(config.utility_api) ? config.utility_api : {};
  config._raw = {
    api: { provider: api.provider || "", base_url: api.base_url || "" },
    embedding_api: { provider: embeddingApi.provider || "", base_url: embeddingApi.base_url || "" },
    utility_api: { provider: utilityApi.provider || "", base_url: utilityApi.base_url || "" },
  };
  injectGlobalFields(config, engine);
  addRuntimeGlobalFields(config, engine);
  addProviderSummary(config, engine);
  addAvailableTools(config, engine, id);
  return maskObjectSecrets(config) as UnknownRecord;
}

function resolveSnapshotAgentId(engine: EngineLike, rawAgentId: string | undefined) {
  const id = rawAgentId || engine.currentAgentId || engine.getPrimaryAgent?.() || engine.listAgents?.()[0]?.id;
  if (!id || !validateId(id) || !agentExists(engine, id)) {
    throw new Error("settings snapshot agent not found");
  }
  return id;
}

function buildPluginSettings(engine: EngineLike, canSeeLocalPaths: boolean) {
  const pm = engine.pluginManager;
  return {
    allowFullAccess: pm?.getAllowFullAccess?.() || false,
    devToolsEnabled: engine.getPluginDevToolsEnabled?.() || false,
    userDir: canSeeLocalPaths ? (pm?.getUserPluginsDir?.() || "") : "",
    settingsTabs: pm?.getSettingsTabs?.().map((tab) => ({
      pluginId: tab.pluginId,
      id: tab.id,
      title: tab.title,
      icon: tab.icon,
      nativeComponent: tab.nativeComponent,
    })) || [],
  };
}

function buildBridgePreferences(engine: EngineLike) {
  const permissionMode = engine.getBridgePermissionMode?.()
    || normalizeBridgePermissionMode({ readOnly: engine.getBridgeReadOnly?.() === true });
  return {
    permissionMode,
    readOnly: engine.getBridgeReadOnly?.() === true,
    receiptEnabled: engine.getBridgeReceiptEnabled?.() !== false,
    richStreamingEnabled: engine.getBridgeRichStreamingEnabled?.() !== false,
  };
}

function resolveBridgeManager(ref: BridgeManagerRefLike): BridgeManagerLike | null {
  if (!ref) return null;
  const maybeRef = ref as { get?: unknown };
  if (typeof maybeRef.get === "function") return maybeRef.get() as BridgeManagerLike || null;
  return ref as BridgeManagerLike;
}

function platformStatus(platform: string, agent: AgentLike | null | undefined, live: Record<string, UnknownRecord>, extra: UnknownRecord) {
  const liveStatus = live?.[platform] || {};
  return {
    enabled: extra.enabled === true,
    configured: extra.configured === true,
    status: liveStatus.status || (extra.configured ? "disconnected" : "not_configured"),
    error: liveStatus.error || null,
    agentId: agent?.id || null,
    ...extra,
  };
}

function buildBridgeStatus(engine: EngineLike, bridgeManager: BridgeManagerLike | null, agent: AgentLike) {
  const bridge = isObject(agent?.config?.bridge) ? agent.config.bridge : {};
  const live = bridgeManager?.getStatus?.() || {};
  const permission = buildBridgePreferences(engine);
  const telegram = isObject(bridge.telegram) ? bridge.telegram : {};
  const feishu = isObject(bridge.feishu) ? bridge.feishu : {};
  const whatsapp = isObject(bridge.whatsapp) ? bridge.whatsapp : {};
  const qq = isObject(bridge.qq) ? bridge.qq : {};
  const wechat = isObject(bridge.wechat) ? bridge.wechat : {};
  return {
    agentId: agent?.id || null,
    telegram: platformStatus("telegram", agent, live, {
      enabled: telegram.enabled === true,
      configured: !!telegram.token,
      token: maskSecretValue(String(telegram.token || "")),
    }),
    feishu: platformStatus("feishu", agent, live, {
      enabled: feishu.enabled === true,
      configured: !!(feishu.appId && feishu.appSecret),
      appId: feishu.appId || "",
      appSecret: maskSecretValue(String(feishu.appSecret || "")),
    }),
    whatsapp: platformStatus("whatsapp", agent, live, {
      enabled: whatsapp.enabled === true,
      configured: whatsapp.enabled === true,
    }),
    qq: platformStatus("qq", agent, live, {
      enabled: qq.enabled === true,
      configured: !!(qq.appID && (qq.appSecret || qq.token)),
      appID: qq.appID || "",
      appSecret: maskSecretValue(String(qq.appSecret || qq.token || "")),
    }),
    wechat: platformStatus("wechat", agent, live, {
      enabled: wechat.enabled === true,
      configured: !!wechat.botToken,
      token: maskSecretValue(String(wechat.botToken || "")),
    }),
    permissionMode: permission.permissionMode,
    readOnly: permission.readOnly,
    receiptEnabled: permission.receiptEnabled,
    richStreamingEnabled: permission.richStreamingEnabled,
  };
}

function buildAccessSnapshot(engine: EngineLike, canSeeLocalPaths: boolean, options: SettingsSnapshotOptions) {
  if (!canSeeLocalPaths || !engine?.codiaHome) return null;
  return createAccessSummary(
    engine,
    options.runtimeState || {},
    options.listLanAddresses || getLanAddresses,
  );
}

export function createSettingsSnapshotRoute(engine: EngineLike, options: SettingsSnapshotOptions = {}) {
  const route = new Hono();

  route.get("/settings/snapshot", async (c) => {
    try {
      const agentId = resolveSnapshotAgentId(engine, c.req.query("agentId"));
      const baseDir = agentDir(engine, agentId);
      const config = await buildAgentConfig(engine, agentId);
      const runtimeAgent = engine.getAgent?.(agentId);
      const snapshotAgent = runtimeAgent?.config
        ? runtimeAgent
        : { ...(runtimeAgent || {}), id: agentId, config };
      const [identity, ishiki, publicIshiki] = await Promise.all([
        readTextFile(path.join(baseDir, "identity.md")),
        readTextFile(path.join(baseDir, "ishiki.md")),
        readTextFile(path.join(baseDir, "public-ishiki.md")),
      ]);
      const canSeeLocalPaths = isLocalOwnerPrincipal(readAuthPrincipal(c));
      return c.json({
        agentId,
        config,
        identity,
        ishiki,
        publicIshiki,
        userProfile: await readTextFile(path.join(engine.userDir, "profile.md")),
        experience: readExperience(engine, agentId, config),
        pinned: { pins: readPinned(baseDir) },
        globalModels: buildGlobalModels(engine),
        preferences: {
          quickChat: engine.getQuickChatPreferences?.() || normalizeQuickChatPreferences({}),
          notifications: engine.getNotificationPreferences?.() || normalizeNotificationPreferences({}),
          browser: engine.getBrowserPreferences?.() || normalizeBrowserPreferences({}),
          bridge: buildBridgePreferences(engine),
          speechRecognition: engine.speechRecognition?.getConfig?.() || engine.getSpeechRecognitionConfig?.() || { enabled: false },
          experiments: listResolvedExperiments(engine.preferences),
          computerUse: await buildComputerUsePreferences(engine, {
            platform: options.platform || process.platform,
          }),
        },
        access: buildAccessSnapshot(engine, canSeeLocalPaths, options),
        bridgeStatus: snapshotAgent
          ? buildBridgeStatus(engine, resolveBridgeManager(options.bridgeManagerRef), snapshotAgent)
          : null,
        plugins: buildPluginSettings(engine, canSeeLocalPaths),
      });
    } catch (err: unknown) {
      return c.json({ error: errorMessage(err) }, 500);
    }
  });

  return route;
}
