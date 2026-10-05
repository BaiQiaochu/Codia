import { cancelAgentReview, isAgentReviewPending } from './agent-review-turns.ts';
/**
  *
  *
  *
  *
  *
  *
  *
  *
  *
  *
 */
import fs from "fs";
import os from "os";
import path from "path";
import { migrateConfigScope } from "../shared/migrate-config-scope.ts";
import { migrateToProvidersYaml } from "./migrate-providers.ts";
import { migrateProviderMediaConfig } from "./provider-media-config.ts";
import { runMigrations } from "./migrations.ts";
import { createFallbackRuntimeContext, createServerRuntimeContext } from "./server-runtime-context.ts";
import { createRuntimeTraceStore } from "./runtime-trace-store.ts";
import { StudioCronService } from "./studio-cron-service.ts";
import { createRuntimeExecutionBoundary } from "./execution-boundary.ts";
import { ResourceAccessService } from "./resource-access-service.ts";
import { ResourceService } from "./resource-service.ts";
import { appendSecurityAuditEvent } from "./security-audit-log.ts";
import { serializeSessionFile } from "../lib/session-files/session-file-response.ts";
import { findModel } from "../shared/model-ref.ts";
import { resolveRunnableModel, canRunBackgroundTask as runtimeCanRunBackgroundTask } from "../lib/runtime/model-availability.ts";
import { resolveWorkspaceSkillPaths } from "../shared/workspace-skill-paths.ts";
import { resolveGsapPiAgentDir, resolveGsapPiProjectDir } from "../shared/gsap-runtime-paths.ts";
import { PluginManager } from "./plugin-manager.ts";
import { PluginDevService } from "./plugin-dev-service.ts";
import { createPluginDevTools } from "./plugin-dev-tools.ts";
import { PluginInstallRecords } from "../lib/plugin-install-records.ts";
import { DeferredResultCoordinator } from "../lib/deferred-result-coordinator.ts";
import { DefaultResourceLoader, PI_BUILTIN_TOOL_NAMES, SettingsManager } from "../lib/pi-sdk/index.ts";

/** */
export const WELL_KNOWN_SKILL_PATHS = [
  { suffix: ".claude/skills",     label: "Claude Code" },
  { suffix: ".codex/skills",      label: "Codex" },
  { suffix: ".openclaw/skills",   label: "OpenClaw" },
  { suffix: ".pi/agent/skills",   label: "Pi" },
  { suffix: ".agents/skills",     label: "Agents" },
];

const allBuiltInToolNames = PI_BUILTIN_TOOL_NAMES;

function findUniqueModelById(models, id) {
  if (!id || !Array.isArray(models)) return null;
  const matches = models.filter(m => m.id === id);
  return matches.length === 1 ? matches[0] : null;
}

function readSessionThinkingLevel(ctx) {
  try {
    const level = ctx?.sessionManager?.buildSessionContext?.()?.thinkingLevel;
    return typeof level === "string" ? level : null;
  } catch {
    return null;
  }
}

function resolveRequestReasoningLevel(models, prefs, ctx) {
  const sessionThinkingLevel = readSessionThinkingLevel(ctx);
  const preferenceThinkingLevel = models.resolveThinkingLevel(prefs.getThinkingLevel());
  return preferenceThinkingLevel === "xhigh" && sessionThinkingLevel === "high"
    ? "xhigh"
    : (sessionThinkingLevel || preferenceThinkingLevel);
}

function createLocalRuntimeContext(gsapHome) {
  try {
    return createServerRuntimeContext({ gsapHome });
  } catch {
    // Resource URLs still need a stable local owner context during early tests
    // or partially initialized homes.
  }
  return createFallbackRuntimeContext();
}

function resolveChannelsEnabledForToolAvailability(engine) {
  try {
    if (
      Object.prototype.hasOwnProperty.call(engine, "isChannelsEnabled")
      && typeof engine.isChannelsEnabled === "function"
    ) {
      return engine.isChannelsEnabled();
    }
    if (typeof engine._configCoord?.getChannelsEnabled === "function") {
      return engine._configCoord.getChannelsEnabled();
    }
    if (typeof engine._prefs?.getChannelsEnabled === "function") {
      return engine._prefs.getChannelsEnabled();
    }
  } catch {
    return undefined;
  }
  return undefined;
}

import { PreferencesManager } from "./preferences-manager.ts";
import { ModelManager } from "./model-manager.ts";
import { SessionProjectCatalogStore } from "./session-project-catalog-store.ts";
import {
  compactSessionWithCachePreservation,
  compactSessionWithCachePreservationRecoveringRuntime,
} from "./session-compactor.ts";
import { SkillManager } from "./skill-manager.ts";
import { BridgeSessionManager } from "./bridge-session-manager.ts";
import { createSlashSystem } from "./slash-commands/index.ts";
import { AgentManager } from "./agent-manager.ts";
import { sanitizeMessagesForModel, stripHistoricalInlineMediaForReplay } from "./message-sanitizer.ts";
import { createCurrentTurnNativeMediaStore } from "./current-turn-native-media.ts";
import { normalizeProviderContextMessages, normalizeProviderPayload } from "./provider-compat.ts";
import { VisionBridge } from "./vision-bridge.ts";
import { SessionCoordinator } from "./session-coordinator.ts";
import { SessionManifestResolver } from "./session-manifest/resolver.ts";
import { SessionManifestStore } from "./session-manifest/store.ts";
import { ensureLegacySessionManifestMigration } from "./session-manifest/startup-migration.ts";
import { ConfigCoordinator, SHARED_MODEL_KEYS } from "./config-coordinator.ts";
import { ChannelManager } from "./channel-manager.ts";
import {
  summarizeTitle as _summarizeTitle,
  translateSkillNames as _translateSkillNames,
  summarizeActivity as _summarizeActivity,
  summarizeActivityQuick as _summarizeActivityQuick,
} from "./llm-utils.ts";
import { callText } from "./llm-client.ts";
import { debugLog, createModuleLogger } from "../lib/debug-log.ts";
import { createSandboxedTools } from "../lib/sandbox/index.ts";
import { createSandboxResourceIO } from "../lib/resource-io/sandbox-resource-io.ts";
import { ResourceEventBus } from "../lib/resource-io/resource-event-bus.ts";
import { resourceKeyForRef } from "../lib/resource-io/resource-refs.ts";
import { ResourceWatchRegistry } from "../lib/resource-io/resource-watch-registry.ts";
import { externalReadPathsFromSessionFiles } from "../lib/sandbox/win32-policy.ts";
import { loadLocale, t } from "../lib/i18n.ts";
import { CheckpointStore } from "../lib/checkpoint-store.ts";
import { assertAllToolsCategorized } from "../shared/tool-categories.ts";
import { filterToolObjectsByAvailability } from "./tool-availability.ts";
import {
  PROFESSIONAL_DISABLED_FEATURES,
  professionalEditionStatus,
  professionalFeatureDisabled,
} from "../shared/professional-edition.ts";
import { wrapWithCheckpoint } from "../lib/checkpoint-wrapper.ts";
import { wrapWithSessionPermission } from "../lib/tools/session-permission-wrapper.ts";
import { createApprovalGateway, createModelApprovalReviewer } from "../lib/approval-gateway.ts";
import { TaskRegistry } from "../lib/task-registry.ts";
import { TerminalSessionManager } from "../lib/terminal/terminal-session-manager.ts";
import { ComputerHost } from "./computer-use/computer-host.ts";
import { ComputerProviderRegistry } from "./computer-use/provider-registry.ts";
import { createMockComputerProvider } from "./computer-use/providers/mock-provider.ts";
import { createMacosCuaProvider } from "./computer-use/providers/macos-cua-provider.ts";
import { createWindowsUiaProvider } from "./computer-use/providers/windows-uia-provider.ts";
import { createLinuxXdotoolProvider } from "./computer-use/providers/linux-xdotool-provider.ts";
import {
  effectiveComputerUseSettings,
  isComputerUsePlatformSupported,
} from "./computer-use/platform-support.ts";
import { SessionFileRegistry } from "../lib/session-files/session-file-registry.ts";
import { workspaceRootsForSandbox } from "../shared/workspace-scope.ts";
import { NotificationService } from "../lib/notifications/notification-service.ts";
import { SpeechRecognitionService } from "./speech-recognition-service.ts";
import { UniversalMediaManager } from "./media/universal-media-manager.ts";
import {
  getSkillNameTranslationCachePath,
  translateSkillNamesWithCache,
} from "../lib/skills/skill-name-translation-cache.ts";
import { createUsageLedger } from "../lib/llm/usage-ledger.ts";
import { getFreshCompactNoopReason } from "../lib/fresh-compact/policy.ts";
import {
  autoProjectIdForCwd,
  isAutoProjectId,
  normalizeSessionProjectId,
  UNCATEGORIZED_PROJECT_ID,
} from "../shared/session-projects.ts";

const moduleLog = createModuleLogger("engine");

type DynamicOptions = {
  agentId?: string | null;
  [key: string]: unknown;
};

type EngineConstructorOptions = {
  gsapHome: string;
  productDir: string;
  agentId?: string | null;
};

type BuildToolsOptions = DynamicOptions & {
  agentDir?: string;
  workspace?: string | null;
  workspaceFolders?: string[];
  authorizedFolders?: string[];
  getAuthorizedFolders?: () => unknown;
  getSessionPath?: () => string | null | undefined;
  fileReadSessionPaths?: unknown[];
  getPermissionMode?: (sessionPath?: string | null) => string | null | undefined;
  getTraceContext?: () => Record<string, unknown> | null | undefined;
  permissionContext?: unknown;
};

type SessionFileEventLike = {
  id?: string | null;
  fileId?: string | null;
  origin?: string | null;
  sessionPath?: string | null;
  filePath?: string | null;
  operation?: string | null;
  operations?: unknown[];
  mtimeMs?: number;
  size?: number | null;
  version?: number | string | null;
  [key: string]: unknown;
};

type SessionFileLocatorOptions = {
  sessionId?: string | null;
  sessionPath?: string | null;
  [key: string]: unknown;
};

type ResourceChangedInput = Parameters<ResourceEventBus["changed"]>[0] & Record<string, unknown>;

type UtilityContextOptions = {
  agentId?: string | null;
  sessionPath?: string | null;
};

function sessionBelongsToProject(projectId) {
  return (session) => {
    const explicitProjectId = normalizeSessionProjectId(session?.projectId);
    if (explicitProjectId) return explicitProjectId === projectId;
    if (!isAutoProjectId(projectId)) return false;
    return autoProjectIdForCwd(session?.cwd || null) === projectId;
  };
}

function normalizePathList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === "string" && item.trim())
    .map((item) => item.trim());
}

export class GsapEngine {
  [key: string]: any;

  /**
   * @param {object} dirs
   * @param {string} dirs.gsapHome
   * @param {string} dirs.productDir
   * @param {string} [dirs.agentId]
   */
  constructor({ gsapHome, productDir, agentId = null }: EngineConstructorOptions) {
    this.gsapHome = gsapHome;
    this.productDir = productDir;
    this._license = null;
    this._currentTurnNativeMedia = createCurrentTurnNativeMediaStore();
    this.agentsDir = path.join(gsapHome, "agents");
    this.userDir = path.join(gsapHome, "user");
    this.channelsDir = path.join(gsapHome, "channels");
    fs.mkdirSync(this.channelsDir, { recursive: true });
    this._sessionFiles = new SessionFileRegistry({
      managedCacheRoot: path.join(gsapHome, "session-files"),
      getSessionIdForPath: (sessionPath) => this.getSessionIdForPath(sessionPath),
    });
    this._sessionManifestStore = new SessionManifestStore({
      dbPath: path.join(gsapHome, "session-manifest.db"),
    });
    this._sessionManifestResolver = new SessionManifestResolver({
      store: this._sessionManifestStore,
    });
    this._sessionManifestMigration = this._runSessionManifestStartupMigration();
    this._runtimeContext = createLocalRuntimeContext(gsapHome);
    this._studioCronService = new StudioCronService({
      gsapHome: this.gsapHome,
      agentsDir: this.agentsDir,
      getStudioId: () => {
        const studioId = this._runtimeContext?.studioId;
        if (!studioId) throw new Error("runtime studioId unavailable");
        return studioId;
      },
    });
    this._resources = new ResourceService({
      agentsDir: this.agentsDir,
      sessionFiles: this._sessionFiles,
      runtimeContext: this._runtimeContext,
    });
    this._resourceAccess = new ResourceAccessService({
      resourceService: this._resources,
      audit: (event) => appendSecurityAuditEvent(this.gsapHome, event),
    });
    this._resourceIO = null;
    this._resourceIOScopeKey = null;
    this._resourceEventBus = null;
    this._resourceWatchRegistry = new ResourceWatchRegistry({
      emitEvent: (event, sessionPath) => this._emitEvent(event, sessionPath),
      resolveWatchTarget: (resource) => this.getResourceIO().resolveWatchTarget(resource),
    });
    this._runtimeTraceStore = createRuntimeTraceStore();

    // ── Core managers ──
    this._prefs = new PreferencesManager({ userDir: this.userDir, agentsDir: this.agentsDir });
    this._models = new ModelManager({ gsapHome });
    this._speechRecognition = new SpeechRecognitionService({
      providerRegistry: this._models.providerRegistry,
      preferences: this._prefs,
      sessionFiles: this._sessionFiles,
      emitEvent: (event, sessionPath) => this._emitEvent(event, sessionPath),
    } as unknown as ConstructorParameters<typeof SpeechRecognitionService>[0]);
    this._media = new UniversalMediaManager({
      gsapHome: this.gsapHome,
      providerRegistry: this._models.providerRegistry,
      preferences: this._prefs,
      speechRecognition: this._speechRecognition,
      sessionFiles: this._sessionFiles,
      registerSessionFile: (entry) => this.registerSessionFile(entry),
      onProviderChanged: () => this.refreshModels(),
    });
    this._sessionProjects = new SessionProjectCatalogStore({ userDir: this.userDir });
    this._pluginInstallRecords = new PluginInstallRecords({ gsapHome });
    this._approvalGateway = createApprovalGateway({
      smallToolModelReviewer: createModelApprovalReviewer({
        role: "utility",
        resolveUtilityConfig: (options) => this.resolveUtilityConfig(options || {}),
        callText: (options) => this._callApprovalReviewerText(options),
      } as unknown as Parameters<typeof createModelApprovalReviewer>[0]),
      largeToolModelReviewer: createModelApprovalReviewer({
        role: "utility_large",
        resolveUtilityConfig: (options) => this.resolveUtilityConfig(options || {}),
        callText: (options) => this._callApprovalReviewerText(options),
      } as unknown as Parameters<typeof createModelApprovalReviewer>[0]),
    });

 // 确定启动时焦-agent
    const startId = agentId || this._prefs.getPrimaryAgent() || this._prefs.findFirstAgent();
    if (!startId) throw new Error(t("error.noAgentsFound"));

    // ── Channel Manager ──
    this._channels = new ChannelManager({
      channelsDir: this.channelsDir,
      agentsDir: this.agentsDir,
      userDir: this.userDir,
      getHub: () => this._hubCallbacks,
    });

    // ── Agent Manager ──
    this._agentMgr = new AgentManager({
      gsapHome: this.gsapHome,
      agentsDir: this.agentsDir,
      productDir: this.productDir,
      userDir: this.userDir,
      channelsDir: this.channelsDir,
      getPrefs: () => this._prefs,
      getModels: () => this._models,
      getHub: () => this._hubCallbacks,
      getSkills: () => this._skills,
      getSearchConfig: () => this.getSearchConfig(),
      resolveUtilityConfig: (options) => this.resolveUtilityConfig(options),
      getSharedModels: () => this._configCoord.getSharedModels(),
      getChannelManager: () => this._channels,
      getSessionCoordinator: () => this._sessionCoord,
      getEngine: () => this,
      getResourceLoader: () => this._resourceLoader,
    });

    // ── Session Coordinator ──
    this._sessionCoord = new SessionCoordinator({
      agentsDir: this.agentsDir,
      getAgent: () => this.agent,
      getActiveAgentId: () => this.currentAgentId,
      getModels: () => this._models,
      getResourceLoader: () => this._resourceLoader,
      getSkills: () => this._skills,
      buildTools: (cwd, ct, opts) => this.buildTools(cwd, ct, opts),
      emitEvent: (e, sp) => this._emitEvent(e, sp),
      emitDevLog: (t, l) => this.emitDevLog(t, l),
      getHomeCwd: (agentId) => this.getHomeCwd(agentId),
      agentIdFromSessionPath: (p) => this.agentIdFromSessionPath(p),
      switchAgentOnly: (id) => this._agentMgr.switchAgentOnly(id),
      getConfig: () => this.config,
      getPrefs: () => this._prefs,
      getAgents: () => this._agentMgr.agents,
      getActivityStore: (id) => this.getActivityStore(id),
      getAgentById: (id) => this._agentMgr.getAgent(id),
      listAgents: () => this.listAgents(),
      listDeletedAgents: () => this.listDeletedAgents(),
      isAgentDeleted: (id) => this.isAgentDeleted(id),
      getDeletedAgentInfo: (id) => this.getDeletedAgentInfo(id),
      getConfirmStore: () => this._confirmStore,
      getDeferredResultStore: () => this._deferredResultStore,
      getTaskRegistry: () => this._taskRegistry,
      getEngine: () => this,
      getUsageLedger: () => this._usageLedger,
      sessionManifestStore: this._sessionManifestStore,
      runtimeTraceStore: this._runtimeTraceStore,
      closeTerminalsForSession: (sessionPath) => this._terminalSessions?.closeForSession(sessionPath),
      closeAllTerminals: () => this._terminalSessions?.closeAll(),
      onSessionRuntimeDiscarded: (sessionPath, reason) => this.clearSessionRuntimeState(sessionPath, reason),
      onBeforeSessionCreate: async (cwd) => {
        await this.syncWorkspaceSkillPaths(cwd, { reload: true, emitEvent: false });
      },
    });

    // ── Config Coordinator ──
    this._configCoord = new ConfigCoordinator({
      gsapHome,
      agentsDir: this.agentsDir,
      getAgent: () => this.agent,
      getAgentById: (id) => this._agentMgr.getAgent(id),
      getActiveAgentId: () => this._agentMgr.activeAgentId,
      getAgents: () => this._agentMgr.agents,
      getModels: () => this._models,
      getPrefs: () => this._prefs,
      getSkills: () => this._skills,
      getSession: () => this._sessionCoord.session,
      getSessionCoordinator: () => this._sessionCoord,
      getHub: () => this._hubCallbacks,
      emitEvent: (e, sp) => this._emitEvent(e, sp),
      emitDevLog: (t, l) => this.emitDevLog(t, l),
      getCurrentModel: () => this.currentModel?.name,
    });

    this._visionBridge = new VisionBridge({
      resolveVisionConfig: () => this.resolveVisionConfig(),
      getUsageLedger: () => this._usageLedger,
      getActiveAgentId: () => this._agentMgr.activeAgentId,
    } as unknown as ConstructorParameters<typeof VisionBridge>[0]);

    // ── Bridge Session Manager ──
    this._bridge = new BridgeSessionManager({
      getAgent: () => this.agent,
      getAgentById: (id) => this._agentMgr.getAgent(id),
      getAgents: () => this._agentMgr.agents,
      getModelManager: () => this._models,
      getResourceLoader: () => this._resourceLoader,
      getPreferences: () => this._readPreferences(),
      buildTools: (cwd, customTools, opts) => this.buildTools(cwd, customTools, opts),
      getHomeCwd: (agentId) => this.getHomeCwd(agentId),
      getVisionBridge: () => this._visionBridge,
      isVisionAuxiliaryEnabled: () => this.isVisionAuxiliaryEnabled(),
      getGsapHome: () => this.gsapHome,
      registerSessionFile: (entry) => this.registerSessionFile(entry),
      getSessionFile: (fileId, options) => this.getSessionFile(fileId, options),
      getSessionFileByPath: (filePath, options) => this.getSessionFileByPath(filePath, options),
      beginCurrentTurnNativeMedia: (sessionPath, opts) => this.beginCurrentTurnNativeMedia(sessionPath, opts),
      endCurrentTurnNativeMedia: (token) => this.endCurrentTurnNativeMedia(token),
      getUsageLedger: () => this._usageLedger,
    });
    this._notifications = new NotificationService({
      emitDesktop: ({ title, body, agentId, desktopFocusPolicy, sessionPath }) => {
        this._hubCallbacks?.eventBus?.emit({
          type: "notification",
          title,
          body,
          agentId: agentId || null,
          desktopFocusPolicy,
          sessionPath: sessionPath || null,
        }, null);
      },
      getBridgeManager: () => this._hubCallbacks?.hub?.bridgeManager || null,
    });

    this._slashSystem = createSlashSystem({ engine: this, hub: null });

 // 任务注册表（外部 abort 用）
    this._taskRegistry = new TaskRegistry({
      persistencePath: path.join(this.gsapHome, ".ephemeral", "plugin-tasks.json"),
    });

    this._subagentControllers = new Map();
    this._taskRegistry.registerHandler("subagent", {
      abort: (taskId) => {
        const ctrl = this._subagentControllers?.get?.(taskId);
        if (ctrl) ctrl.abort();
      },
    });

    this._terminalSessions = new TerminalSessionManager({
      gsapHome: this.gsapHome,
      emitEvent: (event, sessionPath) => this._emitEvent(event, sessionPath),
    });

 // Checkpoint 备份存储
    this._checkpointStore = new CheckpointStore(
      path.join(this.gsapHome, "checkpoints")
    );

    // Computer Use is lazy: provider construction touches native/runtime paths,
    // so keep startup cold until the experiment is enabled or an endpoint/tool
    // explicitly needs the host.
    this._computerProviders = null;
    this._computerHost = null;

    this._pluginManager = null;  // initialized async in initPlugins()
    this._pluginDevService = null;

 // Pi SDK resources（init 时填充）
    this._resourceLoader = null;

    // Hub callbacks are injected by Hub after construction.
    this._hubCallbacks = null;

 // 事件系统
    this._listeners = new Set();
    this._eventBus = null;
    this._usageLedger = createUsageLedger({
      eventBus: {
        emit: (event, sessionPath) => this._emitEvent(event, sessionPath),
      },
      logger: moduleLog,
    });
    this._imageStripNotified = new Set();
    this._videoStripNotified = new Set();
    this._uiContextBySession = new Map();

 // DevTools 日志
    this._devLogs = [];
    this._devLogsMax = 200;

 // 设置起始 agentId
    this._agentMgr.activeAgentId = startId;
  }

  // ════════════════════════════
 //

 /** */
  get agent() { return this._agentMgr.agent; }
  get usageLedger() { return this._usageLedger; }
  _sessionRefForPath(sessionPath) {
    if (!sessionPath) return { sessionId: null, sessionPath: null };
    return {
      sessionId: this.getSessionIdForPath(sessionPath),
      sessionPath,
    };
  }
  _runtimeSessionKey(sessionPath) {
    return this.getSessionIdForPath?.(sessionPath) || sessionPath;
  }
  beginCurrentTurnNativeMedia(sessionPath, opts) {
    return this._currentTurnNativeMedia.begin(this._sessionRefForPath(sessionPath), opts);
  }
  endCurrentTurnNativeMedia(token) { return this._currentTurnNativeMedia.end(token); }
  clearSessionRuntimeState(sessionPath, reason = "discard") {
    if (!sessionPath) return false;
    void reason;
    const sessionKey = typeof this._runtimeSessionKey === "function"
      ? this._runtimeSessionKey(sessionPath)
      : sessionPath;
    this._uiContextBySession?.delete(sessionPath);
    if (sessionKey !== sessionPath) this._uiContextBySession?.delete(sessionKey);
    this._imageStripNotified?.delete(sessionPath);
    this._imageStripNotified?.delete(sessionKey);
    this._videoStripNotified?.delete(sessionPath);
    this._videoStripNotified?.delete(sessionKey);
    if (typeof this._currentTurnNativeMedia?.clearSession === "function") {
      const sessionRef = typeof this._sessionRefForPath === "function"
        ? this._sessionRefForPath(sessionPath)
        : sessionPath;
      this._currentTurnNativeMedia.clearSession(sessionRef);
    }
    if (typeof this._sessionFiles?.unloadSession === "function") {
      this._sessionFiles.unloadSession(sessionPath);
    }
    if (typeof this._computerHost?.abortSession === "function") {
      this._computerHost.abortSession(sessionPath);
    }
    return true;
  }
  getAgent(agentId) { return this._agentMgr.getAgent(agentId); }
  ensureAgentRuntime(agentId, options = {}) { return this._agentMgr.ensureAgentRuntime(agentId, options); }
 /** */
  get currentAgentId() { return this._agentMgr.activeAgentId; }
  get confirmStore() { return this._confirmStore; }
  get approvalGateway() { return this._approvalGateway; }
  getStudioCronStore() { return this._studioCronService; }

  /** @deprecated 工具应通过 emitEvent(event, sessionPath) 传入显式 sessionPath */
  emitSessionEvent(event) {
    this._emitEvent(event, this.currentSessionPath);
  }

  setConfirmStore(store) {
    this._confirmStore = store;
    if (store) {
      store.onResolved = (confirmId, action) => {
        this._emitEvent({ type: "confirmation_resolved", confirmId, action }, null);
      };
    }
  }

  setDeferredResultStore(store) {
    this._deferredResultCoordinator?.dispose?.();
    this._deferredResultStore = store;
    this._deferredResultCoordinator = null;
    if (store) {
      this._deferredResultCoordinator = new DeferredResultCoordinator({
        store,
        sessionCoordinator: this._sessionCoord,
      });
      this._deferredResultCoordinator.start();
    }
  }

  get deferredResults() {
    return this._deferredResultStore || null;
  }

  setSubagentRunStore(store) {
    this._subagentRunStore = store || null;
  }

  get subagentRuns() {
    return this._subagentRunStore || null;
  }

  setSubagentThreadStore(store) {
    this._subagentThreadStore = store || null;
  }

  get subagentThreads() {
    return this._subagentThreadStore || null;
  }

  setActivityHub(hub) {
    this._activityHub = hub || null;
  }

  get activityHub() {
    return this._activityHub || null;
  }

  get taskRegistry() {
    return this._taskRegistry;
  }

  get runtimeContext() {
    return this._runtimeContext;
  }

  getRuntimeContext() {
    return this._runtimeContext;
  }

  getRuntimeTraceStore() {
    return this._runtimeTraceStore;
  }

  createExecutionBoundary(options = {}) {
    return createRuntimeExecutionBoundary(this.getRuntimeContext(), options);
  }

  get terminalSessions() {
    return this._terminalSessions;
  }

  registerSessionFile(entry) {
    const sessionId = entry?.sessionId
      || (entry?.sessionPath ? this.getSessionIdForPath(entry.sessionPath) : null);
    return this._sessionFiles.registerFile({
      ...entry,
      ...(sessionId ? { sessionId } : {}),
    });
  }
  recordSessionFileOperation(entry) {
    const file = this.registerSessionFile(entry);
    this._emitResourceChangedForSessionFileOperation(file, entry);
    return file;
  }
  _resourceEvents() {
    if (!this._resourceEventBus) {
      this._resourceEventBus = new ResourceEventBus({
        emit: (event, sessionPath) => this._emitEvent(event, sessionPath),
      });
    }
    return this._resourceEventBus;
  }
  emitResourceChanged(input) {
    return this._resourceEvents().changed(input);
  }
  emitResourceDeleted(input) {
    return this._resourceEvents().deleted(input);
  }
  emitResourceRenamed(input) {
    return this._resourceEvents().renamed(input);
  }
  _emitResourceChangedForSessionFileOperation(file: SessionFileEventLike | null, entry: SessionFileEventLike = {}) {
    const origin = typeof file?.origin === "string" ? file.origin : entry?.origin;
    if (origin !== "agent_write" && origin !== "agent_edit") return;

    const sessionPath = file?.sessionPath || entry?.sessionPath;
    const filePath = file?.filePath || entry?.filePath;
    if (!sessionPath || !filePath) return;

    const fileId = file?.id || file?.fileId || null;
    const operation = entry?.operation || file?.operation || (
      Array.isArray(file?.operations) ? file.operations[file.operations.length - 1] : null
    );
    const changedInput: ResourceChangedInput = {
      changeType: operation === "created" ? "created" : "modified",
      resourceKey: resourceKeyForRef({ kind: "local-file", path: filePath }),
      resource: {
        kind: "local-file",
        provider: "local_fs",
        path: filePath,
        filePath,
      },
      version: {
        ...(file?.mtimeMs !== undefined ? { mtimeMs: file.mtimeMs } : {}),
        ...(file?.size !== undefined ? { size: file.size } : {}),
        ...(typeof file?.version === "number" ? { sequence: file.version } : {}),
      },
      source: "agent_tool",
      reason: origin,
      sessionPath,
      fileId,
      origin,
      operation,
      sessionFile: file,
    };
    this._resourceEvents().changed(changedInput);
  }
  _sessionFileOptionsWithLocator(options: SessionFileLocatorOptions = {}) {
    if (!options?.sessionId) return options;
    const manifest = this.getSessionManifest?.(options.sessionId) || null;
    if (!manifest?.currentLocator?.path) return options;
    return {
      ...options,
      sessionPath: options.sessionPath || manifest.currentLocator.path,
    };
  }
  getSessionFile(fileId, options) { return this._sessionFiles.get(fileId, this._sessionFileOptionsWithLocator(options)); }
  getSessionFileByPath(filePath, options) { return this._sessionFiles.getByFilePath(filePath, this._sessionFileOptionsWithLocator(options)); }
  listSessionFiles(sessionPath) { return this._sessionFiles.list(sessionPath); }
  updateSessionFileTranscription(fileId, transcription, options) {
    return this._sessionFiles.updateTranscription(fileId, transcription, this._sessionFileOptionsWithLocator(options));
  }
  get speechRecognition() { return this._speechRecognition; }
  get media() { return this._media; }
  get resources() { return this._resources; }
  getResourceService() { return this._resources; }
  getResourceAccessService() {
    if (!this._resourceAccess) throw new Error("resource access service is not initialized");
    return this._resourceAccess;
  }
  getResourceIO() {
    const resourceScope = this._resolveResourceIOScope();
    const resourceScopeKey = JSON.stringify(resourceScope);
    if (!this._resourceIO || this._resourceIOScopeKey !== resourceScopeKey) {
      const studioId = this._runtimeContext?.studioId || null;
      this._resourceIO = createSandboxResourceIO({
        cwd: resourceScope.cwd,
        agentDir: this.agent?.dir || this.agentsDir,
        workspace: resourceScope.cwd,
        workspaceFolders: resourceScope.workspaceFolders,
        authorizedFolders: resourceScope.authorizedFolders,
        getAuthorizedFolders: () => this._resolveResourceIOScope().authorizedFolders,
        gsapHome: this.gsapHome,
        getSandboxEnabled: () => this._readPreferences?.().sandbox !== false,
        getSessionPath: () => this.currentSessionPath || null,
        emitEvent: (event, sessionPath) => this._emitEvent(event, sessionPath),
        sessionFiles: this._sessionFiles,
        resourceService: this.getResourceService(),
        studioId,
      });
      this._resourceIOScopeKey = resourceScopeKey;
    }
    return this._resourceIO;
  }
  _resolveResourceIOScope() {
    const sessionPath = this.currentSessionPath || null;
    const cwd = (sessionPath ? this.getSessionCwd(sessionPath) : null)
      || this.cwd
      || this.userDir
      || process.cwd();
    return {
      sessionPath,
      cwd,
      workspaceFolders: normalizePathList(this.getSessionWorkspaceFolders?.(sessionPath)),
      authorizedFolders: normalizePathList(this.getSessionAuthorizedFolders?.(sessionPath)),
    };
  }
  retainResourceWatch(resource) {
    if (!this._resourceWatchRegistry || typeof this._resourceWatchRegistry.retain !== "function") {
      throw new Error("resource watch unavailable");
    }
    return this._resourceWatchRegistry.retain(resource);
  }
  subscribeResourceWatch(input) {
    if (!this._resourceWatchRegistry || typeof this._resourceWatchRegistry.subscribe !== "function") {
      throw new Error("resource watch unavailable");
    }
    return this._resourceWatchRegistry.subscribe(input);
  }
  unsubscribeResourceWatch(subscriptionId) {
    if (!this._resourceWatchRegistry || typeof this._resourceWatchRegistry.unsubscribe !== "function") {
      throw new Error("resource watch unavailable");
    }
    return this._resourceWatchRegistry.unsubscribe(subscriptionId);
  }
  resourceWatchDiagnostics() {
    return this._resourceWatchRegistry?.diagnostics?.() || { subscriptions: 0, watches: [] };
  }
  getResource(resourceId) { return this.getResourceService().getResource(resourceId); }
  resolveResourceContent(resourceId) { return this.getResourceService().resolveContent(resourceId); }
  serializeSessionFile(file) { return serializeSessionFile(file, { runtimeContext: this.getRuntimeContext() }); }
  async cleanupColdSessionFiles(options) {
    return this._sessionFiles.cleanupColdSessions({
      agentsDir: this.agentsDir,
      ...(options || {}),
    });
  }

  _ensureSubagentControllers() {
    if (!(this._subagentControllers instanceof Map)) this._subagentControllers = new Map();
    return this._subagentControllers;
  }
  setSubagentController(taskId, controller) { this._ensureSubagentControllers().set(taskId, controller); }
  removeSubagentController(taskId) { this._ensureSubagentControllers().delete(taskId); }

  setUiContext(sessionPath, ctx) {
    if (!sessionPath) return;
    const key = typeof this._runtimeSessionKey === "function"
      ? this._runtimeSessionKey(sessionPath)
      : sessionPath;
    if (ctx == null) {
      this._uiContextBySession.delete(sessionPath);
      this._uiContextBySession.delete(key);
    } else {
      this._uiContextBySession.set(key, ctx);
    }
  }

  getUiContext(sessionPath) {
    if (!sessionPath) return null;
    const key = typeof this._runtimeSessionKey === "function"
      ? this._runtimeSessionKey(sessionPath)
      : sessionPath;
    return this._uiContextBySession.get(key) || this._uiContextBySession.get(sessionPath) || null;
  }

  resolveSessionRef(ref, opts: Record<string, unknown> = {}) {
    return this._sessionManifestResolver.resolve(ref, opts);
  }

  getSessionManifest(sessionId) {
    return this._sessionManifestStore.getBySessionId(sessionId);
  }

  getSessionIdForPath(sessionPath) {
    return this._sessionManifestResolver?.resolveOptional?.({ sessionPath })?.sessionId || null;
  }

  _runSessionManifestStartupMigration() {
    try {
      const result = ensureLegacySessionManifestMigration({
        gsapHome: this.gsapHome,
        store: this._sessionManifestStore,
      });
      if (result?.status === "failed") {
        moduleLog.warn(`session manifest startup migration failed: ${result.error?.message || result.error}`);
      }
      return result;
    } catch (err) {
      moduleLog.warn(`session manifest startup migration failed: ${err?.message || err}`);
      return { status: "failed", error: err };
    }
  }

 // 向后兼容 getter
  get agentDir() { return this.agent?.agentDir || path.join(this.agentsDir, this.currentAgentId); }
  get baseDir() { return this.agentDir; }
  get activityDir() { return path.join(this.agentDir, "activity"); }
  get activityStore() { return this.getActivityStore(this.currentAgentId); }
  getActivityStore(agentId) { return this._agentMgr.getActivityStore(agentId); }

  get agents() { return this._agentMgr.agents; }
  listAgents() { return this._agentMgr.listAgents(); }
  listDeletedAgents() { return this._agentMgr.listDeletedAgents?.() || []; }
  isAgentDeleted(agentId) { return this._agentMgr.isAgentDeleted?.(agentId) === true; }
  getDeletedAgentInfo(agentId) { return this._agentMgr.getDeletedAgentInfo?.(agentId) || null; }
  invalidateAgentListCache() { this._agentMgr.invalidateAgentListCache(); }
  async createAgent(opts) { return this._agentMgr.createAgent(opts); }
  async switchAgent(agentId) { return this._agentMgr.switchAgent(agentId); }
  async deleteAgent(agentId) { return this._agentMgr.deleteAgent(agentId); }
  setPrimaryAgent(agentId) { return this._agentMgr.setPrimaryAgent(agentId); }
  agentIdFromSessionPath(p) { return this._agentMgr.agentIdFromSessionPath(p); }
  async createSessionForAgent(agentId, cwd, mem, model, opts = {}) {
    return this._agentMgr.createSessionForAgent(agentId, cwd, mem, model, opts);
  }

  // Backward-compatible agent property proxy.
  get agentName() { return this.agent.agentName; }
  set agentName(v) { this.agent.agentName = v; }
  get userName() { return this.agent.userName; }
  set userName(v) { this.agent.userName = v; }
  get configPath() { return this.agent.configPath; }
  get sessionDir() { return this.agent.sessionDir; }
  get factsDbPath() { return this.agent.factsDbPath; }
  get memoryMdPath() { return this.agent.memoryMdPath; }

  // ════════════════════════════
 //

  get session() { return this._sessionCoord.session; }
  get messages() { return this._sessionCoord.session?.messages ?? []; }
  get isStreaming() { return this._sessionCoord.session?.isStreaming ?? false; }
 /** */
  get currentSessionPath() { return this._sessionCoord.currentSessionPath; }
  get cwd() { return this._sessionCoord.session?.sessionManager?.getCwd?.() ?? process.cwd(); }
  get deskCwd() { return this._sessionCoord.session?.sessionManager?.getCwd?.() || this.homeCwd || null; }

  async createSession(mgr, cwd, mem, model, opts = {}) {
    return this._sessionCoord.createSession(mgr, cwd, mem, model, opts);
  }
  async createDetachedSession(opts = {}) {
    return this._sessionCoord.createDetachedSession(opts);
  }
  async continueDeletedAgentSession(p) {
    return this._sessionCoord.continueDeletedAgentSession(p);
  }
  async switchSession(p) {
    const result = await this._sessionCoord.switchSession(p);
    await this.syncWorkspaceSkillPaths(this.cwd, { reload: true, emitEvent: false });
    return result;
  }
  /** @deprecated Phase 2: 使用 promptSession(path, text, opts) */
  async prompt(text, opts) { return this._sessionCoord.prompt(text, opts); }
  /** @deprecated Phase 2: 使用 abortSession(path) */
  async abort() { return this._sessionCoord.abort(); }
  /** @deprecated Phase 2: 使用 steerSession(path, text) */
  steer(text) { return this._sessionCoord.steer(text); }

 //
  async promptSession(p, text, opts) { return this._sessionCoord.promptSession(p, text, opts); }
  steerSession(p, text) { return this._sessionCoord.steerSession(p, text); }
  async abortSession(p) { await cancelAgentReview(this, p); return this._sessionCoord.abortSession(p); }
  recordCustomEntry(p, type, data) { return this._sessionCoord.recordCustomEntry(p, type, data); }
  get focusSessionPath() { return this._sessionCoord.currentSessionPath; }
  getMessages(p) { return this._sessionCoord.getSessionByPath(p)?.messages ?? []; }
  getSessionCwd(p = this.currentSessionPath) {
    return this._sessionCoord.getSessionByPath(p)?.sessionManager?.getCwd?.() || null;
  }
  getSessionWorkspaceFolders(p = this.currentSessionPath) {
    return this._sessionCoord.getSessionWorkspaceFolders(p);
  }
  getSessionWorkspaceMount(p = this.currentSessionPath) {
    return this._sessionCoord.getSessionWorkspaceMount(p);
  }
  buildSessionCacheSnapshot(p = this.currentSessionPath, opts = {}) {
    return this._sessionCoord.buildSessionCacheSnapshot(p, opts);
  }

  async abortAllStreaming() { return this._sessionCoord.abortAllStreaming(); }
  isBridgeSessionStreaming(key) { return this._bridge?.isSessionStreaming(key) ?? false; }
  async abortBridgeSession(key) { return this._bridge?.abortSession(key) ?? false; }
  steerBridgeSession(key, text) { return this._bridge?.steerSession(key, text) ?? false; }
  get bridgeSessionManager() { return this._bridge; }
  getBridgeContextForSessionPath(sessionPath, opts = {}) {
    return this._bridge?.getBridgeContextForSessionPath?.(sessionPath, opts) || null;
  }
  async deliverNotification(payload, opts = {}) {
    return this._notifications.notify(payload, opts);
  }
  async controlDesktopPet(_payload, _opts: DynamicOptions = {}) {
    return professionalFeatureDisabled(PROFESSIONAL_DISABLED_FEATURES.desktopPet);
  }
  get slashRegistry() { return this._slashSystem?.registry ?? null; }
  get slashDispatcher() { return this._slashSystem?.dispatcher ?? null; }
  get rcState() { return this._slashSystem?.rcState ?? null; }
  async closeSession(p) { return this._sessionCoord.closeSession(p); }
  async discardSessionRuntime(p, reason, options) { return this._sessionCoord.discardSessionRuntime(p, reason, options); }
  async moveSessionLifecycle(input) { return this._sessionCoord.moveSessionLifecycle(input); }
  getSessionByPath(p) { return this._sessionCoord.getSessionByPath(p); }
  isSessionSwitching(p) { return this._sessionCoord.isSessionSwitching(p); }
  async ensureSessionLoaded(p) { return this._sessionCoord.ensureSessionLoaded(p); }
  async reloadSessionRuntime(p, opts = {}) { return this._sessionCoord.reloadSessionRuntime(p, opts); }
  isSessionStreaming(p, reviewRequestId = undefined) { return isAgentReviewPending(this, p, reviewRequestId) || this._sessionCoord.isSessionStreaming(p); }
  async abortSessionByPath(p) { return this._sessionCoord.abortSessionByPath(p); }
  async listSessions(options = {}) { return this._sessionCoord.listSessions(options); }
  getSessionProjectCatalog() { return this._sessionProjects.getCatalog(); }
  createSessionProjectFolder(input) { return this._sessionProjects.createFolder(input); }
  updateSessionProjectFolder(id, patch) { return this._sessionProjects.updateFolder(id, patch); }
  deleteSessionProjectFolder(id) { return this._sessionProjects.deleteFolder(id); }
  reorderSessionProjectFolders(input) { return this._sessionProjects.reorderFolders(input); }
  createSessionProject(input) { return this._sessionProjects.createProject(input); }
  updateSessionProject(id, patch) { return this._sessionProjects.updateProject(id, patch); }
  async deleteSessionProject(id) {
    const projectId = normalizeSessionProjectId(id);
    if (!projectId) throw new Error("project not found");
    const sessions = await this._sessionCoord.listSessions();
    const affectedSessions = sessions.filter(sessionBelongsToProject(projectId));
    const catalog = this._sessionProjects.deleteProject(projectId);
    await Promise.all(affectedSessions.map(session => (
      this._sessionCoord.writeSessionMeta(session.path, { projectId: UNCATEGORIZED_PROJECT_ID })
    )));
    return {
      catalog,
      assignment: {
        projectId: UNCATEGORIZED_PROJECT_ID,
        sessionPaths: affectedSessions.map(session => session.path),
      },
    };
  }
  reorderSessionProjects(input) { return this._sessionProjects.reorderProjects(input); }
  normalizeSessionProjectAssignmentId(projectId) {
    const normalizedProjectId = normalizeSessionProjectId(projectId);
    if (!normalizedProjectId) return null;
    const catalog = this._sessionProjects.getCatalog();
    if (
      !isAutoProjectId(normalizedProjectId)
      && !catalog.projects.some(project => project.id === normalizedProjectId)
    ) {
      throw new Error("project not found");
    }
    return normalizedProjectId;
  }
  async setSessionProjectAssignment({ sessionPath, projectId }) {
    if (!sessionPath || typeof sessionPath !== "string") throw new Error("sessionPath is required");
    const normalizedProjectId = this.normalizeSessionProjectAssignmentId(projectId);
    await this._sessionCoord.writeSessionMeta(sessionPath, { projectId: normalizedProjectId });
    return { sessionPath, projectId: normalizedProjectId };
  }
  async setSessionPluginMeta(p, patch) { return this._sessionCoord.setSessionPluginMeta(p, patch); }
  async listArchivedSessions() { return this._sessionCoord.listArchivedSessions(); }
  async saveSessionTitle(p, t) { return this._sessionCoord.saveSessionTitle(p, t); }
  async clearSessionTitle(p) { return this._sessionCoord.clearSessionTitle(p); }
  async setSessionPinned(p, pinned) { return this._sessionCoord.setSessionPinned(p, pinned); }
  createSessionContext() { return this._sessionCoord.createSessionContext(); }
  promoteActivitySession(f, agentId) { return this._sessionCoord.promoteActivitySession(f, agentId); }
  getSessionAuthorizedFolders(p = this.currentSessionPath) {
    return this._sessionCoord.getSessionAuthorizedFolders(p);
  }
  getSessionFolderScope(p = this.currentSessionPath) {
    return this._sessionCoord.getSessionFolderScope(p);
  }
  setSessionAuthorizedFolders(p, folders) {
    return this._sessionCoord.setSessionAuthorizedFolders(p, folders);
  }
  addSessionAuthorizedFolder(p, folder) {
    return this._sessionCoord.addSessionAuthorizedFolder(p, folder);
  }
  removeSessionAuthorizedFolder(p, folder) {
    return this._sessionCoord.removeSessionAuthorizedFolder(p, folder);
  }
  async executeIsolated(prompt, opts) { return this._sessionCoord.executeIsolated(prompt, opts); }

  // ════════════════════════════
 //

  get config() { return this.agent.config; }
  get factStore() { return this.agent.factStore; }
 /** 下一次新对话将使用的模型（UI 选择器绑定此值） */
  get currentModel() {
    return this._sessionCoord.pendingModel
      ?? this._models.currentModel;
  }
 /** */
  get activeSessionModel() {
    return this._sessionCoord.session?.model ?? null;
  }
  get availableModels() { return this._models.availableModels; }
  resolveBackgroundModel(agentId, modelRef = null) {
    const agent = agentId ? this.getAgent(agentId) : this.agent;
    return resolveRunnableModel({
      availableModels: this.availableModels,
      agentConfig: agent?.config || {},
      explicitModel: modelRef,
    });
  }
  canRunBackgroundTask(agentId, modelRef = null) {
    const agent = agentId ? this.getAgent(agentId) : this.agent;
    return runtimeCanRunBackgroundTask({
      availableModels: this.availableModels,
      agentConfig: agent?.config || {},
      explicitModel: modelRef,
    });
  }
  get memoryEnabled() { return this.agent.memoryEnabled; }
  get memoryModelUnavailableReason() { return this.agent.memoryModelUnavailableReason; }
  get planMode() { return this._sessionCoord.getPlanMode(); }
  get homeCwd() { return this._configCoord.getHomeFolder(this._readPrimaryAgent()) || null; }

  getHomeCwd(agentId) {
    return this._configCoord.getHomeFolder(agentId) || null;
  }
  _createResourceLoaderOptions(skillsDir) {
    const cwd = resolveGsapPiProjectDir(this.gsapHome);
    const agentDir = resolveGsapPiAgentDir(this.gsapHome);
    if (!cwd || typeof cwd !== "string") {
      throw new Error("ResourceLoader init: cwd is required");
    }
    if (!agentDir || typeof agentDir !== "string") {
      throw new Error("ResourceLoader init: agentDir is required");
    }
    return {
      cwd,
      agentDir,
      settingsManager: SettingsManager.inMemory(),
      systemPromptOverride: () => this.agent.systemPrompt,
      appendSystemPromptOverride: () => [],
      agentsFilesOverride: () => ({ agentsFiles: [] }),
      noContextFiles: true,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      additionalSkillPaths: [skillsDir],
    };
  }
  get modelRegistry() { return this._models.modelRegistry; }
  get modelRuntime() { return this._models.modelRuntime; }
  get providerRegistry() { return this._models.providerRegistry; }
  get preferences() { return this._prefs; }
  getSidebarUiPrefs() { return this._prefs.getSidebarUiPrefs(); }
  setSidebarUiPrefs(partial) { return this._prefs.setSidebarUiPrefs(partial); }
  getPluginUiPrefs() { return this._prefs.getPluginUiPrefs(); }
  setPluginUiPrefs(partial) { return this._prefs.setPluginUiPrefs(partial); }

 /** 刷新可用模型列表（含 OAuth 自定义模型注入） */
  async refreshModels() { return this._models.refreshAvailable(); }

  getHomeFolder(agentId) { return this._configCoord.getHomeFolder(agentId); }
  setHomeFolder(agentId, folder) { return this._configCoord.setHomeFolder(agentId, folder); }
  getHeartbeatMaster() { return this._configCoord.getHeartbeatMaster(); }
  setHeartbeatMaster(v) { return this._configCoord.setHeartbeatMaster(v); }
  getChannelsEnabled() { return this._configCoord.getChannelsEnabled(); }
  async setChannelsEnabled(v) { return this._configCoord.setChannelsEnabled(v); }
  isChannelsEnabled() { return this._configCoord.getChannelsEnabled(); }
  registerAgentPhoneAbortHandler(handler, meta = {}) {
    return this._hubCallbacks?.registerAgentPhoneAbortHandler?.(handler, meta) || (() => {});
  }
  getBridgeReadOnly() { return this._prefs.getBridgeReadOnly(); }
  setBridgeReadOnly(v) { this._prefs.setBridgeReadOnly(v); }
  getBridgePermissionMode() { return this._prefs.getBridgePermissionMode(); }
  setBridgePermissionMode(v) { return this._prefs.setBridgePermissionMode(v); }
  getBridgeReceiptEnabled() { return this._prefs.getBridgeReceiptEnabled(); }
  setBridgeReceiptEnabled(v) { this._prefs.setBridgeReceiptEnabled(v); }
  getBridgeRichStreamingEnabled() { return this._prefs.getBridgeRichStreamingEnabled(); }
  setBridgeRichStreamingEnabled(v) { this._prefs.setBridgeRichStreamingEnabled(v); }
  getBridgeMediaPublicBaseUrl() { return this._prefs.getBridgeMediaPublicBaseUrl(); }
  setBridgeMediaPublicBaseUrl(v) { return this._prefs.setBridgeMediaPublicBaseUrl(v); }
  getSharedModels() { return this._configCoord.getSharedModels(); }
  setSharedModels(p) { return this._configCoord.setSharedModels(p); }
  isVisionAuxiliaryEnabled() { return this.getSharedModels()?.vision_enabled === true; }
  getVisionBridge() { return this._visionBridge; }
  resolveVisionConfig() {
    if (!this.isVisionAuxiliaryEnabled()) return null;
    const ref = this.getSharedModels()?.vision || null;
    if (!ref) return null;
    return this.resolveModelWithCredentials(ref);
  }
  getSearchConfig() { return this._configCoord.getSearchConfig(); }
  setSearchConfig(p) { return this._configCoord.setSearchConfig(p); }
  getUtilityApi() { return this._configCoord.getUtilityApi(); }
  setUtilityApi(p) { return this._configCoord.setUtilityApi(p); }
  resolveUtilityConfig(options: UtilityContextOptions = {}) {
    const config = this._configCoord.resolveUtilityConfig(options);
    return {
      ...config,
      usageLedger: this._usageLedger,
      usageAgentId: options?.agentId || this.currentAgentId || null,
      usageSessionPath: options?.sessionPath || null,
    };
  }
  _callApprovalReviewerText(options) { return callText(options); }
  traceUtilityConfig(options) { return this._configCoord.traceUtilityConfig(options); }
  resolveUtilityConfigForAgent(agentId) { return this.resolveUtilityConfig({ agentId }); }
  readAgentOrder() { return this._configCoord.readAgentOrder(); }
  saveAgentOrder(o) { return this._configCoord.saveAgentOrder(o); }
  async syncModelsAndRefresh() { return this._configCoord.syncAndRefresh(); }
  setPendingModel(id, provider) { return this._configCoord.setPendingModel(id, provider); }
  async switchSessionModel(sessionPath, modelId, provider) {
    if (!provider) {
      throw new Error(`switchSessionModel: provider required (modelId=${modelId})`);
    }
    const model = findModel(this._models.availableModels, modelId, provider);
    if (!model) throw new Error(t("error.modelNotFound", { id: `${provider}/${modelId}` }));
    if (!this._sessionCoord.getSessionByPath(sessionPath)) {
      await this._sessionCoord.switchSession(sessionPath);
    }
    return this._sessionCoord.switchSessionModel(sessionPath, model);
  }
  setDefaultModel(id, provider, opts) { return this._configCoord.setDefaultModel(id, provider, opts); }
  getThinkingLevel() { return this._configCoord.getThinkingLevel(); }
  setThinkingLevel(l) { return this._configCoord.setThinkingLevel(l); }
  getDefaultThinkingLevel() { return this._sessionCoord.getDefaultThinkingLevel(); }
  setDefaultThinkingLevel(l) { return this._sessionCoord.setDefaultThinkingLevel(l); }
  getSessionThinkingLevel(sessionPath) { return this._sessionCoord.getSessionThinkingLevel(sessionPath); }
  setSessionThinkingLevel(sessionPath, level) { return this._sessionCoord.setSessionThinkingLevel(sessionPath, level); }
  getSessionCapabilityDriftNotice(p) { return this._sessionCoord.getSessionCapabilityDriftNotice(p); }
  markCapabilitySnapshotsStale(opts = {}) { return this._sessionCoord.markCapabilitySnapshotsStale(opts); }
  async dismissSessionCapabilityDrift(p, fingerprint) { return this._sessionCoord.dismissSessionCapabilityDrift(p, fingerprint); }
  getSandbox() { return this._prefs.getSandbox(); }
  setSandbox(v) { this._prefs.setSandbox(v); }
  getSandboxNetwork() {
    if (process.platform === "win32") return true;
    return this._prefs.getSandboxNetwork();
  }
  setSandboxNetwork(v) {
    const enabled = typeof v === "string" ? v === "true" : !!v;
    if (process.platform === "win32" && !enabled) {
      throw new Error("Windows command sandbox does not support network isolation; sandboxed commands keep network access.");
    }
    this._prefs.setSandboxNetwork(enabled);
  }
  setOutboundProxyRuntime(runtime) { this._outboundProxyRuntime = runtime || null; }
  getNetworkProxy() { return this._prefs.getNetworkProxy(); }
  setNetworkProxy(v) {
    const config = this._prefs.setNetworkProxy(v);
    this._outboundProxyRuntime?.apply?.(config);
    return config;
  }
  getPluginDevToolsEnabled() { return this._prefs.getPluginDevToolsEnabled(); }
  setPluginDevToolsEnabled(value) { return this._prefs.setPluginDevToolsEnabled(value); }
  getFileBackup() { return this._prefs.getFileBackup(); }
  setFileBackup(p) { this._prefs.setFileBackup(p); }
  listCheckpoints() { return this._checkpointStore.list(); }
  restoreCheckpoint(id) { return this._checkpointStore.restore(id); }
  removeCheckpoint(id) { return this._checkpointStore.remove(id); }
  _ensureComputerRuntime() {
    if (!this.isComputerUseSupported()) {
      throw new Error("Computer Use is not supported on this platform.");
    }
    if (!this._computerProviders || !this._computerHost) {
      this._computerProviders = new ComputerProviderRegistry();
      this._computerProviders.register(createMockComputerProvider({ providerId: "mock" }));
      this._computerProviders.register(createMacosCuaProvider());
      this._computerProviders.register(createWindowsUiaProvider());
      this._computerProviders.register(createLinuxXdotoolProvider());
      this._computerHost = new ComputerHost({
        providers: this._computerProviders,
        defaultProviderId: "mock",
        getSettings: () => this.getComputerUseSettings(),
        getAccessMode: () => this._sessionCoord.getAccessMode(),
        getPrimaryAgentId: () => this._prefs.getPrimaryAgent(),
      });
    }
    return { providers: this._computerProviders, host: this._computerHost };
  }
  getComputerHost() { return this._ensureComputerRuntime().host; }
  getComputerProviders() { return this._ensureComputerRuntime().providers; }
  isComputerUseSupported(platform = process.platform) { return isComputerUsePlatformSupported(platform); }
  getComputerUseSettings() {
    return effectiveComputerUseSettings(this._prefs.getComputerUseSettings(), { platform: process.platform });
  }
  getEffectiveComputerUseSettings() { return this.getComputerUseSettings(); }
  setComputerUseSettings(partial) {
    if (!this.isComputerUseSupported() && partial?.enabled === true) {
      throw new Error("Computer Use is not supported on this platform.");
    }
    const settings = this._prefs.setComputerUseSettings(partial);
    const effectiveSettings = effectiveComputerUseSettings(settings, { platform: process.platform });
    if (effectiveSettings.enabled === true) this._ensureComputerRuntime();
    return effectiveSettings;
  }
  async updateComputerUseSettings(partial) {
    const effectiveSettings = this.setComputerUseSettings(partial);
    if (effectiveSettings.enabled !== true) {
      await this.disposeComputerRuntime();
    }
    return effectiveSettings;
  }
  async disposeComputerRuntime() {
    const host = this._computerHost;
    try {
      await host?.dispose?.();
    } finally {
      this._computerHost = null;
      this._computerProviders = null;
    }
  }
  approveComputerUseApp(approval) { return this._prefs.approveComputerUseApp(approval); }
  revokeComputerUseApp(approval) { return this._prefs.revokeComputerUseApp(approval); }
  async createUserEditCheckpoint({ filePath, reason = "edit-start" }) {
    const cfg = this._prefs.getFileBackup();
    const id = await this._checkpointStore.save({
      sessionPath: null,
      tool: "user-edit",
      source: "user-edit",
      reason,
      filePath,
      maxSizeKb: cfg.max_file_size_kb || 1024,
    });
    return id ? { id, path: filePath, reason } : null;
  }
  cleanupCheckpoints() {
    const cfg = this._prefs.getFileBackup();
    return this._checkpointStore.cleanup(cfg.retention_days || 1);
  }
  getLearnSkills() { return this._prefs.getLearnSkills(); }
  setLearnSkills(p) { this._prefs.setLearnSkills(p); }
  getLocale() { return this._prefs.getLocale(); }
  getSetupComplete() { return this._prefs.getSetupComplete(); }
  markSetupComplete() { return this._prefs.markSetupComplete(); }
  setLocale(l) {
    this._prefs.setLocale(l);
    loadLocale(this.getLocale());
  }
  getAppearance() { return this._prefs.getAppearance(); }
  setAppearance(p) { return this._prefs.setAppearance(p); }
  getQuickChatPreferences() { return this._prefs.getQuickChatPreferences(); }
  setQuickChatPreferences(p) { return this._prefs.setQuickChatPreferences(p); }
  getNotificationPreferences() { return this._prefs.getNotificationPreferences(); }
  setNotificationPreferences(p) { return this._prefs.setNotificationPreferences(p); }
  getBrowserPreferences() { return this._prefs.getBrowserPreferences(); }
  setBrowserPreferences(p) { return this._prefs.setBrowserPreferences(p); }
  getWorkspaceUiState(workspaceRoot, surface) { return this._prefs.getWorkspaceUiState(workspaceRoot, surface); }
  setWorkspaceUiState(workspaceRoot, surface, state) { return this._prefs.setWorkspaceUiState(workspaceRoot, surface, state); }
  gcWorkspacePersistence(options: DynamicOptions = {}) {
    const configResults = options?.agentId
      ? [this._configCoord.gcWorkspaceConfig(options.agentId, options)]
      : this._configCoord.gcAllWorkspaceConfigs(options);
    const workspaceUiState = this._prefs.gcWorkspaceUiState(options);
    return { configResults, workspaceUiState };
  }
  getTimezone() { return this._prefs.getTimezone(); }
  setTimezone(tz) { this._prefs.setTimezone(tz); }
  getUpdateChannel() { return this._prefs.getUpdateChannel(); }
  setUpdateChannel(ch) { this._prefs.setUpdateChannel(ch); }
  getAutoCheckUpdates() { return this._prefs.getAutoCheckUpdates(); }
  setAutoCheckUpdates(v) { this._prefs.setAutoCheckUpdates(v); }
  getHardwareAcceleration() { return this._prefs.getHardwareAcceleration(); }
  setHardwareAcceleration(v) { this._prefs.setHardwareAcceleration(v); }
  getEditor() { return this._prefs.getEditor(); }
  setEditor(v) { return this._prefs.setEditor(v); }
  getChat() { return this._prefs.getChat(); }
  setChat(v) { return this._prefs.setChat(v); }
  setMemoryEnabled(v) { return this._configCoord.setMemoryEnabled(v); }
  setMemoryMasterEnabled(id, v) { return this._configCoord.setMemoryMasterEnabled(id, v); }
  persistSessionMeta() { return this._configCoord.persistSessionMeta(); }
  get permissionMode() { return this._sessionCoord.getPermissionMode(); }
  getSessionPermissionMode(sessionPath = null) { return this._sessionCoord.getPermissionMode(sessionPath); }
  getSessionPermissionModeDefault() { return this._sessionCoord.getPermissionModeDefault(); }
  setSessionPermissionModeDefault(mode) { return this._sessionCoord.setPermissionModeDefault(mode); }
  setPermissionMode(mode, options = {}) { return this._sessionCoord.setPermissionMode(mode, options); }
  setSessionPermissionMode(mode) { return this._sessionCoord.setPermissionMode(mode); }
  setSessionPermissionModeForSession(sessionPath, mode) { return this._sessionCoord.setSessionPermissionMode(sessionPath, mode); }
  setCurrentSessionPermissionMode(mode) { return this._sessionCoord.setCurrentSessionPermissionMode(mode); }
  setPendingSessionPermissionMode(mode) { return this._sessionCoord.setPendingPermissionMode(mode); }
  get accessMode() { return this._sessionCoord.getAccessMode(); }
  setAccessMode(mode) { return this._sessionCoord.setAccessMode(mode); }
  setPlanMode(enabled) { return this._sessionCoord.setPlanMode(enabled, allBuiltInToolNames); }
  async updateConfig(p, opts) {
    const result = await this._configCoord.updateConfig(p, opts);
    await this._hubCallbacks?.syncBackgroundExecution?.();
    return result;
  }

  getPreferences() { return this._readPreferences(); }
  savePreferences(p) { return this._writePreferences(p); }

  // ════════════════════════════
 //

  deleteChannelByName(n) { return this._channels.deleteChannelByName(n); }
  createChannelEntry(opts) { return this._channels.createChannelEntry(opts); }
  async triggerChannelTriage(n, o) { return this._channels.triggerChannelTriage(n, o); }
  addAgentToChannel(channelId, agentId, role) { return this._channels.addAgentToChannel(channelId, agentId, role); }
  updateChannelMemberRole(channelId, memberId, role) { return this._channels.updateChannelMemberRole(channelId, memberId, role); }
  getChannelMemberRoles(channelId) { return this._channels.getChannelMemberRoles(channelId); }

  // ════════════════════════════
 //

  getBridgeIndex(agentId) {
    const agent = agentId ? this.getAgent(agentId) : undefined;
    return this._bridge.readIndex(agent);
  }
  saveBridgeIndex(i, agentId) {
    const agent = agentId ? this.getAgent(agentId) : undefined;
    return this._bridge.writeIndex(i, agent);
  }
  async executeExternalMessage(p, sk, m, o) { return this._bridge.executeExternalMessage(p, sk, m, o); }
  injectBridgeMessage(sk, t) { return this._bridge.injectMessage(sk, t); }
  async compactBridgeSession(sessionKey, opts) { return this._bridge.compactSession(sessionKey, opts); }
  async freshCompactBridgeSession(sessionKey, opts) { return this._bridge.freshCompactSession(sessionKey, opts); }
  async compactDesktopSession(sessionPath) {
    let session = this.getSessionByPath(sessionPath);
    if (!session) throw new Error("compactDesktopSession: session not found");
    if (session.isCompacting) throw new Error("compactDesktopSession: already compacting");
    let before = session.getContextUsage?.() ?? null;
    const compacted = await compactSessionWithCachePreservationRecoveringRuntime({
      session,
      sessionPath,
      customInstructions: undefined,
      reloadSessionRuntime: (path) => this.reloadSessionRuntime(path),
      onRuntimeReload: ({ session: reloadedSession }) => {
        session = reloadedSession;
        if (session.isCompacting) throw new Error("compactDesktopSession: already compacting");
        before = session.getContextUsage?.() ?? before;
      },
    });
    session = compacted.session || session;
    await this._sessionCoord.refreshSessionCapabilityBaseline(sessionPath);
    const after = session.getContextUsage?.() ?? null;
    return {
      tokensBefore: before?.tokens ?? null,
      tokensAfter: after?.tokens ?? null,
      contextWindow: after?.contextWindow ?? before?.contextWindow ?? null,
    };
  }

  async freshCompactDesktopSession(sessionPath) {
    let session = this.getSessionByPath(sessionPath) || await this.ensureSessionLoaded(sessionPath);
    if (!session) throw new Error("freshCompactDesktopSession: session not found");
    if (session.isCompacting) throw new Error("freshCompactDesktopSession: already compacting");
    if (this.isSessionStreaming(sessionPath)) {
      throw new Error("freshCompactDesktopSession: session is streaming, try again after the reply completes");
    }
    let before = session.getContextUsage?.() ?? null;
    let noopReason = null;
    try {
      const compacted = await compactSessionWithCachePreservationRecoveringRuntime({
        session,
        sessionPath,
        customInstructions: undefined,
        reloadSessionRuntime: (path) => this.reloadSessionRuntime(path),
        onRuntimeReload: ({ session: reloadedSession }) => {
          session = reloadedSession;
          if (session.isCompacting) throw new Error("freshCompactDesktopSession: already compacting");
          before = session.getContextUsage?.() ?? before;
        },
      });
      session = compacted.session || session;
    } catch (error) {
      noopReason = getFreshCompactNoopReason(error);
      if (!noopReason) throw error;
    }
    const after = session.getContextUsage?.() ?? null;
    await this._sessionCoord.reloadSessionRuntime(sessionPath, { refreshCapabilitySnapshots: true });
    return {
      tokensBefore: before?.tokens ?? null,
      tokensAfter: noopReason ? (before?.tokens ?? null) : (after?.tokens ?? null),
      contextWindow: after?.contextWindow ?? before?.contextWindow ?? null,
      fresh: true,
      noopReason,
    };
  }

  // ════════════════════════════
 //

  _syncAgentSkills() { this._skills.syncAgentSkills(this.agent); }
  _syncAllAgentSkills() { for (const ag of this._agentMgr.agents.values()) this._skills.syncAgentSkills(ag); }
  getAllSkills(agentId) {
 //
    if (!agentId) throw new Error("getAllSkills requires explicit agentId");
    const ag = this._agentMgr.getAgent(agentId);
    if (!ag) throw new Error(`agent not found: ${agentId}`);
    return this._skills.getAllSkills(ag);
  }
  getRuntimeSkills(agentId) {
    if (!agentId) throw new Error("getRuntimeSkills requires explicit agentId");
    const ag = this._agentMgr.getAgent(agentId);
    if (!ag) throw new Error(`agent not found: ${agentId}`);
    return this._skills.getRuntimeSkillInfos(ag);
  }
  _getSkillsForAgent(ag) { return this._skills.getSkillsForAgent(ag); }
  get skillsDir() { return this._skills?.skillsDir; }
  get userSkillsDir() { return this._skills?.skillsDir; }
  get learnedSkillsDir() { return path.join(this.agent.agentDir, "learned-skills"); }
  get modelsJsonPath() { return this._models.modelsJsonPath; }
  get authJsonPath() { return this._models.authJsonPath; }

  async reloadSkills() {
    await this._skills.reload(this._resourceLoader, this._agentMgr.agents);
    this._resourceLoader.getSystemPrompt = () => this.agent.systemPrompt;
    this._resourceLoader.getSkills = () => this._getSkillsForAgent(this.agent);
    this._syncAllAgentSkills();
  }

 /** */
  getExternalSkillPaths() {
 //
    let newDirAppeared = false;
    for (const d of this._discoveredExternalPaths || []) {
      const nowExists = fs.existsSync(d.dirPath);
      if (nowExists && !d.exists) newDirAppeared = true;
      d.exists = nowExists;
    }
    // If a discovered skill directory appeared at runtime, resync skills.
    if (newDirAppeared) {
      this.syncWorkspaceSkillPaths(this.currentSessionPath ? this.cwd : null, {
        reload: true,
        emitEvent: true,
      }).catch(() => {});
    }
    return {
      configured: this._prefs.getExternalSkillPaths(),
      discovered: this._discoveredExternalPaths || [],
    };
  }

 /** */
  async setExternalSkillPaths(paths) {
    this._prefs.setExternalSkillPaths(paths);
    await this.syncWorkspaceSkillPaths(this.currentSessionPath ? this.cwd : null, {
      reload: true,
      emitEvent: true,
    });
  }

  _mergeExternalPaths(userConfiguredPaths, extraPaths = []) {
    // Re-check discovered paths every merge.
    for (const d of this._discoveredExternalPaths || []) {
      d.exists = fs.existsSync(d.dirPath);
    }
    const discovered = (this._discoveredExternalPaths || [])
      .filter(d => d.exists)
      .map(d => ({ dirPath: d.dirPath, label: d.label }));
    const userParsed = (userConfiguredPaths || []).map(p => ({
      dirPath: path.resolve(p),
      label: path.basename(path.dirname(p)),
    }));
    const merged = [...discovered];
    const seen = new Set(merged.map(m => m.dirPath));
    for (const up of [...userParsed, ...extraPaths]) {
      if (seen.has(up.dirPath)) continue;
      merged.push(up);
      seen.add(up.dirPath);
    }
    return merged;
  }

  _getWorkspaceExternalSkillPaths(cwd) {
    return resolveWorkspaceSkillPaths(cwd);
  }

  _getResolvedExternalSkillPaths(cwd) {
    const pluginPaths = this._pluginManager?.getSkillPaths?.() || [];
    const workspacePaths = this._getWorkspaceExternalSkillPaths(cwd);
    return this._mergeExternalPaths(this._prefs.getExternalSkillPaths(), [
      ...pluginPaths,
      ...workspacePaths,
    ]);
  }

  _sameExternalSkillPaths(a = [], b = []) {
    if (a.length !== b.length) return false;
    return a.every((entry, index) => {
      const other = b[index];
      return entry?.dirPath === other?.dirPath
        && entry?.label === other?.label
        && (entry?.scope || "") === (other?.scope || "");
    });
  }

  async syncWorkspaceSkillPaths(cwd = null, { reload = true, emitEvent = false, force = false } = {}) {
    if (!this._skills) return false;
    const resolved = this._getResolvedExternalSkillPaths(cwd);
    const changed = !this._sameExternalSkillPaths(this._skills._externalPaths || [], resolved);
    if (!changed && !force) return false;

    this._skills.setExternalPaths(resolved);
    if (reload) await this.reloadSkills();
    if (emitEvent) this._emitEvent({ type: "skills-changed" }, null);
    return true;
  }



  _resolveThinkingLevel(l) { return this._models.resolveThinkingLevel(l); }
  _resolveExecutionModel(r) { return this._models.resolveExecutionModel(r); }
  _resolveProviderCredentials(p) { return this._models.resolveProviderCredentials(p); }
  resolveProviderCredentials(p) { return this._resolveProviderCredentials(p); }
  resolveProviderCredentialsFresh(p) { return this._models.resolveProviderCredentialsFresh(p); }
  resolveModelWithCredentials(ref) { return this._models.resolveModelWithCredentials(ref); }
  _inferModelProvider(id) { return this._models.inferModelProvider(id); }
  async refreshAvailableModels() { return this._models.refreshAvailable(); }

  async onProviderChanged() {
    await this._models.reloadAndSync();
    this._configCoord.normalizeUtilityApiPreferences();
    this._sessionCoord.refreshAllSessionsModels();
    await this._hubCallbacks?.syncBackgroundExecution?.();
  }
  getRegistryModelsForProvider(name) { return this._models.getRegistryModelsForProvider(name); }

  static SHARED_MODEL_KEYS = SHARED_MODEL_KEYS;



  async init(log: (message?: unknown) => void = () => {}) {
    const startupTimer = Date.now();

    // 0. Config scope migration.
    migrateConfigScope({
      agentsDir: this.agentsDir,
      prefs: this._prefs,
      primaryAgentId: this._prefs.getPrimaryAgent(),
      log,
    });

 //
    migrateToProvidersYaml(this.gsapHome, this.agentsDir, log);
    migrateProviderMediaConfig(this.gsapHome, log);

 //
    this._models.providerRegistry.migrateOverridesToAddedModels(this.agentsDir, log);

    // 0d. Versioned data migrations.
    runMigrations({
      gsapHome: this.gsapHome,
      agentsDir: this.agentsDir,
      prefs: this._prefs,
      providerRegistry: this._models.providerRegistry,
      log,
    });

 // 1. Pi SDK + 模型基础设施（必须在 agent init 之前，agent 需要解析记忆模型）
    log(`[init] 1/5 Pi SDK initializing...`);
    await this._models.init();
 //
    await this._models.refreshAvailable();
    log(`[init] 1/5 AuthStorage + ModelRegistry + ${this._models.availableModels.length} models ready`);

 // 2. 初始化所-agent
    log(`[init] 2/5 initializing agents...`);
    await this._agentMgr.initAllAgents(log, this._agentMgr.activeAgentId);
    log(`[init] 2/5 ${this._agentMgr.agents.size} agents ready`);

 //
    for (const [id] of this._agentMgr.agents) {
      const channelsMd = path.join(this.agentsDir, id, 'channels.md');
      if (!fs.existsSync(channelsMd)) {
        this._channels.setupChannelsForNewAgent(id);
      }
    }
    this._channels.repairChannelCursorProjection?.();

    // 3. ResourceLoader + Skills
    log(`[init] 3/5 ResourceLoader initializing...`);
    const t_rl = Date.now();
    const skillsDir = path.join(this.gsapHome, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });

    // Resolve external skill paths.
    const homeDir = os.homedir();
    this._discoveredExternalPaths = WELL_KNOWN_SKILL_PATHS.map(w => ({
      dirPath: path.join(homeDir, w.suffix),
      label: w.label,
      exists: fs.existsSync(path.join(homeDir, w.suffix)),
    }));
    const externalPaths = this._getResolvedExternalSkillPaths(null);

    this._skills = new SkillManager({ skillsDir, externalPaths });
    this._baseExtensionFactoryCount = 2;
    this._resourceLoader = new DefaultResourceLoader({
      ...this._createResourceLoaderOptions(skillsDir),
      extensionFactories: this._extensionFactories = [
 /** 兼容性修正：剥离第三-anthropic-messages 供应商不支持的字-*/
        (pi) => {
          pi.on("context", (event, ctx) => {
            const model = ctx?.model;
            if (!model) return;
            const reasoningLevel = resolveRequestReasoningLevel(this._models, this._prefs, ctx);
            const messages = normalizeProviderContextMessages(event.messages, model, {
              mode: "chat",
              reasoningLevel,
            });
            if (messages === event.messages) return;
            return { messages };
          });

          pi.on("before_provider_request", (event, ctx) => {
            const p = event.payload;
            if (!p) return p;
            const requestModel = ctx?.model
              || findUniqueModelById(this._models.availableModels, p.model)
              || null;
            const reasoningLevel = resolveRequestReasoningLevel(this._models, this._prefs, ctx);
            return normalizeProviderPayload(p, requestModel, { mode: "chat", reasoningLevel });
          });
        },
        (pi) => {
          pi.on("context", (event, ctx) => {
            const model = ctx?.model;
            if (!model) return;
            const replaySafe = stripHistoricalInlineMediaForReplay(event.messages);
            const sessionPath = ctx?.sessionManager?.getSessionFile?.();
            const sessionRef = this._sessionRefForPath(sessionPath);
            const currentTurnMedia = this._currentTurnNativeMedia.inject(sessionRef, replaySafe.messages);
            const { messages, stripped, strippedImages, strippedVideos } = sanitizeMessagesForModel(currentTurnMedia.messages, model);
            if (replaySafe.stripped === 0 && stripped === 0 && !currentTurnMedia.changed) return;
            const stripNoticeKey = sessionRef.sessionId || sessionPath;
            if (sessionPath && strippedImages > 0 && !this._imageStripNotified.has(stripNoticeKey)) {
              this._imageStripNotified.add(stripNoticeKey);
              this._emitEvent({
                type: "image_stripped_notice",
                modelId: model.id,
                modelProvider: model.provider,
                count: strippedImages,
              }, sessionPath);
            }
            if (sessionPath && strippedVideos > 0 && !this._videoStripNotified.has(stripNoticeKey)) {
              this._videoStripNotified.add(stripNoticeKey);
              this._emitEvent({
                type: "video_stripped_notice",
                modelId: model.id,
                modelProvider: model.provider,
                count: strippedVideos,
              }, sessionPath);
            }
            return { messages };
          });
        },
      ],
    });
    await this._resourceLoader.reload();

    const HIDDEN_SKILLS = new Set(["canvas-design", "skill-creator", "skills-translate-temp"]);
    this._skills.init(this._resourceLoader, this._agentMgr.agents, HIDDEN_SKILLS);
    const extCount = this._skills.allSkills.filter(s => s.source === "external").length;
    log(`[init] 3/5 ResourceLoader ready (${Date.now() - t_rl}ms, ${this._skills.allSkills.length} skills${extCount ? `, ${extCount} external` : ""})`);

    this._resourceLoader.getSystemPrompt = () => this.agent.systemPrompt;
    this._resourceLoader.getSkills = () => this._getSkillsForAgent(this.agent);

 // 4. 模型发现
    log(`[init] 4/5 discovering available models...`);
    try { await this.syncModelsAndRefresh(); } catch (err) {
      console.warn("[engine] startup model sync failed:", err?.stack || err);
    }
    await this._models.refreshAvailable();
    this._configCoord.normalizeUtilityApiPreferences(log);
    const availableModels = this._models.availableModels;
    log(`[init] 4/5 found ${availableModels.length} models: ${availableModels.map(m => `${m.provider}/${m.id}`).join(", ")}`);
    if (availableModels.length === 0) {
      console.warn("[engine] no available models found; configure API keys in settings");
      this._models.defaultModel = null;
    } else {
      const chatRef = this.agent.config?.models?.chat;
      const ref = (typeof chatRef === "object" && chatRef?.id && chatRef?.provider) ? chatRef : null;
      if (!ref) {
        console.warn("[engine] models.chat is not configured or missing provider; defaultModel is null");
        this._models.defaultModel = null;
      } else {
        const model = findModel(availableModels, ref.id, ref.provider);
        if (!model) {
          console.error(`[engine] configured model "${ref.provider}/${ref.id}" is not available; defaultModel is null`);
          this._models.defaultModel = null;
        } else {
          this._models.defaultModel = model;
          log(`using model: ${model.name} (${model.provider})`);
        }
      }
    }

    // 5. Sync skills + watch skillsDir
    this._syncAllAgentSkills();
    this._skills.watch(this._resourceLoader, this._agentMgr.agents, () => {
      this._resourceLoader.getSystemPrompt = () => this.agent.systemPrompt;
      this._resourceLoader.getSkills = () => this._getSkillsForAgent(this.agent);
      this._syncAllAgentSkills();
    });

    // 7. Bridge 孤儿清理
    try { this._bridge.reconcile(); } catch {
      // Bridge reconciliation is best effort during engine refresh.
    }

 // 8. 沙盒日志
    const sandboxEnabled = this._readPreferences().sandbox !== false;
    log(`sandbox ${sandboxEnabled ? "enabled" : "disabled"}`);

 //
    this._cleanEphemeralSessions();

    const totalTime = ((Date.now() - startupTimer) / 1000).toFixed(1);
    log(`initialization completed (${totalTime}s)`);
  }

 /** */
  _cleanEphemeralSessions() {
    const maxAge = 7 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    try {
      if (!this.agentsDir || !fs.existsSync(this.agentsDir)) return;
      for (const entry of fs.readdirSync(this.agentsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const ephDir = path.join(this.agentsDir, entry.name, '.ephemeral');
        if (!fs.existsSync(ephDir)) continue;
        for (const file of fs.readdirSync(ephDir)) {
          if (!file.endsWith('.jsonl')) continue;
          const filePath = path.join(ephDir, file);
          try {
            const stat = fs.statSync(filePath);
            if (now - stat.mtimeMs > maxAge) fs.unlinkSync(filePath);
          } catch { /* best effort */ }
        }
      }
    } catch { /* best effort */ }
  }

  async dispose() {
    this._deferredResultCoordinator?.dispose?.();
    this._deferredResultCoordinator = null;
    this._media?.dispose?.();
    // Unload plugins before disposing engine resources.
    if (this._pluginManager) {
      for (const p of this._pluginManager.listPlugins()) {
        if (p.status === "loaded") {
          await this._pluginManager.unloadPlugin(p.id);
        }
      }
    }
    this._skills?.unwatch();
    await this._agentMgr.disposeAll(this._sessionCoord);
    await this._sessionCoord.cleanupSession();
    await this.disposeComputerRuntime();
    this._sessionManifestStore?.close?.();
  }

  // ════════════════════════════
 // 插件系统
  // ════════════════════════════

  /**
   * Initialize plugin system. Called after Hub construction (EventBus available).
   * @param {import('../hub/event-bus.ts').EventBus} bus
   */
  async initPlugins(bus) {
    this._media?.start?.(bus);
    const builtinPluginsDir = path.join(this.productDir, "..", "plugins");
    const userPluginsDir = path.join(this.gsapHome, "plugins");
    const pluginDataDir = path.join(this.gsapHome, "plugin-data");
    const devPluginsDir = path.join(this.gsapHome, "plugins-dev");
    const pluginDevRunDir = path.join(this.gsapHome, "plugin-dev-runs");

    // Read app version for plugin compatibility check
    let appVersion = "0.0.0";
    try {
      const pkgPath = path.join(this.productDir, "..", "package.json");
      appVersion = JSON.parse(fs.readFileSync(pkgPath, "utf-8")).version || "0.0.0";
    } catch {
      // Ignore plugin extension wiring failures and continue startup.
    }

    this._pluginManager = new PluginManager({
      pluginsDirs: [builtinPluginsDir, userPluginsDir],
      pluginsDir: userPluginsDir,
      dataDir: pluginDataDir,
      bus,
      preferencesManager: this._prefs,
      appVersion,
      getSessionPath: () => this.currentSessionPath,
      getWorkspaceDir: () => this.deskCwd || this.defaultDeskCwd || this.homeCwd || null,
      registerSessionFile: (entry) => this.registerSessionFile(entry),
      emitResourceChanged: (input) => this.emitResourceChanged(input),
      resourceIO: () => this.getResourceIO(),
      slashRegistry: this._slashSystem?.registry ?? null,
      logSink: (entry) => this._emitEvent({ type: "plugin_log", ...entry }, null),
      runtimeContext: this.getRuntimeContext(),
    });
    this._pluginManager.scan();
    await this._pluginManager.loadAll();

    this._pluginDevService?.unregisterEventBusHandlers?.();
    const allowedPluginDevSourceRoots = [
      this.productDir,
      path.dirname(this.productDir),
      this.gsapHome,
      os.homedir(),
    ].filter(Boolean);
    this._pluginDevService = new PluginDevService({
      pluginManager: this._pluginManager,
      devPluginsDir,
      runDataDir: pluginDevRunDir,
      allowedSourceRoots: allowedPluginDevSourceRoots,
      syncPluginExtensions: () => this.syncPluginExtensions(),
    });
    if (bus && typeof bus.handle === "function") {
      this._pluginDevService.registerEventBusHandlers(bus);
    }

    if (this._skills) {
      await this.syncWorkspaceSkillPaths(this.currentSessionPath ? this.cwd : null, {
        reload: true,
        emitEvent: false,
      });
    }

    // Inject plugin extension factories into ResourceLoader (same array reference)
    await this.syncPluginExtensions();
  }

  /**
  * */
  _syncExtensionFactories() {
    if (!this._extensionFactories) return;
    const frameworkFactories = this._frameworkExtFactories || [];
    const pluginFactories = this._pluginManager?.getExtensionFactories() || [];
    const baseCount = this._baseExtensionFactoryCount || 1;
    this._extensionFactories.splice(baseCount, Infinity, ...frameworkFactories, ...pluginFactories);
  }

  async _reloadResourceLoaderForExtensionFactories() {
    if (!this._resourceLoader?.reload) return;
    await this._resourceLoader.reload();
  }

  /**
   * Register a framework-level extension factory.
   * Tracked separately so _syncExtensionFactories preserves them across plugin hot-reloads.
   * Only affects sessions created after this call.
   */
  async registerExtensionFactory(factory) {
    if (!this._extensionFactories) return;
    if (!this._frameworkExtFactories) this._frameworkExtFactories = [];
    this._frameworkExtFactories.push(factory);
    await this.syncPluginExtensions();
  }

  get pluginManager() { return this._pluginManager; }
  get pluginDevService() { return this._pluginDevService; }
  getLicenseStatus() {
    return professionalEditionStatus();
  }
  activateLicense(_license) {
    return {
      ...professionalFeatureDisabled(PROFESSIONAL_DISABLED_FEATURES.licenseActivation),
      status: this.getLicenseStatus(),
    };
  }
  activateLicenseFile(_filePath) {
    return {
      ...professionalFeatureDisabled(PROFESSIONAL_DISABLED_FEATURES.licenseActivation),
      status: this.getLicenseStatus(),
    };
  }
  checkLicenseRouteAccess(_input = {}) {
    return { allowed: true, status: 200, code: "professional_edition" };
  }
  getPluginInstallRecord(pluginId) { return this._pluginInstallRecords.get(pluginId); }
  recordPluginInstall(record) { return this._pluginInstallRecords.recordInstall(record); }

 /** */
  async syncPluginExtensions() {
    this._syncExtensionFactories();
    await this._reloadResourceLoaderForExtensionFactories();
    await this._sessionCoord?.reloadExtensionRunners?.("plugin_extension_sync");
  }

  // ════════════════════════════
  //  工具构建
  // ════════════════════════════

  buildTools(cwd, customTools, opts: BuildToolsOptions = {}) {
    let ct = customTools;
    let agentId;
    let toolAgent;
    if (!ct) {
 //
      if (opts.agentDir) {
        const dirAgentId = path.basename(opts.agentDir);
        const dirAgent = this.getAgent(dirAgentId);
        if (!dirAgent) throw new Error(`buildTools: agent "${dirAgentId}" not found`);
        ct = dirAgent.tools;
        agentId = dirAgentId;
        toolAgent = dirAgent;
      } else {
        ct = this.agent.tools;
        agentId = this.agent?.id || "";
        toolAgent = this.agent;
      }
    } else {
      agentId = opts.agentDir ? path.basename(opts.agentDir) : (this.agent?.id || "");
      toolAgent = opts.agentDir ? this.getAgent(agentId) : this.agent;
    }
    const effectiveAgentDir = opts.agentDir || this.agent.agentDir;
    const effectiveWorkspace = opts.workspace !== undefined ? opts.workspace : this.homeCwd;
    const workspaceFolders = opts.workspaceFolders || [];
    const staticAuthorizedFolders = Array.isArray(opts.authorizedFolders) ? opts.authorizedFolders : [];
    const getAuthorizedFolders = typeof opts.getAuthorizedFolders === "function"
      ? () => {
          const folders = opts.getAuthorizedFolders();
          return Array.isArray(folders) ? folders : [];
        }
      : () => staticAuthorizedFolders;

    // Append plugin tools
    const pluginTools = this._pluginManager?.getAllTools() || [];
    const executionBoundary = this._runtimeContext
      ? this.createExecutionBoundary({ workbenchRoot: cwd })
      : null;
    const executionScope = executionBoundary
      ? { serverNodeId: executionBoundary.serverNodeId, executionBoundary }
      : {};
    const wrappedPluginTools = pluginTools.map(t => ({
      ...t,
      _toolSource: t._toolSource || "plugin",
      execute: (toolCallId, params, ...rest) => {
        const runtimeCtx = rest.length > 0 && rest[rest.length - 1] && typeof rest[rest.length - 1] === "object"
          ? rest[rest.length - 1]
          : {};
        const traceContext = getTraceContext() || {};
        return t.execute(toolCallId, params, {
          ...traceContext,
          ...runtimeCtx,
          agentId,
          cwd,
          workspace: effectiveWorkspace,
          workspaceFolders,
          getWorkspaceDir: () => cwd || effectiveWorkspace || this.defaultDeskCwd || this.homeCwd || null,
          ...executionScope,
        });
      },
    }));
    const pluginDevTools = this._pluginDevService && this._prefs.getPluginDevToolsEnabled?.() === true
      ? createPluginDevTools({
          pluginDevService: this._pluginDevService,
          getAgentId: () => agentId,
        })
      : [];
    const candidateTools = [...ct, ...wrappedPluginTools, ...pluginDevTools];
    const allTools = filterToolObjectsByAvailability(
      candidateTools,
      toolAgent?.config || {},
      {
        agentId,
        channelsEnabled: resolveChannelsEnabledForToolAvailability(this),
      },
      {
        warn: (msg) => console.warn(`[tool-availability] ${msg}`),
        extraDisabled: [],
      },
    );

    const getSessionPath = opts.getSessionPath || (() => null);
    const fileReadSessionPaths = Array.isArray(opts.fileReadSessionPaths)
      ? opts.fileReadSessionPaths.filter((sp): sp is string => typeof sp === "string" && sp.trim().length > 0)
      : [];
    const getExternalReadPaths = () => {
      const sessionPaths: string[] = [];
      const seenSessionPaths = new Set<string>();
      const addSessionPath = (sp) => {
        if (!sp || seenSessionPaths.has(sp)) return;
        seenSessionPaths.add(sp);
        sessionPaths.push(sp);
      };
      addSessionPath(getSessionPath());
      for (const sp of fileReadSessionPaths) addSessionPath(sp);
      if (!sessionPaths.length) return [];
      const files = sessionPaths.flatMap((sp) => this.listSessionFiles(sp));
      return externalReadPathsFromSessionFiles(files, {
        workspaceRoots: workspaceRootsForSandbox(
          effectiveWorkspace,
          workspaceFolders,
          getAuthorizedFolders(),
        ),
        gsapHome: this.gsapHome,
      });
    };
    const getPermissionMode = typeof opts.getPermissionMode === "function"
      ? opts.getPermissionMode
      : (sessionPath) => this.getSessionPermissionMode(sessionPath);
    const getTraceContext = typeof opts.getTraceContext === "function"
      ? opts.getTraceContext
      : () => null;
    const recordToolCall = (entry) => {
      try {
        return this._runtimeTraceStore?.recordToolCall(entry);
      } catch {
        return null;
      }
    };

    let result = createSandboxedTools(cwd, allTools, {
      agentDir: effectiveAgentDir,
      workspace: effectiveWorkspace,
      workspaceFolders,
      authorizedFolders: staticAuthorizedFolders,
      getAuthorizedFolders,
      gsapHome: this.gsapHome,
      executionBoundary,
      getTraceContext,
      recordToolCall,
      getSandboxEnabled: () => this._readPreferences().sandbox !== false,
      getSandboxNetworkEnabled: () => process.platform === "win32"
        ? true
        : this._readPreferences().sandbox_network !== false,
      getExternalReadPaths,
      getSessionPath,
      resolveSessionFile: (fileId, options) => this.getSessionFile(fileId, options),
      recordFileOperation: (entry) => this.recordSessionFileOperation(entry),
      getVisionBridge: () => this.getVisionBridge(),
      isVisionAuxiliaryEnabled: () => this.isVisionAuxiliaryEnabled(),
      emitEvent: (event, sessionPath) => this._emitEvent(event, sessionPath),
    } as unknown as Parameters<typeof createSandboxedTools>[2]);

    // Checkpoint wrapper (outside sandbox layer)
    const backupCfg = this._prefs.getFileBackup();
    if (backupCfg.enabled) {
      result = {
        ...result,
        tools: wrapWithCheckpoint(result.tools, {
          store: this._checkpointStore,
          maxFileSizeKb: backupCfg.max_file_size_kb,
          cwd,
          getSessionPath,
        }),
      };
    }

    result = {
      ...result,
      tools: wrapWithSessionPermission(result.tools, {
        getSessionPath,
        getPermissionMode,
        permissionContext: opts.permissionContext || null,
        getTraceContext,
        recordToolCall,
        cwd,
        getSessionCwd: (sessionPath) => this.getSessionCwd(sessionPath),
        getSessionWorkspaceFolders: (sessionPath) => this.getSessionWorkspaceFolders(sessionPath),
        getSessionAuthorizedFolders: (sessionPath) => this.getSessionAuthorizedFolders(sessionPath),
        getConfirmStore: () => this._confirmStore,
        getApprovalGateway: () => this._approvalGateway,
        emitEvent: (event, sessionPath) => this._emitEvent(event, sessionPath),
      }),
      customTools: wrapWithSessionPermission(result.customTools, {
        getSessionPath,
        getPermissionMode,
        permissionContext: opts.permissionContext || null,
        getTraceContext,
        recordToolCall,
        cwd,
        getSessionCwd: (sessionPath) => this.getSessionCwd(sessionPath),
        getSessionWorkspaceFolders: (sessionPath) => this.getSessionWorkspaceFolders(sessionPath),
        getSessionAuthorizedFolders: (sessionPath) => this.getSessionAuthorizedFolders(sessionPath),
        getConfirmStore: () => this._confirmStore,
        getApprovalGateway: () => this._approvalGateway,
        emitEvent: (event, sessionPath) => this._emitEvent(event, sessionPath),
      }),
    };

    // Startup assertion: every built-in tool must be categorized in
    // shared/tool-categories.ts. All session-creation paths route through
    // this function, so a single check here catches the whole surface.
    assertAllToolsCategorized([
      ...result.tools.map((t) => t.name).filter(Boolean),
      ...ct
        .filter((t) => !t._pluginId)
        .map((t) => t.name)
        .filter(Boolean),
    ]);

    return result;
  }

  // ════════════════════════════
 // 事件系统
  // ════════════════════════════

  /**
  * */
  setHubCallbacks(callbacks) {
    this._hubCallbacks = callbacks;
    this._slashSystem?.dispatcher?.setHub?.(callbacks?.hub || null);
  }

  setEventBus(bus) {
    for (const fn of this._listeners) bus.subscribe(fn);
    this._listeners.clear();
    this._eventBus = bus;
  }

  getEventBus() {
    return this._eventBus;
  }

  subscribe(listener) {
    if (this._eventBus) return this._eventBus.subscribe(listener);
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  _emitEvent(event, sessionPath) {
    if (this._eventBus) {
      this._eventBus.emit(event, sessionPath);
    } else {
      for (const fn of this._listeners) {
        try { fn(event, sessionPath); } catch {
          // Ignore listener errors so other listeners still receive the event.
        }
      }
    }
  }

  emitEvent(event, sessionPath) { this._emitEvent(event, sessionPath); }

  emitDevLog(text, level = "info") {
    const entry = { text, level, ts: Date.now() };
    this._devLogs.push(entry);
    if (this._devLogs.length > this._devLogsMax) {
      this._devLogs.shift();
    }
    const dl = debugLog();
    if (dl) {
      if (level === "error") dl.error("engine", text);
      else dl.log("engine", text);
    }
    this._emitEvent({ type: "devlog", text, level }, null);
  }

  getDevLogs() {
    return this._devLogs;
  }

  // ════════════════════════════
 // 日记 / 工具调用
  // ════════════════════════════

  async writeDiary(options: DynamicOptions = {}) {
    const currentPath = this.currentSessionPath;
    if (currentPath && this.agent.memoryTicker) {
      await this.agent.memoryTicker.flushSession(currentPath);
    }
    const { writeDiary } = await import("../lib/diary/diary-writer.ts");
    const diaryModelId = this.agent.config?.models?.chat || this.agent.memoryModel;
    const resolvedModel = {
      ...this._models.resolveModelWithCredentials(diaryModelId),
      usageLedger: this._usageLedger,
    };
    const agent = this.agent;
    return writeDiary({
      summaryManager: agent.summaryManager,
      resolvedModel,
      agentPersonality: agent.personality,
      memory: (() => {
        try { return fs.readFileSync(agent.memoryMdPath, "utf-8"); } catch { return ""; }
      })(),
      userName: agent.userName,
      agentName: agent.agentName,
      cwd: this.homeCwd || process.cwd(),
      activityStore: this.activityStore,
      todayMdPath: agent.todayMdPath,
      sessionDir: agent.sessionDir,
      targetDate: options.targetDate,
      isSessionMemoryEnabledForPath: (sessionPath) => {
        return agent.isSessionMemoryEnabledFor(sessionPath);
      },
      getCompactionAuth: async (model) => {
        const auth = await this._models.modelRegistry.getApiKeyAndHeaders(model);
        if (!auth.ok) {
          throw new Error(`Auth failed for model ${model.id}: ${auth.error}`);
        }
        if (!auth.apiKey) {
          throw new Error(`No API key for provider ${model.provider}`);
        }
        return { apiKey: auth.apiKey, headers: auth.headers };
      },
    });
  }

  async summarizeTitle(ut, at, opts) {
    return _summarizeTitle(this.resolveUtilityConfig(this._utilityOptionsForContext(opts)), ut, at, opts);
  }

  async translateSkillNames(names, lang, opts: UtilityContextOptions & { skills?: unknown[] } = {}) {
    const skills = Array.isArray(opts.skills)
      ? opts.skills
      : (opts.agentId ? this.getAllSkills(opts.agentId) : []);
    return translateSkillNamesWithCache({
      cachePath: getSkillNameTranslationCachePath(this.gsapHome),
      skills,
      names,
      lang,
      translateMissing: (missingNames) => _translateSkillNames(
        this.resolveUtilityConfig(opts.agentId ? { agentId: opts.agentId } : undefined),
        missingNames,
        lang,
      ),
    });
  }

  async summarizeActivity(sp, preloaded, opts: UtilityContextOptions = {}) {
    const utilityOptions = this._utilityOptionsForContext({ ...opts, sessionPath: opts.sessionPath || sp });
    return _summarizeActivity(this.resolveUtilityConfig(utilityOptions), sp, (msg) => this.emitDevLog(msg), preloaded);
  }

  async summarizeActivityQuick(activityId) {
    let entry = null, foundAgentId = null;
    for (const [agId] of this._agentMgr.agents) {
      const store = this.getActivityStore(agId);
      const e = store?.get(activityId);
      if (e) { entry = e; foundAgentId = agId; break; }
    }
    if (!entry?.sessionFile) return null;
    const sessionPath = path.join(this.agentsDir, foundAgentId, "activity", entry.sessionFile);
    return _summarizeActivityQuick(this.resolveUtilityConfig({ agentId: foundAgentId }), sessionPath);
  }

  _utilityOptionsForContext(opts: UtilityContextOptions = {}) {
    if (opts?.agentId) return { agentId: opts.agentId };
    if (opts?.sessionPath) {
      const agentId = this.agentIdFromSessionPath(opts.sessionPath);
      if (agentId) return { agentId };
    }
    return undefined;
  }

  // ════════════════════════════
  //  Desk 辅助
  // ════════════════════════════

  listDeskFiles() {
    try {
      const dir = this.homeCwd;
      if (!dir || !fs.existsSync(dir)) return [];
      return fs.readdirSync(dir, { withFileTypes: true })
        .filter(e => !e.name.startsWith("."))
        .map(e => {
          const fp = path.join(dir, e.name);
          let mtime = 0;
          try { mtime = fs.statSync(fp).mtimeMs; } catch {
            // Ignore files that disappear while scanning.
          }
          return { name: e.name, isDir: e.isDirectory(), mtime };
        });
    } catch {
      return [];
    }
  }

  // ════════════════════════════
  //  Preferences 代理
  // ════════════════════════════

  get defaultDeskCwd() {
    return this.homeCwd || null;
  }

  _realPathForWorkspaceCheck(p) {
    if (!p || typeof p !== "string") return null;
    try {
      return fs.realpathSync(p);
    } catch {
      try {
        return fs.realpathSync(path.dirname(p));
      } catch {
        return null;
      }
    }
  }

  isApprovedWorkspaceDir(dir) {
    const resolved = this._realPathForWorkspaceCheck(dir);
    if (!resolved) return false;
    const roots = [
      this.homeCwd,
      this.deskCwd,
      ...this.getSessionWorkspaceFolders(this.currentSessionPath),
    ].filter(Boolean);
    return roots.some((root) => {
      const base = this._realPathForWorkspaceCheck(root);
      if (!base) return false;
      return resolved === base || resolved.startsWith(base + path.sep);
    });
  }

  isApprovedDeskDir(dir) {
    const resolved = this._realPathForWorkspaceCheck(dir);
    if (!resolved) return false;
    const roots = [
      this.homeCwd,
      this.deskCwd,
      ...this.getSessionWorkspaceFolders(this.currentSessionPath),
      ...(Array.isArray(this.config?.cwd_history) ? this.config.cwd_history : []),
    ].filter(Boolean);
    return roots.some((root) => {
      const base = this._realPathForWorkspaceCheck(root);
      if (!base) return false;
      return resolved === base || resolved.startsWith(base + path.sep);
    });
  }

  _readPreferences() { return this._prefs.getPreferences(); }
  _writePreferences(prefs) { return this._prefs.savePreferences(prefs); }
  _readPrimaryAgent() { return this._prefs.getPrimaryAgent(); }
  _savePrimaryAgent(agentId) { return this._prefs.savePrimaryAgent(agentId); }



  static PATROL_TOOLS_DEFAULT = "*";
}

export const HanaEngine = GsapEngine;
