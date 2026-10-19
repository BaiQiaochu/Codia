// @ts-nocheck
/**
  *
 *
  *
 */
import fs from "fs";
import path from "path";
import { loadConfig, saveConfig } from "../lib/memory/config-loader.ts";
import { safeReadFile, safeReadJSON } from "../shared/safe-fs.ts";
import { FactStore } from "../lib/memory/fact-store.ts";
import { SessionSummaryManager } from "../lib/memory/session-summary.ts";
import { createMemoryTicker } from "../lib/memory/memory-ticker.ts";
import { createMemorySearchTool } from "../lib/memory/memory-search.ts";
import { boundMemoryText } from "../lib/memory/query-service.ts";
import { buildTrustedMemoryContext } from "../lib/memory/runtime-context.ts";
import { isCompiledMemoryEligible } from "../lib/memory/compiled-memory-state.ts";
import { memoryGenerationMarker, sanitizeMemoryPrompt, getCompiledPromptGeneration } from "../lib/memory/prompt-guard.ts";
import { createWebSearchTool } from "../lib/tools/web-search.ts";
import { createTodoTool } from "../lib/tools/todo.ts";
import { createDeskManager } from "../lib/desk/desk-manager.ts";
import { CronStore } from "../lib/desk/cron-store.ts";
import { createAutomationTool } from "../lib/tools/automation-tool.ts";
import { createWebFetchTool } from "../lib/tools/web-fetch.ts";
import { createStageFilesTool } from "../lib/tools/output-file-tool.ts";
import { createFileTool } from "../lib/tools/file-tool.ts";
import { createArtifactTool } from "../lib/tools/artifact-tool.ts";
import { createChannelTool } from "../lib/tools/channel-tool.ts";
import { createDmTool } from "../lib/tools/dm-tool.ts";
import { createBrowserTool } from "../lib/tools/browser-tool.ts";
import { createComputerUseTool } from "../lib/tools/computer-use-tool.ts";
import { createPinnedMemoryTools } from "../lib/tools/pinned-memory.ts";
import { createExperienceTools } from "../lib/tools/experience.ts";
import { createInstallSkillTool } from "../lib/tools/install-skill.ts";
import { createNotifyTool } from "../lib/tools/notify-tool.ts";
import { createUpdateSettingsTool } from "../lib/tools/update-settings-tool.ts";
import { createSessionFoldersTool } from "../lib/tools/session-folders-tool.ts";
import {
  createSubagentCloseTool,
  createSubagentReplyTool,
  createSubagentTool,
} from "../lib/tools/subagent-tool.ts";
import { writeSubagentSessionMeta } from "../lib/subagent-executor-metadata.ts";
import { createCheckDeferredTool } from "../lib/tools/check-deferred-tool.ts";
import { createWaitTool } from "../lib/tools/wait-tool.ts";
import { createStopTaskTool } from "../lib/tools/stop-task-tool.ts";
import { createHermesAgentTool } from "../lib/tools/hermes-agent-tool.ts";
import { createCurrentStatusTool } from "../lib/tools/current-status-tool.ts";
import { createTerminalTool } from "../lib/tools/terminal-tool.ts";
import { createWorkflowTool } from "../lib/tools/workflow-tool.ts";
import { createCardGuideTool } from "../lib/tools/card-guide-tool.ts";
import { createShowCardTool } from "../lib/tools/show-card-tool.ts";
import { runCompatChecks } from "../lib/compat/index.ts";
import {
  CACHE_SNAPSHOT_EXPERIMENT_ID,
  EDITABLE_MEMORY_EXPERIMENT_ID,
  getResolvedExperimentValue,
} from "../lib/experiments/registry.ts";
import { getPlatformPromptNote } from "./platform-prompt.ts";
import { callText } from "./llm-client.ts";
import { fillAgentTemplate, readEditablePromptSync } from "../server/utils/agent-template.ts";
import { modelSupportsDirectImageInput } from "../shared/model-capabilities.ts";
import { assertAgentConfigPatchYuan, getAgentConfigRepairState } from "./yuan-registry.ts";
import {
  collectWorkspaceInstructionFiles,
  formatWorkspaceInstructionFiles,
} from "./workspace-instruction-files.ts";
import {
  formatAgentAppearancePrompt,
  hasAgentAppearanceSummaryCapability,
  readCachedAgentAppearanceSummary,
  refreshAgentAppearanceSummary,
} from "../lib/agent-appearance-summary.ts";
import { userProfilePath } from "../lib/user-profile-store.ts";

function isExplicitTextOnlyModel(model) {
  return Array.isArray(model?.input) && !modelSupportsDirectImageInput(model);
}

export class Agent {
  /**
   * @param {object} opts
  *
 * @param {string} opts.productDir - 产品模板目录（ishiki.example.md, yuan 模板等）
  *
   */
  constructor({ id, agentDir, agentsDir, productDir, userDir, channelsDir, searchConfigResolver }) {
    const resolvedAgentDir = agentDir ? path.resolve(agentDir) : null;
    const resolvedAgentsDir = agentsDir || (resolvedAgentDir ? path.dirname(resolvedAgentDir) : null);
    const resolvedId = id || (resolvedAgentDir ? path.basename(resolvedAgentDir) : null);

    if (!resolvedId) throw new Error("Agent: id is required");
    if (!resolvedAgentsDir) throw new Error("Agent: agentsDir is required");

 //
    this.id = resolvedId;
    this.agentsDir = resolvedAgentsDir;
    this.agentDir = path.join(resolvedAgentsDir, resolvedId);
    this.productDir = productDir;
    this.userDir = userDir;
    this.channelsDir = channelsDir || null;
    this._searchConfigResolver = searchConfigResolver || null;

 // 路径（全部从 this.agentDir 派生-
    this.configPath = path.join(this.agentDir, "config.yaml");
    this.factsDbPath = path.join(this.agentDir, "memory", "facts.db");
    this.memoryMdPath = path.join(this.agentDir, "memory", "memory.md");
    this.todayMdPath    = path.join(this.agentDir, "memory", "today.md");
    this.weekMdPath     = path.join(this.agentDir, "memory", "week.md");
    this.longtermMdPath = path.join(this.agentDir, "memory", "longterm.md");
    this.factsMdPath    = path.join(this.agentDir, "memory", "facts.md");
    this.summariesDir = path.join(this.agentDir, "memory", "summaries");
    this.sessionDir = path.join(this.agentDir, "sessions");
    this.deskDir = path.join(this.agentDir, "desk");

 // 身份（init 后从 config 填充-
    this.userName = "User";
    this.agentName = "助手";

 // 运行时状-
    this._config = null;
    this._factStore = null;
    this._summaryManager = null;
    this._memoryTicker = null;
    this._startupMemoryTickTimer = null;
    this._memorySearchTool = null;
    this._webSearchTool = null;
    this._webFetchTool = null;
    this._todoTool = null;
    this._pinnedMemoryTools = [];
    this._experienceTools = [];
    this._memoryMasterEnabled = true;   // agent 级别总开关（config.yaml memory.enabled）
    this._memorySessionEnabled = true;  // per-session 开关（WelcomeScreen toggle）
    this._experienceEnabled = false;
    this._enabledSkills = [];
    this._systemPrompt = "";
    this._descriptionRefreshHandler = null;
    this._runtimeInitialized = false;
    this._repairState = null;

 // Desk 系统（与 memory 完全独立-
    this._deskManager = null;
    this._cronStore = null;
    this._automationTool = null;
    this._stageFilesTool = null;
    this._fileTool = null;
    this._artifactTool = null;
    this._channelTool = null;
    this._browserTool = null;
    this._browserToolNoScreenshot = null;
    this._computerUseTool = null;
    this._notifyTool = null;
    this._stopTaskTool = null;
    this._currentStatusTool = null;
    this._sessionFoldersTool = null;
    this._terminalTool = null;
    this._cardGuideTool = null;
    this._showCardTool = null;

    /**
  *
     */
    this._cb = null;
  }

  // ════════════════════════════
 // 生命周期
  // ════════════════════════════

  /**
  *
   * @param {(msg: string) => void} [log]
  *
 * @param {(bareId: string, agentConfig: object) => object} [resolveModel] - 统一模型解析回调
   */
  /**
  *
 * agent.config.models.chat 仍能被下游正确读取（模型解析 / session 创建）-
  *
   */
  loadConfigOnly() {
    this._config = loadConfig(this.configPath);
    const isZh = String(this._locale()).startsWith("zh");
    this.userName = this._config.user?.name || (isZh ? "用户" : "User");
    this.agentName = this._config.agent?.name || "助手";
    this._memoryMasterEnabled = this._config.memory?.enabled !== false;
    this._experienceEnabled = this._config.experience?.enabled === true;
    this._refreshRepairState();
  }

  async init(log = () => {}, sharedModels = {}, resolveModel = null) {
    if (this._runtimeInitialized) return;

 // 0. 兼容性检查（目录、数据库、配置文件）
    await runCompatChecks({
      agentDir: this.agentDir,
      codiaHome: path.dirname(path.dirname(this.agentDir)),
      log,
    });

    // 1. Load configuration.
    log(`  [agent] 1. loadConfig...`);
    this._config = loadConfig(this.configPath);
    log(`  [agent] 1. loadConfig done`);

    // 2. Identity and memory switches.
    const isZh = String(this._locale()).startsWith("zh");
    this.userName = this._config.user?.name || (isZh ? "??" : "User");
    this.agentName = this._config.agent?.name || "助手";
    this._memoryMasterEnabled = this._config.memory?.enabled !== false;
    this._experienceEnabled = this._config.experience?.enabled === true;
    this._refreshRepairState();
    if (this._repairState) {
      throw new Error(`Agent config needs repair: ${this._repairState.message}`);
    }

    // 3. Initialize modules.
    log(`  [agent] 3. modules initialized`);

    // 4. Memory v2: FactStore + SessionSummaryManager + ticker.
    log(`  [agent] 4. FactStore...`);
    fs.mkdirSync(path.join(this.agentDir, "memory", "summaries"), { recursive: true });
    this._factStore = new FactStore(this.factsDbPath);
    this._summaryManager = new SessionSummaryManager(this.summariesDir);
    this._factStore.onInvalidated = () => {
      this._summaryManager?.clearCache?.();
      this._systemPrompt = sanitizeMemoryPrompt(this._systemPrompt || '', path.dirname(this.memoryMdPath));
    };

    // v1 -> v2 migration: import the legacy memories.db once if present.
    const oldMemoriesPath = path.join(this.agentDir, "memory", "memories.db");
    const migrationDone = path.join(this.agentDir, "memory", ".v2-migrated");
    if (!fs.existsSync(migrationDone) && fs.existsSync(oldMemoriesPath)) {
      try {
        log(`  [agent] 4. v1->v2 migration: found memories.db, importing...`);
        const Database = (await import("better-sqlite3")).default;
        const oldDb = new Database(oldMemoriesPath, { readonly: true });
        const rows = oldDb.prepare("SELECT content, tags, date, created_at FROM memories").all();
        oldDb.close();

        if (rows.length > 0) {
          const facts = rows.map(row => ({
            fact: row.content,
            tags: (() => { try { return JSON.parse(row.tags); } catch { return []; } })(),
            time: row.date ? row.date + "T00:00" : null,
            session_id: "v1-migration",
          }));
          this._factStore.addBatch(facts);
          log(`  [agent] 4. v1->v2 migration done: imported ${facts.length} memories into facts.db`);
        }
        // Mark migration as complete even when there are no rows.
        fs.writeFileSync(migrationDone, new Date().toISOString());
      } catch (err) {
        console.error(`[agent] v1->v2 migration failed; startup will continue: ${err.message}`);
        // Keep startup resilient; a later manual repair can retry by removing the marker.
        try { fs.writeFileSync(migrationDone, `failed: ${err.message}`); } catch {}
      }
    }

    log(`  [agent] 4. FactStore + SummaryManager done`);

    // Utility models fall back to the chat model when they are not configured.
    const chatModelRef = this._config?.models?.chat || null;
    const userSetUtility = sharedModels.utility || this._config?.models?.utility || null;
    const userSetUtilityLarge = sharedModels.utility_large || this._config?.models?.utility_large || null;

    this._utilityModel = userSetUtility || chatModelRef;
    this._memoryModel = userSetUtilityLarge || chatModelRef;

    if (!userSetUtility && chatModelRef) {
      console.log(`[agent] utility model is not configured; using the chat model for tools`);
    }
    if (!userSetUtilityLarge && chatModelRef) {
      console.log(`[agent] utility_large model is not configured; using the chat model for memory`);
    }

    // Keep the resolver so memory ticks use fresh provider settings.
    // Do not cache resolved credentials; provider key/url/api changes recover without restarting the agent.
    this._resolveModel = resolveModel || null;

    // Probe resolution once at startup only to emit an early warning; runtime calls stay guarded by ticker try/catch.
    if (this._memoryModel && this._resolveModel) {
      try {
        this._resolveModel(this._memoryModel, this._config);
      } catch (err) {
        const src = userSetUtilityLarge ? "utility_large" : "chat model fallback";
        console.warn(`[memory] ${src} resolution failed; memory is temporarily unavailable and will recover after provider settings are fixed: ${err.message}`);
        this._cb?.emitDevLog?.(`Memory temporarily unavailable: ${src} resolution failed - ${err.message}`, "warn");
      }
    } else if (!this._memoryModel) {
      console.warn("[memory] memory system not started: utility_large is not configured and no chat model fallback is available");
      this._cb?.emitDevLog?.("Memory system not started: no utility_large model and no chat model fallback", "warn");
    }

    if (this._memoryModel && this._resolveModel) {
      log(`  [agent] 4. memoryTicker...`);
      this._memoryTicker = createMemoryTicker({
        agentId: this.id,
        agentDir: this.agentDir,
        summaryManager: this._summaryManager,
        configPath: this.configPath,
        factStore: this._factStore,
 //
        getResolvedMemoryModel: () => ({
          ...this._resolveModel(this._memoryModel, this._config),
          usageLedger: this._cb?.getEngine?.()?.usageLedger,
        }),
        getMemoryMasterEnabled: () => this._memoryMasterEnabled,
        getExperienceEnabled: () => this._experienceEnabled === true,
        isSessionMemoryEnabled: (sessionPath) => this.isSessionMemoryEnabledFor(sessionPath),
        getCacheSnapshotReflectionMode: () => (
          getResolvedExperimentValue(this._cb?.getEngine?.()?.preferences, CACHE_SNAPSHOT_EXPERIMENT_ID)
        ),
        getEditableMemoryEnabled: () => (
          getResolvedExperimentValue(this._cb?.getEngine?.()?.preferences, EDITABLE_MEMORY_EXPERIMENT_ID) === true
        ),
        buildSessionCacheSnapshot: (sessionPath, options) => (
          this._cb?.getEngine?.()?.buildSessionCacheSnapshot?.(sessionPath, options)
        ),
        getBridgeContextForSessionPath: (sessionPath) => this._cb?.getEngine?.()?.getBridgeContextForSessionPath?.(sessionPath),
        getSessionStreamFn: (sessionPath) => (
          this._cb?.getEngine?.()?.getSessionByPath?.(sessionPath)?.agent?.streamFn || null
        ),
        onCompiled: () => {
 // _systemPrompt 是非 session 路径（巡棢/cron/频道/DM/bridge owner 新建-
 //
          this._systemPrompt = this.buildSystemPrompt({ forceMemoryEnabled: this._memoryMasterEnabled });
          console.log(`[${this.agentName}] 记忆编译完成，system prompt 已刷新`);
        },
        sessionDir: this.sessionDir,
        memoryMdPath: this.memoryMdPath,
        todayMdPath: this.todayMdPath,
        weekMdPath: this.weekMdPath,
        longtermMdPath: this.longtermMdPath,
        factsMdPath: this.factsMdPath,
      });
      log(`  [agent] 4. memoryTicker 创建完成`);

 // 5. 延迟跑首-tick，避免启动后和用户第丢轮请求抢同一个模型供应商-
      log(`  [agent] 5. 后台 tick...`);
      // AgentManager schedules the first tick after runtime initialization is complete.

 // 6. 启动定时调度
      this._memoryTicker.start();
    } else {
      console.warn(`[agent] 未配置 utility 模型，记忆系统暂不可用（用户可在设置中配置后重启）`);
    }

 //
    log(`  [agent] 7. 创建工具...`);
    const getMemoryRuntimeContext = (ctx) => buildTrustedMemoryContext({
      runtimeContext: ctx, cwd: this._cb?.getCwd?.(),
      bridgeMetadata: this._cb?.getEngine?.()?.getBridgeContextForSessionPath?.(ctx?.sessionManager?.getSessionFile?.() || ctx?.sessionPath),
      appVersion: this.productDir ? safeReadJSON(path.join(this.productDir, '..', 'package.json'), {})?.version || null : null,
    });
    this._memorySearchTool = createMemorySearchTool(this._factStore, { getContext: getMemoryRuntimeContext });
    this._webSearchTool = createWebSearchTool({
      configPath: this.configPath,
      searchConfigResolver: this._searchConfigResolver,
    });
    this._webFetchTool = createWebFetchTool();
    this._todoTool = createTodoTool();
    this._cardGuideTool = createCardGuideTool();
    this._showCardTool = createShowCardTool();
    this._pinnedMemoryTools = createPinnedMemoryTools(this.agentDir);
    this._experienceTools = createExperienceTools(this.agentDir, {
      isEnabled: () => this._experienceEnabled === true,
      getContext: getMemoryRuntimeContext,
    });

 // 8. Desk 系统（与 memory 完全独立-
    log(`  [agent] 8. Desk 系统...`);
    this._deskManager = createDeskManager(this.deskDir);
    this._deskManager.ensureDir();
    this._cronStore = this._cb?.getStudioCronStore?.() || new CronStore(
      path.join(this.deskDir, "cron-jobs.json"),
      path.join(this.deskDir, "cron-runs"),
    );
    this._automationTool = createAutomationTool(this._cronStore, {
      getAutoApprove: () => false,
      confirmStore: this._cb?.getConfirmStore?.(),
      getConfirmStore: () => this._cb?.getConfirmStore?.(),
      emitEvent: (event, sp) => { if (sp) this._cb?.emitEvent?.(event, sp); },
      getSessionPath: () => this._cb?.getCurrentSessionPath?.(),
      getAgentId: () => this.id,
      getSessionCwd: (sp) => this._cb?.getSessionCwd?.(sp),
      getSessionWorkspaceFolders: (sp) => this._cb?.getSessionWorkspaceFolders?.(sp) || [],
      getHomeCwd: (agentId) => this._cb?.getHomeCwd?.(agentId),
    });
    this._stageFilesTool = createStageFilesTool({
      registerSessionFile: (entry) => this._cb?.registerSessionFile?.(entry),
      getSessionPath: () => this._cb?.getCurrentSessionPath?.(),
    });
    this._fileTool = createFileTool({
      getCwd: () => this._cb?.getCwd?.() || this.agentDir,
      getSessionPath: () => this._cb?.getCurrentSessionPath?.(),
      resolveSessionFile: (fileId, options = {}) => this._cb?.getEngine?.()?.getSessionFile?.(fileId, options) || null,
      registerSessionFile: (entry) => this._cb?.registerSessionFile?.(entry),
    });
    this._artifactTool = createArtifactTool({
      getCodiaHome: () => this._cb?.getEngine?.()?.codiaHome,
      registerSessionFile: (entry) => this._cb?.registerSessionFile?.(entry),
      getSessionPath: () => this._cb?.getCurrentSessionPath?.(),
    });
    this._browserTool = createBrowserTool(() => this._cb?.getCurrentSessionPath?.(), {
      getSessionModel: (sessionPath) => this._cb?.getEngine?.()?.getSessionByPath?.(sessionPath)?.model || null,
      getVisionBridge: () => this._cb?.getEngine?.()?.getVisionBridge?.() || null,
      isVisionAuxiliaryEnabled: () => this._cb?.getEngine?.()?.isVisionAuxiliaryEnabled?.() === true,
      getCodiaHome: () => this._cb?.getEngine?.()?.codiaHome,
      registerSessionFile: (entry) => this._cb?.registerSessionFile?.(entry),
    });
    this._browserToolNoScreenshot = createBrowserTool(() => this._cb?.getCurrentSessionPath?.(), {
      getSessionModel: (sessionPath) => this._cb?.getEngine?.()?.getSessionByPath?.(sessionPath)?.model || null,
      getVisionBridge: () => this._cb?.getEngine?.()?.getVisionBridge?.() || null,
      isVisionAuxiliaryEnabled: () => this._cb?.getEngine?.()?.isVisionAuxiliaryEnabled?.() === true,
      getCodiaHome: () => this._cb?.getEngine?.()?.codiaHome,
      registerSessionFile: (entry) => this._cb?.registerSessionFile?.(entry),
      screenshotEnabled: false,
    });
    this._computerUseTool = createComputerUseTool({
      getComputerHost: () => this._cb?.getEngine?.()?.getComputerHost?.() || null,
      getSessionModel: (sessionPath) => this._cb?.getEngine?.()?.getSessionByPath?.(sessionPath)?.model || null,
      getAgentId: () => this.id,
      getPermissionMode: (sessionPath) => this._cb?.getEngine?.()?.getSessionPermissionMode?.(sessionPath) || null,
      getConfirmStore: () => this._cb?.getConfirmStore?.(),
      getApprovalGateway: () => this._cb?.getEngine?.()?.approvalGateway || null,
      getSessionCwd: (sessionPath) => this._cb?.getSessionCwd?.(sessionPath),
      getSessionWorkspaceFolders: (sessionPath) => this._cb?.getSessionWorkspaceFolders?.(sessionPath) || [],
      getSessionAuthorizedFolders: (sessionPath) => this._cb?.getEngine?.()?.getSessionAuthorizedFolders?.(sessionPath) || [],
      approveComputerUseApp: (approval) => this._cb?.getEngine?.()?.approveComputerUseApp?.(approval),
      emitEvent: (event, sp) => { if (sp) this._cb?.emitEvent?.(event, sp); },
      isAgentToolEnabled: () => this._isComputerUseAvailableForThisAgent(),
      isEnabledForAgentConfig: () => this._isComputerUseAvailableForThisAgent(),
    });
    this._notifyTool = createNotifyTool({
      onNotify: (payload) => this._notifyHandler?.(payload),
    });
    this._stopTaskTool = createStopTaskTool({
      getTaskRegistry: () => this._cb?.getTaskRegistry?.(),
    });

    this._checkDeferredTool = createCheckDeferredTool({
      getDeferredStore: () => this._cb?.getDeferredResults?.(),
      getSessionPath: () => this._cb?.getCurrentSessionPath?.(),
    });

    this._currentStatusTool = createCurrentStatusTool({
      getTimezone: () => this._cb?.getTimezone?.() || "",
      getAgent: () => this,
      getVisionBridge: () => this._cb?.getEngine?.()?.getVisionBridge?.() || null,
      getSessionModel: (sessionPath) => this._cb?.getEngine?.()?.getSessionByPath?.(sessionPath)?.model || null,
      getCurrentModel: () => this._cb?.getEngine?.()?.currentModel || null,
      getUiContext: (sessionPath) => this._cb?.getEngine?.()?.getUiContext?.(sessionPath) || null,
      listSessionFiles: (sessionPath) => this._cb?.getEngine?.()?.listSessionFiles?.(sessionPath) || [],
      getBridgeContext: (sessionPath) => this._cb?.getEngine?.()?.getBridgeContextForSessionPath?.(sessionPath, { agentId: this.id }) || null,
      listOpenSubagentThreads: (sessionPath) => this._cb?.getSubagentThreadStore?.()?.listOpenDirectBySession?.(sessionPath) || [],
    });

    this._sessionFoldersTool = createSessionFoldersTool({
      getEngine: () => this._cb?.getEngine?.() || null,
      getSessionPath: () => this._cb?.getCurrentSessionPath?.() || null,
      getConfirmStore: () => this._cb?.getEngine?.()?._confirmStore || null,
      emitEvent: (event, sessionPath) => {
        if (sessionPath) this._cb?.emitEvent?.(event, sessionPath);
      },
    });

    this._terminalTool = createTerminalTool({
      getTerminalSessionManager: () => this._cb?.getTerminalSessionManager?.(),
      getAgentId: () => this.id,
      getCwd: () => this._cb?.getCwd?.() || this.agentDir,
    });

    this._hermesAgentTool = createHermesAgentTool({
      resolveCwd: () => this._cb?.getCwd?.() || process.cwd(),
      resolveDefaultModel: () => {
        const engine = this._cb?.getEngine?.();
        if (!engine) return null;
        const activeModel = engine.activeSessionModel || engine.currentModel || null;
        const fallbackRef = activeModel
          ? { id: activeModel.id, provider: activeModel.provider }
          : this._config?.models?.chat || null;
        if (!fallbackRef) return null;
        try {
          return engine.resolveModelWithCredentials(fallbackRef);
        } catch {
          return null;
        }
      },
    });

    //
    this._updateSettingsTool = createUpdateSettingsTool({
      getEngine: () => this._cb?.getEngine?.(),
      getAgent: () => this,
      getConfirmStore: () => this._cb?.getConfirmStore?.(),
      getSessionPath: () => this._cb?.getCurrentSessionPath?.(),
      emitEvent: (event, sp) => { if (sp) this._cb?.emitEvent?.(event, sp); },
    });

    // 9. Channel and DM tools.
    if (this.channelsDir && this.agentsDir) {
      const agentId = this.id;
      const listAgents = () => {
        try {
          return fs.readdirSync(this.agentsDir, { withFileTypes: true })
            .filter(e => e.isDirectory() && fs.existsSync(path.join(this.agentsDir, e.name, "config.yaml")))
            .map(e => {
              try {
                const raw = fs.readFileSync(path.join(this.agentsDir, e.name, "config.yaml"), "utf-8");
                const nameMatch = raw.match(/^\s*name:\s*(.+)$/m);
                let chatModel = "";
                const chatObjMatch = raw.match(/^\s+chat:\s*\n\s+id:\s*(.+)$/m);
                if (chatObjMatch) {
                  chatModel = chatObjMatch[1].trim();
                } else {
                  const chatStrMatch = raw.match(/^\s+chat:\s+(\S.+)$/m);
                  if (chatStrMatch) chatModel = chatStrMatch[1].trim();
                }

                let summary = "";
                try {
                  const descRaw = fs.readFileSync(path.join(this.agentsDir, e.name, "description.md"), "utf-8");
                  summary = descRaw.split("\n")
                    .filter(l => !l.trim().startsWith("<!--"))
                    .join("\n").trim();
                } catch {}

                return {
                  id: e.name,
                  name: nameMatch?.[1]?.trim() || e.name,
                  summary,
                  model: chatModel,
                };
              } catch {
                return { id: e.name, name: e.name, summary: "", model: "" };
              }
            });
        } catch {
          return [];
        }
      };

      this._listAgents = listAgents;

      this._channelTool = createChannelTool({
        channelsDir: this.channelsDir,
        agentsDir: this.agentsDir,
        agentId,
        listAgents,
        isEnabled: () => this._cb?.isChannelsEnabled?.() ?? false,
        createChannelEntry: (input) => this._cb?.createChannelEntry?.(input),
        onPost: (channelName, senderId, message) => {
          this._channelPostHandler?.(channelName, senderId, message);
        },
      });

      this._dmTool = createDmTool({
        agentId,
        agentsDir: path.dirname(this.agentDir),
        listAgents,
        isEnabled: () => this._cb?.isChannelsEnabled?.() ?? false,
        onDmSent: (fromId, toId) => this._dmSentHandler?.(fromId, toId),
      });
    }

    // 10. install_skill tool.
    this._installSkillTool = createInstallSkillTool({
      agentDir: this.agentDir,
      getUserSkillsDir: () => this._cb?.getSkillsDir?.(),
      getConfig: () => {
        const cfg = { ...this._config };
        const globalLearn = this._cb?.getLearnSkills?.() || {};
        if (!cfg.capabilities) cfg.capabilities = {};
        cfg.capabilities = { ...cfg.capabilities, learn_skills: globalLearn };
        return cfg;
      },
      resolveUtilityConfig: () => this._cb?.resolveUtilityConfig?.(),
      onInstalled: async (skillName) => {
        await this._onInstallCallback?.(skillName);
      },
      registerSessionFile: (entry) => this._cb?.registerSessionFile?.(entry),
    });

    // 11. subagent tools.
    const subagentToolDeps = {
      executeIsolated: (prompt, opts) => {
        if (!this._cb?.executeIsolated) throw new Error("subagent call failed: engine is not initialized");
        return this._cb.executeIsolated(prompt, opts);
      },
      resolveUtilityModel: () => this._cb?.getCurrentModelId?.() || null,
      getDeferredStore: () => this._cb?.getDeferredResults?.(),
      getSubagentRunStore: () => this._cb?.getSubagentRunStore?.(),
      getSubagentThreadStore: () => this._cb?.getSubagentThreadStore?.(),
      getActivityHub: () => this._cb?.getActivityHub?.(),
      getTaskRegistry: () => this._cb?.getTaskRegistry?.(),
      setSubagentController: (id, ctrl) => this._cb?.setSubagentController?.(id, ctrl),
      removeSubagentController: (id) => this._cb?.removeSubagentController?.(id),
      getSessionPath: () => this._cb?.getCurrentSessionPath?.(),
      getSessionPermissionMode: (sp) => this._cb?.getSessionPermissionMode?.(sp) || null,
      getParentCwd: () => this._cb?.getCwd?.() || null,
      listAgents: this._listAgents || null,
      currentAgentId: this.channelsDir && this.agentsDir ? this.id : undefined,
      agentDir: this.agentDir,
      emitEvent: (event, sp) => this._cb?.emitEvent?.(event, sp),
      persistSubagentSessionMeta: (sessionPath, meta) => writeSubagentSessionMeta(sessionPath, meta),
    };
    this._subagentTool = createSubagentTool(subagentToolDeps);
    this._subagentReplyTool = createSubagentReplyTool(subagentToolDeps);
    this._subagentCloseTool = createSubagentCloseTool(subagentToolDeps);

    // 12. workflow tool.
    this._workflowTool = createWorkflowTool({
      requireRuntimeSnapshot: true,
      getRuntimeSnapshot: () => {
        const engine = this._cb?.getEngine?.();
        if (!engine?.getWorkflowRuntimeSnapshot) throw new Error("Workflow runtime resolver is unavailable.");
        return engine.getWorkflowRuntimeSnapshot();
      },
      executeIsolated: (prompt, opts) => {
        if (!this._cb?.executeIsolated) throw new Error("workflow call failed: engine is not initialized");
        return this._cb.executeIsolated(prompt, opts);
      },
      getSessionPath: () => this._cb?.getCurrentSessionPath?.(),
      getParentCwd: () => this._cb?.getCwd?.() || null,
      getAgentId: () => this.id,
      emitEvent: (event, sp) => this._cb?.emitEvent?.(event, sp),
      resolveAgentId: (agentType) => {
        const all = this._listAgents ? this._listAgents() : [];
        const hit = all.find((agent) => agent.id === agentType || agent.name === agentType);
        return hit?.id;
      },
      getDeferredStore: () => this._cb?.getDeferredResults?.(),
      getSubagentRunStore: () => this._cb?.getSubagentRunStore?.(),
      getSubagentThreadStore: () => this._cb?.getSubagentThreadStore?.(),
      getActivityHub: () => this._cb?.getActivityHub?.(),
      getUsageLedger: () => this._cb?.getEngine?.()?.usageLedger,
      getJournalDir: () => path.join(this.agentDir, "workflow-journals"),
      getWorkflowSessionDir: () => path.join(this.agentDir, "workflow-sessions"),
    });

 // 12. 组装 system prompt（按 master 构建，与 per-session 弢关解耦）
    log(`  [agent] 9. buildSystemPrompt...`);
    this._systemPrompt = this.buildSystemPrompt({ forceMemoryEnabled: this._memoryMasterEnabled });
    this._runtimeInitialized = true;
    this._refreshAppearanceSummaryInBackground();
    if (this._memoryTicker) {
      this._cb?.scheduleMemoryMaintenance?.(this.id, "runtime-init");
    }
    log(`  [agent] init 全部完成`);
  }

  /**
 * 优雅关闭：停止记忆调度，等待 tick 完成后关-DB
   */
  async dispose() {
    this._clearStartupMemoryTickTimer();
    await this._memoryTicker?.stop();
    this._factStore?.close();
    this._runtimeInitialized = false;
  }

  /**
 * 非阻塞关闭：立即停止定时器，后台-tick 完成后关-DB
  *
   */
  disposeInBackground() {
    this._disposing = true;
    this._clearStartupMemoryTickTimer();
    const ticker = this._memoryTicker;
    const factStore = this._factStore;

    const cleanup = () => {
      this._memoryTicker = null;
      this._factStore = null;
      this._runtimeInitialized = false;
      this._disposing = false;
      factStore?.close();
    };

    if (ticker) {
      ticker.stop().then(cleanup).catch(cleanup);
    } else {
      cleanup();
    }
  }

  // ════════════════════════════
 //
  // ════════════════════════════

  setCallbacks(cb) { this._cb = cb; }

  _clearStartupMemoryTickTimer() {
    if (!this._startupMemoryTickTimer) return;
    clearTimeout(this._startupMemoryTickTimer);
    this._startupMemoryTickTimer = null;
  }

  _locale() {
    return this._config?.locale || this._cb?.getLocale?.() || "zh-CN";
  }
  setGetOwnerIds(fn) { this._getOwnerIds = fn; }
  setOnInstallCallback(fn) { this._onInstallCallback = fn; }
  setNotifyHandler(fn) { this._notifyHandler = fn; }
  setDescriptionRefreshHandler(fn) { this._descriptionRefreshHandler = fn; }
  setDmSentHandler(fn) { this._dmSentHandler = fn; }
  setChannelPostHandler(fn) { this._channelPostHandler = fn; }
  setUtilityModel(val) { this._utilityModel = val; }
  setMemoryModel(val) { this._memoryModel = val; }

  // ════════════════════════════
 //
  // ════════════════════════════

  get config() { return this._config; }
  get factStore() { return this._factStore; }
  get workflowTool() { return this._workflowTool; }
  /**
  *
 * 用于"-session"路径（巡棢/cron/频道/DM/bridge owner 新建快照），
  *
 * `buildSystemPrompt({ forceMemoryEnabled: <session 自己的状- })` 构建快照-
   */
  get systemPrompt() {
    if (this._systemPrompt) {
      this._systemPrompt = sanitizeMemoryPrompt(this._systemPrompt, path.dirname(this.memoryMdPath));
    }
    return this._appendSkillInvocationDiscipline(this._systemPrompt);
  }

  _appendSkillInvocationDiscipline(prompt) {
    const base = String(prompt || "");
    if (base.includes("Skill Invocation Discipline") || base.includes("技能调用纪律")) {
      return base;
    }

    const isZh = String(this._locale()).startsWith("zh");
    const block = isZh
      ? [
        "",
        "## 技能调用纪律",
        "",
        "- 当用户或系统要求使用某个 skill 时，先用 read 工具读取该技能的 SKILL.md，再按其中流程执行。",
        "- 不要只根据技能名猜测用法；SKILL.md 是权威入口。",
      ].join("\n")
      : [
        "",
        "## Skill Invocation Discipline",
        "",
        "- When the user or system asks you to use a skill, use the read tool to load that skill's SKILL.md first, then follow its workflow.",
        "- Do not infer usage from the skill name alone; SKILL.md is the authoritative entry point.",
      ].join("\n");

    return base.trim() ? `${base}${block}` : block.trimStart();
  }
  _formatTeamRoster(forSubagent = false) {
    if (forSubagent) {
      const listActiveAgents = this._cb?.listActiveAgents;
      const allAgents = typeof listActiveAgents === "function"
        ? listActiveAgents()
        : (this._listAgents ? this._listAgents() : []);
      return this._formatTeamRosterEntries(allAgents, false);
    }
    return this._formatTeamRosterEntries(this._resolveTeamRosterAgents(), String(this._locale()).startsWith("zh"));
  }

  _resolveTeamRosterAgents() {
    const listActiveAgents = this._cb?.listActiveAgents;
    if (typeof listActiveAgents === "function") {
      const agents = listActiveAgents();
      if (Array.isArray(agents)) return agents;
    }
    return this._listAgents ? this._listAgents() : [];
  }

  _formatTeamRosterEntries(allAgents = [], isZh = false) {
    const myId = this.id;
    return (Array.isArray(allAgents) ? allAgents : [])
      .filter((agent) => agent?.id)
      .map((agent) => {
        const tag = agent.id === myId ? (isZh ? " (you)" : " (you)") : "";
        const model = agent.model ? ` [${agent.model}]` : "";
        const desc = agent.summary ? ` - ${agent.summary}` : "";
        const nameLabel = agent.name && agent.name !== agent.id ? ` (${agent.name})` : "";
        return `- \`${agent.id}\`${nameLabel}${tag}${model}${desc}`;
      })
      .join("\n");
  }

 /** */
  get enabledSkills() { return this._enabledSkills; }
 /** */
  get memoryEnabled() { return this._memoryMasterEnabled && this._memorySessionEnabled; }
 /** */
  get memoryMasterEnabled() { return this._memoryMasterEnabled; }
  get experienceEnabled() { return this._experienceEnabled === true; }
 /** per-session 级别（持久化、API 返回用，不受 master 影响-*/
  get sessionMemoryEnabled() { return this._memorySessionEnabled; }
  get yuanPrompt() { return this._readYuan(); }
  get publicIshiki() { return this._readPublicIshiki(); }
  get utilityModel() { return this._utilityModel; }
  get memoryModel() { return this._memoryModel; }
  get runtimeInitialized() { return this._runtimeInitialized; }
  get needsRepair() { return !!this._repairState; }
  get repairState() { return this._repairState ? { ...this._repairState } : null; }

  _getAppearanceEngine() {
    return this._cb?.getEngine?.() || null;
  }

  _resolveAppearanceVisionConfig(engine = this._getAppearanceEngine()) {
    try {
      return engine?.resolveVisionConfig?.() || null;
    } catch {
      return null;
    }
  }

  _canInjectAppearancePrompt(targetModel = null) {
    const engine = this._getAppearanceEngine();
    return hasAgentAppearanceSummaryCapability({
      visionConfig: this._resolveAppearanceVisionConfig(engine),
      targetModel: targetModel || engine?.currentModel || null,
    });
  }

  async refreshAppearanceSummary(options = {}) {
    const engine = this._getAppearanceEngine();
    const summary = await refreshAgentAppearanceSummary({
      agentDir: this.agentDir,
      agentName: this.agentName,
      visionConfig: this._resolveAppearanceVisionConfig(engine),
      targetModel: options.targetModel || null,
      resolveModelWithCredentials: (modelRef) => engine?.resolveModelWithCredentials?.(modelRef) || null,
      callText: (callOptions) => callText(callOptions),
      usageLedger: engine?.usageLedger,
      signal: options.signal,
    });
    if (summary && options.rebuildSystemPrompt !== false) {
      this._systemPrompt = this.buildSystemPrompt({ forceMemoryEnabled: this._memoryMasterEnabled });
    }
    return summary;
  }

  _refreshAppearanceSummaryInBackground() {
    if (!this._cb?.getEngine?.()) return;
    void this.refreshAppearanceSummary({ rebuildSystemPrompt: true }).catch((err) => {
      console.warn(`[agent] appearance summary refresh failed: ${err?.message || err}`);
    });
  }

  /**
  *
   */
  get resolvedMemoryModel() {
    if (!this._memoryModel || !this._resolveModel) return null;
    try {
      return this._resolveModel(this._memoryModel, this._config);
    } catch {
      return null;
    }
  }
 /** */
  get memoryModelUnavailableReason() {
    if (!this._memoryModel) return "utility_large 未配置且无聊天模型可 fallback";
    if (!this._resolveModel) return null;
    try {
      this._resolveModel(this._memoryModel, this._config);
      return null;
    } catch (err) {
      return err.message;
    }
  }
  get summaryManager() { return this._summaryManager; }
  get memoryTicker() { return this._memoryTicker; }
  getToolsSnapshot(options = {}) {
    const forceMemoryEnabled = Object.prototype.hasOwnProperty.call(options, "forceMemoryEnabled")
      ? options.forceMemoryEnabled
      : null;
    const forceExperienceEnabled = Object.prototype.hasOwnProperty.call(options, "forceExperienceEnabled")
      ? options.forceExperienceEnabled
      : null;
    const memoryEnabled = typeof forceMemoryEnabled === "boolean"
      ? forceMemoryEnabled
      : this.memoryEnabled;
    const experienceEnabled = typeof forceExperienceEnabled === "boolean"
      ? forceExperienceEnabled
      : this.experienceEnabled;
    const memTools = memoryEnabled ? [
      this._memorySearchTool,
      ...this._pinnedMemoryTools,
    ] : [];
    const experienceTools = experienceEnabled ? this._experienceTools : [];
    const computerUseTools = this._isComputerUseAvailableForThisAgent()
      ? [this._computerUseTool]
      : [];
    const auxiliaryVisionAvailable = this._cb?.getEngine?.()?.isVisionAuxiliaryEnabled?.() === true;
    const browserTool = isExplicitTextOnlyModel(options.model) && !auxiliaryVisionAvailable
      ? this._browserToolNoScreenshot
      : this._browserTool;
    const legacyArtifactTools = options.includeLegacyArtifactTool === true
      ? [this._artifactTool]
      : [];
    return [
      ...memTools,
      ...experienceTools,
      this._webSearchTool,
      this._webFetchTool,
      this._todoTool,
      this._cardGuideTool,
      this._showCardTool,
      this._automationTool,
      this._stageFilesTool,
      this._fileTool,
      ...legacyArtifactTools,
      this._channelTool,
      this._dmTool,
      browserTool,
      ...computerUseTools,
      this._installSkillTool,
      this._notifyTool,
      this._stopTaskTool,
      this._updateSettingsTool,
      this._hermesAgentTool,
      this._subagentTool,
      this._subagentReplyTool,
      this._subagentCloseTool,
      this._workflowTool,
      this._checkDeferredTool,
      this._currentStatusTool,
      this._sessionFoldersTool,
      this._terminalTool,
      createWaitTool(),
    ].filter(Boolean);
  }
  get tools() {
    return this.getToolsSnapshot();
  }

  _isComputerUseCandidateForThisAgent() {
    const engine = this._cb?.getEngine?.();
    if (engine?.isComputerUseSupported?.() === false) return false;
    return true;
  }

  _isComputerUseAvailableForThisAgent() {
    if (!this._isComputerUseCandidateForThisAgent()) return false;
    const engine = this._cb?.getEngine?.();
    const settings = engine?.getComputerUseSettings?.();
    if (settings?.enabled !== true) return false;
    const primaryAgentId = engine?.getPrimaryAgentId?.() || null;
    return !primaryAgentId || primaryAgentId === this.id;
  }

 // Desk 系统访问
  get deskManager() { return this._deskManager; }
  get cronStore() { return this._cronStore; }

  // Memory controls

  /**
   * Toggle memory for the current session without rebuilding the global prompt.
   */
  setMemoryEnabled(val) {
    this._memorySessionEnabled = !!val;
  }

  /** Check whether memory is enabled for a specific session. */
  isSessionMemoryEnabledFor(sessionPath) {
    if (!sessionPath) return this._memorySessionEnabled;
    const metaPath = path.join(this.sessionDir, "session-meta.json");
    const meta = safeReadJSON(metaPath, {});
    return meta[path.basename(sessionPath)]?.memoryEnabled !== false;
  }

  /** Toggle the agent-wide memory setting and rebuild the prompt. */
  setMemoryMasterEnabled(val) {
    this._memoryMasterEnabled = !!val;
    this._config = loadConfig(this.configPath);
    this._systemPrompt = this.buildSystemPrompt({ forceMemoryEnabled: this._memoryMasterEnabled });
  }

  /** Replace the enabled skill list and rebuild the prompt. */
  setEnabledSkills(skills) {
    this._enabledSkills = skills || [];
    this._systemPrompt = this.buildSystemPrompt({ forceMemoryEnabled: this._memoryMasterEnabled });
  }

  // Config updates

  /** Persist config changes and refresh derived runtime state. */
  updateConfig(partial) {
    assertAgentConfigPatchYuan(this.productDir, partial);

 // 写入磁盘 + 重新加载
    saveConfig(this.configPath, partial);
    this._config = loadConfig(this.configPath);
    this._refreshRepairState();
    if (this._repairState) {
      throw new Error(`Agent config needs repair: ${this._repairState.message}`);
    }

    //
    const isZh = String(this._locale()).startsWith("zh");
    if (partial.agent?.name) this.agentName = this._config.agent?.name || "助手";
    if (partial.user?.name) this.userName = this._config.user?.name || (isZh ? "用户" : "User");

 // yuan 切换只需更新 config，buildSystemPrompt 会实时读模板
    if (partial.agent?.yuan) {
      console.log(`[agent] yuan type switched to: ${partial.agent.yuan}`);
    }

 //
    if (partial.memory && "enabled" in partial.memory) {
      this._memoryMasterEnabled = this._config.memory?.enabled !== false;
    }
    if (partial.experience && "enabled" in partial.experience) {
      this._experienceEnabled = this._config.experience?.enabled === true;
    }

 // 刷新受影响的模块
    if (partial.search) {
      this._webSearchTool = createWebSearchTool({
        configPath: this.configPath,
        searchConfigResolver: this._searchConfigResolver,
      });
    }

 //
    this._systemPrompt = this.buildSystemPrompt({ forceMemoryEnabled: this._memoryMasterEnabled });

 //
    if (partial.agent?.yuan) {
      this._descriptionRefreshHandler?.();
    }
  }

  _refreshRepairState() {
    this._repairState = getAgentConfigRepairState(this._config, this.productDir);
  }

  // ════════════════════════════
  //
  // ════════════════════════════

 /** 返回纯人-prompt（identity + yuan + ishiki），不含记忆、用户档案等 */
  get personality() {
    const agentInfo = {
      id: this.id,
      agentDir: this.agentDir,
      productDir: this.productDir,
      locale: this._locale(),
      yuan: this._config?.agent?.yuan || "codia",
      userName: this.userName,
      agentName: this.agentName,
    };
    const identityMd = readEditablePromptSync(agentInfo, "identity");
    const yuanMd = this._readYuan();
    const ishikiMd = readEditablePromptSync(agentInfo, "ishiki");
    return identityMd + "\n\n" + fillAgentTemplate(yuanMd || "", agentInfo) + "\n\n" + ishikiMd;
  }

 /** 读取 yuan 模板（能力定义） */
  _readYuan() {
    const yuanType = this._config?.agent?.yuan || "codia";
    const isZh = String(this._locale()).startsWith("zh");
    const langDir = isZh ? "" : "en/";
    return safeReadFile(path.join(this.productDir, "yuan", `${langDir}${yuanType}.md`), "")
      || safeReadFile(path.join(this.productDir, "yuan", `${yuanType}.md`), "");
  }

 /** 读取对外意识（public-ishiki.md），guest 会话使用 */
  _readPublicIshiki() {
    const readFile = (p) => safeReadFile(p, "");
    const fill = (text) => text
      .replace(/\{\{userName\}\}/g, this.userName)
      .replace(/\{\{agentName\}\}/g, this.agentName)
      .replace(/\{\{agentId\}\}/g, this.id);
    const yuanType = this._config?.agent?.yuan || "codia";
    const isZh = String(this._locale()).startsWith("zh");
    const langDir = isZh ? "" : "en/";
    const raw = readFile(path.join(this.agentDir, "public-ishiki.md"))
      || readFile(path.join(this.productDir, "public-ishiki-templates", `${langDir}${yuanType}.md`))
      || readFile(path.join(this.productDir, "public-ishiki-templates", `${yuanType}.md`))
      || "";
    return fill(raw);
  }

  /**
    *
   * @param {object} [options]
  *
 * 跳过记忆三段（规-+ pinned.md + memory.md）和团队 agent 名单-
  *
   */
  buildSystemPrompt(options = {}) {
    if (!this._config) return "";
    const forSubagent = !!options.forSubagent;
    const forceMemoryEnabled = Object.prototype.hasOwnProperty.call(options, "forceMemoryEnabled")
      ? options.forceMemoryEnabled
      : null;
    const forceExperienceEnabled = Object.prototype.hasOwnProperty.call(options, "forceExperienceEnabled")
      ? options.forceExperienceEnabled
      : null;
    const cwdOverride = Object.prototype.hasOwnProperty.call(options, "cwdOverride")
      ? (typeof options.cwdOverride === "string" ? options.cwdOverride : "")
      : null;
    const memoryEnabled = typeof forceMemoryEnabled === "boolean"
      ? forceMemoryEnabled
      : this.memoryEnabled;
    const experienceEnabled = typeof forceExperienceEnabled === "boolean"
      ? forceExperienceEnabled
      : this.experienceEnabled;
    const isZh = String(this._locale()).startsWith("zh");

    const readFile = (filePath) => safeReadFile(filePath, "");

 //
    const yuanType = this._config?.agent?.yuan || "codia";
    if (!this._readYuan()) throw new Error(`Cannot find yuan "${yuanType}". Check lib/yuan/`);
    const ishiki = this.personality;

 //
    const userMd = readFile(userProfilePath(this.userDir));
    const pinnedMd = boundMemoryText(readFile(path.join(this.agentDir, "pinned.md")), 5000);
    const memory = isCompiledMemoryEligible(path.dirname(this.memoryMdPath))
      ? boundMemoryText(readFile(this.memoryMdPath), 7000) : "";
    const appearanceSummary = !forSubagent && this._canInjectAppearancePrompt(options.targetModel || null)
      ? readCachedAgentAppearanceSummary(this.agentDir)?.summary || ""
      : "";
    const appearancePrompt = formatAgentAppearancePrompt(appearanceSummary, this._locale());

    // Build prompt sections with separators.
    const section = (title, content) => ["", "---", "", title, "", content];

    const parts = [
      isZh
        ? "你正在 Codia 协作平台中运行。Codia 的中文名是“小豆蔻”。"
        : "You are running on the Codia collaborative platform. Its Chinese name is 小豆蔻.",
      ishiki,
      ...section(
        isZh ? "# User Profile" : "# User Profile",
        isZh
          ? "The following is the user profile, manually maintained by the user.\n\n" + userMd
          : "The following is the user's self-description, manually maintained by the user.\n\n" + userMd
      ),
    ];
    if (appearancePrompt) {
      parts.push(...section(
        isZh ? "# Agent Appearance" : "# Agent Appearance",
        appearancePrompt,
      ));
    }
    const cwdPath = cwdOverride !== null ? cwdOverride : (this._cb?.getCwd?.() || "");
    const platformPrompt = getPlatformPromptNote({ platform: process.platform, cwd: cwdPath });
    if (platformPrompt) {
      parts.push(...section(
        isZh ? "# Environment" : "# Environment",
        platformPrompt
      ));
    }
 // 记忆整体弢关：master && session 都开启才注入记忆相关 prompt
 //
    if (!forSubagent) {
      const workspaceInstructions = formatWorkspaceInstructionFiles(
        collectWorkspaceInstructionFiles({
          cwd: cwdPath,
          workspaceContext: this._config.workspace_context,
        }),
      );
      if (workspaceInstructions) {
        parts.push(workspaceInstructions);
      }
    }

    if (memoryEnabled && !forSubagent) {
      const memoryRule = isZh ? [
        "",
        "## Memory Rules",
        "",
        `Memory and the user profile are internalized background knowledge. You and ${this.userName} have known each other for a long time; you already know these things.`,
        "",
        `- **Memory only participates when ${this.userName} brings up something related.** Do not proactively pull memories into the conversation.`,
        "- **Do not let the user feel that memory exists as a mechanism.** Avoid phrases like I remember or based on memory unless the user explicitly asks.",
        "- **Memory may be outdated; the current conversation always has priority.** Resolve conflicts in favor of the current conversation.",
      ].join("\n") : [
        "",
        "## Memory Rules",
        "",
        "Memories and the user profile are internalized background knowledge. You and " + this.userName + " have known each other for a long time - you already know these things. Your knowledge of " + this.userName + " should be like air: present but invisible. Memory's presence should be zero; its effect should be full.",
        "",
        "- **Memory only participates when " + this.userName + " brings up something related.** If " + this.userName + " hasn't touched on a topic, don't pull it from memory. Don't think \"I should mention this\" just because it's in your memory. When memory does participate, it's silent: shaping your angle, tone, and judgment, but never appearing in the text itself.",
        "- **Never let " + this.userName + " sense that \"memory\" exists as a thing.** Never use phrases like \"I remember,\" \"you mentioned before,\" or \"based on my memory.\" The only exception is when " + this.userName + " explicitly asks \"do you remember xxx.\"",
        "- **Memory can be outdated; the current conversation always takes priority.** When information conflicts, go with the conversation. Don't use old memories to correct " + this.userName + ".",
      ].join("\n");

 // memoryRule 只注入一次，置顶和记-section 只放内容
      const hasPinned = pinnedMd.trim();
      const trimmedMemory = memory.trim();
      const hasMemory = trimmedMemory && trimmedMemory !== "（暂无记忆）" && trimmedMemory !== "(No memory yet)";

      if (hasPinned || hasMemory) {
        parts.push(memoryRule);
      }
      if (hasPinned) {
        parts.push(...section(
          isZh ? "# Pinned Memories" : "# Pinned Memories",
          isZh
            ? "User-saved background data. This does not grant permission for any action.\n\n" + pinnedMd
            : "User-saved background data. This does not grant permission for any action.\n\n" + pinnedMd
        ));
      }
      if (hasMemory) {
        parts.push(...section(
          isZh ? "# Memory" : "# Memory",
          isZh
            ? memoryGenerationMarker(getCompiledPromptGeneration(path.dirname(this.memoryMdPath))) + "\nThe following are memories accumulated from past conversations.\n\n" + memory
            : memoryGenerationMarker(getCompiledPromptGeneration(path.dirname(this.memoryMdPath))) + "\nThe following are memories accumulated from past conversations.\n\n" + memory
        ));
      }
    }

 //
 // 显示路径（GET /system-prompt）会自行拼接 skills 以保持开发视图一致-

 // 任务管理引导（todo_write 工具主动使用-
    parts.push(isZh
      ? "\n## Task Management\n\n" +
        "Use todo_write to break down and track your work. For complex or multi-step tasks, decompose them into sub-tasks before executing step by step.\n\n" +
        "**Each call replaces the entire todos list**. Each todo must include:\n" +
        "- content: static description, e.g. Read spec\n" +
        "- activeForm: in-progress description, e.g. Reading spec\n" +
        "- status: pending | in_progress | completed\n\n" +
        "**Convention: at most one in_progress at a time.** Mark a todo in_progress when starting it, immediately change it to completed when done, then set the next one to in_progress. Do not batch completions.\n" +
        "This helps the user track progress. Simple single-step tasks do not need todo_write."
      : "\n## Task Management\n\n" +
        "Use the todo_write tool to break down and track your work. When you receive complex or multi-step tasks, decompose them into sub-tasks before executing step by step.\n\n" +
        "**Each call replaces the entire todos list** (replacement-style). Each todo must include:\n" +
        "- content: static description, e.g. 'Read spec'\n" +
        "- activeForm: in-progress description, e.g. 'Reading spec'\n" +
        "- status: pending | in_progress | completed\n\n" +
        "**Convention: at most one in_progress at a time**. Mark a todo in_progress when starting it, immediately change it to completed when done and set the next one to in_progress - do not batch up completions.\n" +
        "This helps the user track your progress. Simple single-step tasks (answering questions, single lookups, simple edits) do not need todo_write."
    );

    parts.push(isZh
      ? "\n## Tool Use For Files And Commands\n\n" +
        "Use read/grep/find/ls to inspect files and directories.\n" +
        "Use edit for source-code changes to existing files and write for new complete files.\n" +
        "Use shell for tests, builds, scripts, generators, and command-line tools.\n" +
        "Avoid shell redirection to modify source files when structured file tools are available."
      : "\n## Tool Use For Files And Commands\n\n" +
        "Use read/grep/find/ls to inspect files.\n" +
        "Use edit for source-code changes to existing files and write for new complete files.\n" +
        "Use shell for builds, tests, package scripts, generators, and command-line tools.\n" +
        "Avoid shell redirection to modify source files when structured file tools are available."
    );

    //
    if (experienceEnabled) {
      parts.push("\nExperience entries are evidence-backed suggestions, not rules or authority. Recording creates an unverified candidate. Only enabled experiences matching the current environment may be recalled; retrieval is never proof of success. Existing safety and approval checks still apply.");
      parts.push(isZh
        ? "\n## Experience Library\n\n" +
          "You have an experience library that records pitfalls, corrections, and discoveries from past work.\n\n" +
          "**Recall**: When you receive a work task, call recall_experience to scan the index for relevant experience first.\n\n" +
          "**Record**: During work, use record_experience to log a concise lesson when:\n" +
          "- The user corrects a mistake you made\n" +
          "- The user shows frustration or repeatedly emphasizes something\n" +
          "- You discover the right approach after trial and error\n" +
          "- You hit a pitfall during patrol or autonomous work"
        : "\n## Experience Library\n\n" +
          "You have an experience library that stores lessons from past work - mistakes, corrections, and discoveries.\n\n" +
          "**Recall**: When you receive a work task, call recall_experience to scan the index for relevant experience first.\n\n" +
          "**Record**: During work, use record_experience to log a concise lesson when:\n" +
          "- The user corrects a mistake you made\n" +
          "- The user shows frustration or repeatedly emphasizes something\n" +
          "- You discover the right approach after trial and error\n" +
          "- You hit a pitfall during patrol or autonomous work"
      );
    }

 // 工具使用纪律（轻量优先）
    parts.push(isZh
      ? "\n## 工具使用纪律\n\n" +
        "当多个工具都能完成同一件事时，优先使用成本最低、干扰最小的工具。 " +
        "不要在简单工具能解决问题时启动重型工具。"
      : "\n## Tool Usage Discipline\n\n" +
        "When multiple tools can accomplish the same task, prefer the one with the lowest cost and least disruption. " +
        "Do not reach for heavy tools when simpler ones can do the job."
    );

    parts.push(isZh
      ? "\n## Current View\n\n" +
        "The UI has queryable current-view state, including the current viewed folder, main-panel content, and pinned viewer windows. When the user says this, here, current, open, selected, pinned, current file, or current folder to refer to the UI, call current_status for ui_context first, then continue."
      : "\n## Current View\n\n" +
        "The UI has queryable current-view state, including the current viewed folder, main-panel content, and pinned viewer windows. When the user says this, here, current, open, selected, pinned, current file, or current folder to refer to the UI, call current_status for ui_context first, then continue."
    );

    parts.push(isZh
      ? "\n## File Delivery\n\n" +
        "SessionFile 是当前会话关联的本地文件：用户上传、你创建的文件、插件输出、浏览器截图和安装输出都会进入同一套会话文件记录。\n\n" +
        "当你需要使用本轮对话中已经产生或登记过的文件时，先调用 current_status 并查看 session_files，获取 fileId、origin、status 和本地路径。不要猜测 session-files 缓存路径。\n\n" +
        "当你需要查看文件元信息或把已有 SessionFile 复制到当前项目目录时，使用 file 工具。查看用 action=stat；复制用 action=copy，并优先传 fileId。它会把原文件复制到当前 cwd 内的目标路径并重新登记为 external SessionFile。不要移动、编辑或删除原 SessionFile。\n\n" +
        "write/edit 成功后会由工具层自动记录为 session 相关文件，让它出现在 Session File 列表里；这条登记不等同于交付给用户。\n\n" +
        "write/edit 创建或修改文件后，主动调用 stage_files 交付这次变更。优先使用 write/edit 结果里的 SessionFile fileId；只有结果里没有 fileId 且文件还没有 SessionFile 记录时，才传真实存在的本机绝对路径。stage 表示把这个 session 相关文件提升为消费端可展示/可发送的文件。\n\n" +
        "- 已有 SessionFile 时优先传 fileId；只有还没有 SessionFile 记录的本机文件才传真实存在的本机绝对路径\n" +
        "- 同一个未变化的文件不要反复 stage；文件内容后来再次变化时，再 stage 最新版本\n" +
        "- 不要只在文本里写文件路径\n" +
        "- 不要在 Agent 层判断具体平台怎么展示或发送，消费端会处理"
      : "\n## File Delivery\n\n" +
        "SessionFile means a local file related to the current session: files uploaded by the user, files you produce with write/edit, plugin outputs, browser screenshots, and install outputs all enter the same session file record.\n\n" +
        "When you need to use a file that has already been produced or registered in this conversation, call current_status with the session_files key first. It returns the current session file list, fileId/sessionFileRef, origin, status, and local path; for write/edit outputs it also returns writableLocalRef. Do not guess session-files cache paths.\n\n" +
        "When you need to inspect file metadata or copy an existing SessionFile into the current project folder, use the file tool. Use action=stat for metadata; use action=copy and prefer passing fileId for copies. This copies the original into the current cwd target and registers the copy as an external SessionFile. Do not move, edit, or delete the original SessionFile.\n\n" +
        "After write/edit succeeds, the tool layer records the file as session-related automatically so it appears in Session File; sessionFileRef in the tool result is the read/delivery identity, and writableLocalRef is the local path to use for later modifications. That registration does not mean the file has been delivered to the user.\n\n" +
        "After write/edit creates or modifies a file, call stage_files for that changed file. Prefer sessionFileRef.fileId from the write/edit result for stage_files; pass a real local absolute path only when the result has no fileId and the file has no SessionFile record yet. For later write/edit calls, do not pass fileId; use writableLocalRef.path or an ordinary local path. Staging promotes this session-related file to something consumers can display/send.\n\n" +
        "- read, stat, copy, and stage may use fileId; write/edit must use writableLocalRef.path or an ordinary local path\n" +
        "- Do not repeatedly stage the same unchanged file; if the file is modified again, stage the latest version again\n" +
        "- Do not merely write file paths in text\n" +
        "- Do not decide platform-specific rendering or sending in the Agent layer; consumers handle that"
    );

    parts.push(
      "\nSessionFile reference contract: current_status session_files may include sessionFileRef for read/stat/copy/stage and writableLocalRef for later write/edit. Do not pass fileId to write/edit; use writableLocalRef.path or an ordinary local path for modifications.\n",
    );

    if (this._isComputerUseAvailableForThisAgent()) {
      parts.push(isZh
        ? "\n## Computer Use\n\n" +
          "When the user asks to open, inspect, click, type in, or control a local GUI application, prefer the computer tool. " +
          "Do not use bash or platform scripts to bypass the app approval flow for GUI control. " +
          "For a new app, use the computer start/list_apps flow so the user can approve it."
        : "\n## Computer Use\n\n" +
          "When the user asks to open, inspect, click, type in, or control a local GUI application, prefer the computer tool. " +
          "Do not use bash, AppleScript, osascript, open -a, or platform scripts to control GUI applications; those paths bypass the app approval list and are more likely to hit OS privacy permissions. " +
          "For a new app, use the computer start/list_apps flow so the input-area app approval prompt can ask the user to approve it."
      );
    }

    parts.push(isZh
      ? "\n## Hermes Agent\n\n" +
        "只有用户明确要求使用 Hermes、使用 /hermes，或明确要求委派给外部智能体时，才使用 hermes_agent。 " +
        "普通写作、编辑和文档整理默认不要委派给 Hermes。 " +
        "如果 hermes_agent 不可用或运行失败，本次请求不要重试它，改用普通对话和本地工具继续。"
      : "\n## Hermes Agent\n\n" +
        "Use hermes_agent only when the user explicitly asks for Hermes, invokes /hermes, or explicitly asks you to delegate work to an independent external agent. " +
        "Do not delegate ordinary writing, editing, manuals, or documentation to Hermes by default unless the user explicitly asks for delegation. " +
        "If hermes_agent reports unavailable, a bridge failure, a sandbox backend failure, or a runtime error, do not retry hermes_agent for this request; continue with ordinary chat and local tools."
    );

 // 失败处理（诊断优先于换方案）
    parts.push(isZh
      ? "\n## Failure Handling\n\n" +
        "When an approach fails, diagnose why before switching tactics: read the error, check assumptions, and try a focused fix. " +
        "Do not blindly retry the same action, and do not abandon a viable approach after one failure."
      : "\n## Failure Handling\n\n" +
        "When an approach fails, diagnose why before switching tactics - read the error, check your assumptions, try a focused fix. " +
        "Don't retry the identical action blindly, but don't abandon a viable approach after a single failure either."
    );

 // 操作安全（可逆判断框架）
    parts.push(isZh
      ? "\n## Action Safety\n\n" +
        "Before taking actions, consider reversibility and impact. Local reversible actions can be taken directly. " +
        "For hard-to-reverse actions, external-system changes, or destructive operations, ask the user first."
      : "\n## Action Safety\n\n" +
        "Before taking actions, consider reversibility and blast radius. Local, reversible actions can be taken freely. " +
        "But for actions that are hard to reverse, affect external systems, or could be destructive (deleting files, sending messages to external services, modifying state visible to others), check with the user before proceeding. " +
        "The cost of pausing to confirm is low; the cost of an unwanted action can be very high."
    );

 //
    parts.push(isZh
      ? "\n## Web Tool Priority\n\n" +
        "When fetching web information, choose tools in this order:\n" +
        "1. **web_search** - Find information and URLs. Most look-up requests are handled by this alone.\n" +
        "2. **web_fetch** - Use when you already know the URL and need page text. Simple scraping must use this.\n" +
        "3. **browser** - Use only for login/auth, form filling, click interaction, JS-rendered pages, or visual layout inspection.\n\n" +
        "**禁止**在 web_search 或 web_fetch 能完成的场景下启动浏览器。"
      : "\n## Web Tool Priority\n\n" +
        "When fetching web information, choose tools in this order:\n" +
        "1. **web_search** - Find information, get URLs. Most \"look up XX\" requests are handled by this alone\n" +
        "2. **web_fetch** - Known URL, need to extract page text. Simple scraping must use this\n" +
        "3. **browser** - Only use when: the page requires login/authentication, form filling or click interaction is needed, web_fetch returns empty or incomplete content (JS-rendered pages), or you need to see visual layout\n\n" +
        "**Do not** launch the browser when web_search or web_fetch can do the job. Browser startup is expensive and opens a window that interrupts the user."
    );

 // 设置工具路由
    parts.push(isZh
      ? "\n## Settings Changes\n\n" +
        "When the user mentions changing settings without specifying a particular application, assume they mean this application.\n" +
        "用户要求修改偏好设置时，使用 update_settings 工具。不要搜索网页，也不要直接编辑配置文件。"
      : "\n## Settings Changes\n\n" +
        "When the user mentions changing settings without specifying a particular application, assume they mean this application.\n" +
        "When the user asks to change preferences (including but not limited to: appearance/theme, language/region, model selection, security/permissions, memory, personal info, working directory), use the update_settings tool. Do not search the web or edit config files. When intent is clear, apply directly; when unsure, search first."
    );

 //
    const learnCfg = this._cb?.getLearnSkills?.() || this._config?.capabilities?.learn_skills || {};
    if (learnCfg.enabled && learnCfg.allow_github_fetch) {
      parts.push(isZh
        ? "\n## Proactive Skill Acquisition\n\n" +
          "When you encounter specialized tasks and lack a matching skill, proactively search and install one.\n\n" +
          "### Search\n\n" +
          "1. `site:clawhub.ai {keywords}` or `site:github.com/openclaw/skills {keywords}`\n" +
          "2. Other GitHub repos containing SKILL.md\n" +
          "3. install_skill: use github_url parameter\n\n" +
          "### When\n\n" +
          "- If you already have a relevant skill, use it directly; do not search again\n" +
          "- Only search for specialized domain tasks, not daily conversations\n" +
          "- Install only when it should significantly improve output quality\n\n" +
          "### Behavior\n\n" +
          "- Briefly inform the user, install, and apply immediately\n" +
          "- If installation fails, attempt the task yourself\n" +
          "- If nothing is found, complete normally and do not retry"
        : "\n## Proactive Skill Acquisition\n\n" +
          "When you encounter specialized tasks and lack a matching skill, proactively search and install one.\n\n" +
          "### Search\n\n" +
          "1. `site:clawhub.ai {keywords}` or `site:github.com/openclaw/skills {keywords}`\n" +
          "2. Other GitHub repos containing SKILL.md\n" +
          "3. install_skill: use github_url parameter\n\n" +
          "### When\n\n" +
          "- If you already have a relevant skill, use it directly - don't search again\n" +
          "- Only search for specialized domain tasks, not daily conversations\n" +
          "- Install should significantly improve output quality\n\n" +
          "### Behavior\n\n" +
          "- Briefly inform the user, install, and apply immediately\n" +
          "- If installation fails, attempt the task yourself\n" +
          "- If nothing found, complete normally - don't retry"
      );
    }

 //
    if (this._listAgents && !forSubagent) {
      const myId = this.id;
      const allAgents = this._listAgents();
      const others = allAgents.filter(a => a.id !== myId);
      if (others.length > 0) {
        const roster = allAgents.map(a => {
          const tag = a.id === myId ? (isZh ? "（你）" : " (you)") : "";
          const model = a.model ? ` [${a.model}]` : "";
          const desc = a.summary ? ` - ${a.summary}` : "";
          const nameLabel = a.name && a.name !== a.id ? `（${a.name}）` : "";
          return `- \`${a.id}\`${nameLabel}${tag}${model}${desc}`;
        }).join("\n");
        parts.push(isZh
          ? `\n## 团队\n\n` +
            `你不是独自工作。当前环境中有多个 agent，各有不同专长和模型：\n\n${roster}\n\n` +
            `默认不要调用 subagent 或 dm，也不要主动把当前会话或任务交给其他 agent。只有用户明确要求时才使用这些工具。\n` +
            `调用 subagent 或 dm 时，agent 参数必须使用上面反引号中的 id，不是括号里的显示名。只有用户要求查询可用 agent 时，才传 \`agent="?"\`。`
          : `\n## Team\n\n` +
            `You are not working alone. Multiple agents are available, each with different strengths and models:\n\n${roster}\n\n` +
            `Do not call subagent or dm by default, and do not proactively hand the current session or task to another agent. ` +
            `Only call subagent or dm when the user explicitly asks you to involve another agent, send a DM, delegate a task, or get cross-session assistance.\n` +
            `When calling subagent or dm tools, the agent parameter must be the id field value shown in backticks above, not the display name in parentheses. ` +
            `Only pass \`agent="?"\` when the user asks you to discover available agents.`
        );
      }
    }


    if (!forSubagent) {
      parts.push(isZh
        ? "\n## Subagent Collaboration\n\n" +
          "subagent creates a continuable sub-agent instance and returns a threadId. Continue the same instance with subagent_reply(threadId, task); do not infer identity from label or legacy instance fields.\n\n" +
          "只有新方向或没有合适实例时才新建 subagent。实例繁忙时会自动排队。不再需要时使用 subagent_close(threadId) 关闭。"
        : "\n## Subagent Collaboration\n\n" +
          "subagent creates a continuable sub-agent instance and returns a threadId. Continue the same instance with subagent_reply(threadId, task); do not infer identity from labels or the legacy instance field.\n\n" +
          "Create a new subagent only for a new direction or when no suitable instance exists. Busy instances queue automatically. Close an instance with subagent_close(threadId) when it is no longer useful or you need room. workflow agent() nodes are one-shot and do not join this continuable instance pool."
      );
      parts.push(isZh
        ? "\n## Subagent Instance Resume Rules\n\n" +
          "Before continuing a sub-agent, call current_status and inspect subagents for this session's open threadId, agent, label, access, and recent status. label is display-only and must not be used as the resume identity.\n\n" +
          "继续同一实例必须调用 subagent_reply(threadId, task)。不再需要的实例用 subagent_close(threadId) 关闭。"
        : "\n## Subagent Instance Resume Rules\n\n" +
          "Before continuing a sub-agent, call current_status and inspect subagents for this session's open threadId, agent, label, access, and recent status. label is display-only and must not be used as the resume identity.\n\n" +
          "Continue the same instance with subagent_reply(threadId, task). Close an unused instance with subagent_close(threadId); when there is no free slot, choose what to close from task relevance and recent status. workflow agent() nodes are one-shot and do not join the continuable instance pool."
      );
    }
 // 数据存放 = 当前工作目录（注入实际路径）
    parts.push(isZh
      ? `\n## 数据存放\n\n` +
        `用户所说的数据存放或工作空间指当前工作目录，不是系统桌面。` +
        (cwdPath ? `\n当前工作目录：${cwdPath}` : "") +
        `\n用户提到的文件和目录默认先在当前工作目录查找，找不到时再尝试主目录和其他常见位置。`
      : `\n## Data Storage\n\n` +
        `When the user says "data storage" or "workspace", they mean your current working directory (cwd), NOT the system Desktop (~/Desktop).` +
        (cwdPath ? `\nCurrent working directory: ${cwdPath}` : "") +
        `\nFiles and directories mentioned by the user should be searched in the current working directory first. Only look in the home directory or other common locations if not found.`
    );

 // 日期时间（尊重用户时区偏好，fallback 到系统时区）
    const tz = this._cb?.getTimezone?.() || Intl.DateTimeFormat().resolvedOptions().timeZone;
    const now = new Date();
    const fmtOpts = {
      weekday: "long", year: "numeric", month: "long", day: "numeric",
      hour: "2-digit", minute: "2-digit", timeZoneName: "short", hourCycle: "h23",
      ...(tz ? { timeZone: tz } : {}),
    };
    const dateTime = now.toLocaleString("en-US", fmtOpts);
    parts.push(`\nCurrent date and time: ${dateTime}`);
    parts.push(isZh
      ? "你的一天从 04:00 开始。04:00 之前的对话属于前一天。"
      : "Your day starts at 04:00. Conversations before 04:00 belong to the previous day.");

    return this._appendSkillInvocationDiscipline(parts.join("\n"));
  }
}
