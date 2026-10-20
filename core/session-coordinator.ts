import { installUsageBudgetGuard, isUsageAccounted, hasUsageBudgetGuard } from "../lib/llm/usage-budget-guard.ts";
import { installRunBudgetStreamGuard } from "../lib/workflow/run-budget-stream.ts";
import { executionContext, findExecutionRun, loadExecutionRun, moveSessionWithExecutionRunSync, RunController } from "../lib/execution/run-controller.ts";
import { isExecutionPaused } from "../shared/execution-run.ts";
import { cancelSessionSubmissions } from "../lib/execution/submission-gate.ts";
import { guardMemoryContext, installMemoryContextGuard, installMemoryAppendGuard, sanitizeMemoryPrompt } from '../lib/memory/prompt-guard.ts';
import { resolveMemoryProjectId, buildTrustedMemoryContext, persistMemoryRuntimeSnapshot } from '../lib/memory/runtime-context.ts';
import type { RunBudget } from "../lib/workflow/run-budget.ts";
import { createResolvedRuntimeSnapshot } from "../lib/workflow/runtime-snapshot.ts";
import { isAgentReviewPending, assertAgentReviewActive } from './agent-review-turns.ts';
/**
 * SessionCoordinator
 *
 * Extracted from Engine. Owns session lifecycle operations such as create,
 * switch, close, list, isolated execution, session titles, and activity
 * session promotion. It does not hold a direct Engine reference; everything is
 * provided through injected dependencies.
 */
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { createAgentSession, SessionManager, estimateTokens, refreshSessionModelFromRegistry } from "../lib/pi-sdk/index.ts";
import { createDefaultSettings } from "./session-defaults.ts";
import { computeHardTruncation } from "./compaction-utils.ts";
import {
  appendCompactionResultToSession,
  createCachePreservingCompactionResult,
  runCachePreservingCompactionForSession,
} from "./session-compactor.ts";
import { evaluateSessionHealth, repairOrphanToolResultEntriesInFile } from "./session-health.ts";
import { teardownSessionResources } from "./session-teardown.ts";
import { createModuleLogger } from "../lib/debug-log.ts";
import { BrowserManager } from "../lib/browser/browser-manager.ts";
import { t, getLocale } from "../lib/i18n.ts";
import { isDefaultWorkspacePath, restoreDefaultWorkspaceIfMissing } from "../shared/default-workspace.ts";
import {
  DEFAULT_SESSION_PERMISSION_MODE,
  SESSION_PERMISSION_MODES,
  isReadOnlyPermissionMode,
  legacyAccessModeFromPermissionMode,
  normalizeSessionPermissionMode,
} from "./session-permission-mode.ts";
import {
  normalizeSessionThinkingLevel,
  normalizeThinkingLevelForModel,
  resolveModelDefaultThinkingLevel,
  resolveThinkingLevelForModel,
} from "./session-thinking-level.ts";
import { findModel } from "../shared/model-ref.ts";
import { computeToolSnapshot, DEFAULT_DISABLED_TOOL_NAMES } from "../shared/tool-categories.ts";
import { getStableFeatureDisabledToolNames } from "./tool-availability.ts";
import { repairRestoredToolSnapshotDetailed, sameToolNames } from "./tool-snapshot-repair.ts";
import { buildSessionCapabilityDrift } from "./session-capability-drift.ts";
import { extractTextContent, isActiveSessionPath, isArchivedDesktopSessionPath } from "./message-utils.ts";
import {
  formatWorkspaceScopePrompt,
  normalizeSessionFolderScope,
  normalizeWorkspaceScope,
} from "../shared/workspace-scope.ts";
import { getProviderPromptPatches } from "./provider-prompt-patches.ts";
import { prepareVisionInputForTextOnlyModel } from "./vision-prepare.ts";
import { prepareModelImageInputsForPrompt } from "./model-image-preprocess.ts";
import { createVisionContextInjectionExtension } from "./vision-context-injector.ts";
import {
  createSessionTurnContextExtension,
  normalizeSessionTurnContext,
} from "./session-turn-context.ts";
import {
  modelSupportsAudioInput,
  modelSupportsDirectAudioInput,
  modelSupportsVideoInput,
} from "../shared/model-capabilities.ts";
import {
  pruneSessionInlineMediaHistory,
  repairSessionInlineMediaEntriesInFile,
} from "./session-inline-media-prune.ts";
import {
  resolveSessionSkillsForRuntime,
  snapshotSkillsForSession,
} from "../lib/skills/session-skill-snapshot.ts";
import { SessionListProjectionCache } from "./session-list-projection-cache.ts";
import { sessionLocatorKey } from "./session-manifest/path-normalizer.ts";
import {
  buildLlmContextCachePrefixContract,
  diffCachePrefixContracts,
  summarizeCachePrefixContract,
} from "../lib/llm/cache-prefix-contract.ts";
import { buildSessionCacheSnapshot as buildSessionCacheSnapshotValue } from "./session-cache-snapshot.ts";
import { stripClosedInternalNarrationBlocks } from "../lib/text/internal-narration.ts";
import { buildTurnInputPresentationEvent } from "../lib/turn-input-presentation.ts";
import { executeWukongAgentRuntimeTask, isWukongRuntimeAgent } from "../lib/wukong/runtime-adapter.ts";

const log = createModuleLogger("session");

/** Default tool allowlist for patrol/cron tasks. "*" means allow all chat tools. */
export const PATROL_TOOLS_DEFAULT = "*";

type DynamicRecord = Record<string, unknown>;
type UnknownRecord = Record<string, unknown>;

type PluginSessionMetaInput = {
  ownerPluginId?: unknown;
  sessionKind?: unknown;
  sessionVisibility?: unknown;
};

type SessionWorkspaceMountInput = {
  workspaceMountId?: unknown;
  workspaceLabel?: unknown;
};

type SessionListOptions = {
  ownerPluginId?: unknown;
  includePluginPrivate?: unknown;
};

type HistoryMessageLike = {
  role?: unknown;
  content?: unknown;
  timestamp?: unknown;
  [key: string]: unknown;
};

type SessionBranchEntry = {
  type?: unknown;
  message?: HistoryMessageLike;
  timestamp?: unknown;
};

type SessionRuntimeKeyOptions = {
  create?: boolean;
  manifestDefaults?: UnknownRecord;
};

type DeletedAgentCompactionSession = {
  sessionManager?: { getSessionFile?: () => string | null };
  model?: unknown;
  settingsManager?: { getCompactionSettings?: () => unknown };
  thinkingLevel?: unknown;
  agent?: {
    state?: { systemPrompt?: string | null; thinkingLevel?: unknown };
    id?: string | null;
    streamFn?: unknown;
    streamFunction?: unknown;
    sessionId?: unknown;
    onPayload?: unknown;
    onResponse?: unknown;
    transport?: unknown;
    thinkingBudgets?: unknown;
    maxRetryDelayMs?: unknown;
    convertToLlm?: unknown;
  };
  systemPrompt?: string | null;
  agentId?: string | null;
  _emit?: (event: unknown) => void;
  [key: string]: unknown;
};

type CachePrefixContractLike = {
  systemPrompt?: string;
  tools?: unknown[];
};

type ExecuteIsolatedOptions = {
  agentId?: string | null;
  cwd?: string | null;
  model?: { id?: string; provider?: string; [key: string]: unknown } | null;
  persist?: string | null | false;
  resumeSessionPath?: string | null;
  forceLocalRuntime?: boolean;
  runBudget?: RunBudget;
  workflowRuntimeGuard?: (snapshot: unknown) => { replay: true; result: unknown } | null;
  subagentContext?: boolean;
  parentSessionPath?: string | null;
  subagentTaskId?: string | null;
  subagentThreadId?: string | null;
  subagentThreadKind?: string | null;
  workflowContext?: boolean;
  images?: unknown[];
  videos?: unknown[];
  audios?: unknown[];
  workspaceFolders?: string[];
  authorizedFolders?: string[];
  permissionMode?: string | null;
  fileReadSessionPaths?: unknown[];
  toolFilter?: "*" | string[];
  builtinFilter?: string[];
  extraCustomTools?: Array<{ name?: string; [key: string]: unknown }>;
  activityType?: string | null;
  withMemory?: boolean;
  emitEvents?: boolean;
  onSessionReady?: (sessionPath: string | null) => void;
  signal?: AbortSignal;
  [key: string]: unknown;
};

function rewriteSessionManagerFile(sessionManager) {
  const rewriteFile = (sessionManager as DynamicRecord | null | undefined)?._rewriteFile;
  if (typeof rewriteFile === "function") rewriteFile.call(sessionManager);
}

function cacheContractDebugEnabled() {
  return process.env.CODIA_CACHE_CONTRACT_DEBUG === "1"
    || process.env.CODIA_CACHE_CONTRACT_DEBUG === "1";
}

function getSteerPrefix() {
  const isZh = getLocale().startsWith("zh");
  return isZh ? "（插话，无需 MOOD）\n" : "(Interjection, no MOOD needed)\n";
}
function assertVideoInputSupported(model, videos) {
  if (!videos?.length) return;
  if (!modelSupportsVideoInput(model)) {
    throw new Error("current model does not support video input");
  }
}

function assertAudioInputSupported(model, audios) {
  if (!audios?.length) return;
  if (!modelSupportsAudioInput(model)) {
    throw new Error("current model does not support audio input");
  }
  if (!modelSupportsDirectAudioInput(model)) {
    throw new Error("current provider does not support direct audio input");
  }
}

function buildPromptMediaOptions(opts) {
  const streamingBehavior = normalizeStreamingBehavior(opts?.streamingBehavior);
  const media = [
    ...(opts?.images || []),
    ...(opts?.videos || []),
    ...(opts?.audios || []),
  ];
  if (!media.length && !streamingBehavior) return undefined;
  return {
    ...(media.length ? { images: media } : {}),
    ...(opts?.imageAttachmentPaths?.length ? { imageAttachmentPaths: opts.imageAttachmentPaths } : {}),
    ...(opts?.videoAttachmentPaths?.length ? { videoAttachmentPaths: opts.videoAttachmentPaths } : {}),
    ...(opts?.audioAttachmentPaths?.length ? { audioAttachmentPaths: opts.audioAttachmentPaths } : {}),
    ...(streamingBehavior ? { streamingBehavior } : {}),
  };
}

export function recordAssistantUsage({ ledger, event, session = null, sessionPath, sessionId = null, agentId, model, source, attribution }) {
  if (!ledger || hasUsageBudgetGuard(session) || event?.type !== "message_end" || event.message?.role !== "assistant" || isUsageAccounted(event.message)) return null;
  const usageContext = {
    source,
    attribution: attribution || {
      kind: "session",
      agentId: agentId || null,
      ...(sessionId ? { sessionId } : {}),
      sessionPath,
    },
  };
  const modelMeta = {
    ...model,
    provider: model?.provider ?? null,
    modelId: model?.id ?? null,
    api: model?.api ?? null,
  };
  if (event.message?.usage) {
    return ledger.record({
      model: modelMeta,
      usage: event.message.usage,
      usageContext,
      costRates: model?.cost,
    });
  }
  const errorMessage = event.message?.errorMessage || event.message?.error?.message || null;
  if (event.message?.stopReason === "error" || errorMessage) {
    const request = ledger.start({
      observationOnly: true,
      model: modelMeta,
      usageContext,
      costRates: model?.cost,
    });
    return ledger.recordError(request.requestId, new Error(errorMessage || "provider request failed"));
  }
  return ledger.record({ model: modelMeta, usage: null, usageContext, costRates: model?.cost });
}

function collectAssistantTextFromMessage(message) {
  if (!message) return "";
  if (typeof message.text === "string") return message.text;
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      if (typeof part.text === "string") return part.text;
      if (typeof part.content === "string") return part.content;
      return "";
    })
    .filter(Boolean)
    .join("");
}

function normalizePluginSessionMeta({ ownerPluginId, sessionKind, sessionVisibility }: PluginSessionMetaInput = {}) {
  const pluginId = typeof ownerPluginId === "string" && ownerPluginId.trim()
    ? ownerPluginId.trim()
    : null;
  const kind = typeof sessionKind === "string" && sessionKind.trim()
    ? sessionKind.trim()
    : null;
  const visibility = typeof sessionVisibility === "string" && sessionVisibility.trim()
    ? sessionVisibility.trim()
    : "public";
  if (!pluginId && !kind && visibility === "public") return null;
  return {
    ownerPluginId: pluginId,
    kind,
    visibility,
  };
}

function normalizeSessionWorkspaceMount({ workspaceMountId, workspaceLabel }: SessionWorkspaceMountInput = {}) {
  const mountId = typeof workspaceMountId === "string" && workspaceMountId.trim()
    ? workspaceMountId.trim()
    : null;
  if (!mountId) return null;
  return {
    mountId,
    label: typeof workspaceLabel === "string" && workspaceLabel.trim() ? workspaceLabel.trim() : null,
  };
}

function sessionMatchesListOptions(sessionLike, options: SessionListOptions = {}) {
  const ownerPluginId = typeof options.ownerPluginId === "string" && options.ownerPluginId.trim()
    ? options.ownerPluginId.trim()
    : null;
  const includePluginPrivate = options.includePluginPrivate === true;
  const sessionOwnerPluginId = sessionLike?.ownerPluginId || null;
  const visibility = sessionLike?.visibility || sessionLike?.sessionVisibility || "public";
  if (sessionLike?.visibleInSessionList === false && !includePluginPrivate) return false;
  if (ownerPluginId && sessionOwnerPluginId !== ownerPluginId) return false;
  if (
    (visibility === "plugin_private" || visibility === "private")
    && !includePluginPrivate
    && sessionOwnerPluginId !== ownerPluginId
  ) {
    return false;
  }
  return true;
}

function timestampFromHistoryMessage(message: HistoryMessageLike | null | undefined, fallback = Date.now()) {
  if (typeof message?.timestamp === "number" && Number.isFinite(message.timestamp)) return message.timestamp;
  if (typeof message?.timestamp === "string") {
    const parsed = Date.parse(message.timestamp);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function normalizeDeletedAgentTranscriptMessage(message: HistoryMessageLike | null | undefined) {
  if (!message || typeof message !== "object") return null;
  if (message.role !== "user" && message.role !== "assistant") return null;
  const { text } = extractTextContent(message.content, {
    stripThink: message.role === "assistant",
  });
  const trimmed = String(text || "").trim();
  if (!trimmed) return null;
  return {
    role: message.role,
    content: [{ type: "text", text: trimmed }],
    timestamp: timestampFromHistoryMessage(message),
  };
}

function isSessionBranchMessage(entry: unknown): entry is SessionBranchEntry & { message: HistoryMessageLike } {
  return Boolean(
    entry
      && typeof entry === "object"
      && (entry as SessionBranchEntry).type === "message"
      && (entry as SessionBranchEntry).message
      && typeof (entry as SessionBranchEntry).message === "object",
  );
}

function readSessionBranchMessages(sessionPath: string) {
  try {
    const manager = SessionManager.open(sessionPath, path.dirname(sessionPath));
    const branch = manager.getBranch() as unknown[];
    const messages = branch
      .filter(isSessionBranchMessage)
      .map(entry => ({
        ...entry.message,
        timestamp: entry.message.timestamp ?? entry.timestamp ?? null,
      }));
    if (messages.length > 0) return messages;
  } catch (err) {
    log.warn(`deleted-agent continuation: branch read fallback for ${path.basename(String(sessionPath))}: ${err?.message || err}`);
  }

  try {
    const raw = fs.readFileSync(sessionPath, "utf-8");
    return raw
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(isSessionBranchMessage)
      .map(entry => ({
        ...entry.message,
        timestamp: entry.message.timestamp ?? entry.timestamp ?? null,
      }));
  } catch {
    return [];
  }
}

function addUniqueSessionFile(target, file) {
  if (!file || typeof file !== "object") return;
  const key = file.id || file.fileId || file.filePath || file.path || file.realPath || JSON.stringify(file);
  if (target.some((existing) => (
    (existing.id || existing.fileId || existing.filePath || existing.path || existing.realPath || JSON.stringify(existing)) === key
  ))) {
    return;
  }
  target.push(file);
}

function collectSessionFilesFromToolResult(result) {
  const files = [];
  const details = result?.details;
  addUniqueSessionFile(files, details?.sessionFile);
  if (Array.isArray(details?.sessionFiles)) {
    for (const file of details.sessionFiles) addUniqueSessionFile(files, file);
  }
  return files;
}

function toolErrorSummary(event) {
  const toolName = event?.toolName || event?.name || "tool";
  const raw = event?.error || event?.result?.error || event?.result?.message || event?.message;
  const message = typeof raw === "string" ? raw : raw?.message || "";
  return message ? `${toolName}: ${message}` : `${toolName}: failed`;
}

function isolatedCompletionError(stopReason, errorMessage) {
  if (!stopReason || stopReason === "stop") return null;
  const message = typeof errorMessage === "string" ? errorMessage : errorMessage?.message;
  if (stopReason === "error") {
    return message || "assistant message ended with stopReason=error";
  }
  if (stopReason === "length") {
    return "assistant message ended with stopReason=length (output limit reached)";
  }
  return `assistant message ended with stopReason=${stopReason}`;
}

function normalizeStreamingBehavior(value) {
  return value === "steer" || value === "followUp" ? value : undefined;
}

function isSdkAlreadyProcessingError(err) {
  const message = err?.message || String(err || "");
  return message.includes("Agent is already processing")
    && message.includes("streamingBehavior");
}

async function promptWithProcessingFallback(session, text, promptOpts) {
  try {
    await session.prompt(text, promptOpts);
  } catch (err) {
    if (isSdkAlreadyProcessingError(err) && !promptOpts?.streamingBehavior) {
      const busy = new Error("session_busy");
      busy.cause = err;
      throw busy;
    }
    throw err;
  }
}

const MAX_CACHED_SESSIONS = 20;
const SESSION_PROMPT_SNAPSHOT_VERSION = 1;
const AUTO_COMPACTION_THRESHOLD = 0.9;
const DEFAULT_SESSION_PLUGIN_TOOL_NAMES = new Map([
  ["image-gen", new Set([
    "generate-image",
    "generate-video",
    "image-gen_generate-image",
    "image-gen_generate-video",
  ])],
]);

function contextUsageRatio(usage) {
  const tokens = Number(usage?.tokens);
  const contextWindow = Number(usage?.contextWindow);
  if (Number.isFinite(tokens) && Number.isFinite(contextWindow) && contextWindow > 0) {
    return tokens / contextWindow;
  }
  const rawPercent = Number(usage?.percent);
  if (Number.isFinite(rawPercent)) {
    return rawPercent > 1 ? rawPercent / 100 : rawPercent;
  }
  return null;
}

function jsonClone(value, fallback) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
}

function normalizeStringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

function uniqueToolNames(toolNames) {
  const seen = new Set();
  const unique = [];
  for (const name of toolNames || []) {
    if (typeof name !== "string" || !name || seen.has(name)) continue;
    seen.add(name);
    unique.push(name);
  }
  return unique;
}

function isDefaultSessionPluginTool(tool) {
  if (!tool?._pluginId || typeof tool.name !== "string") return false;
  return DEFAULT_SESSION_PLUGIN_TOOL_NAMES.get(tool._pluginId)?.has(tool.name) === true;
}

function toolNamesFromObjects(tools, { includePluginTools = true } = {}) {
  return uniqueToolNames(
    (tools || [])
      .filter((tool) => includePluginTools || !tool?._pluginId || isDefaultSessionPluginTool(tool))
      .map((tool) => tool?.name)
      .filter(Boolean),
  );
}

function freezeSkillsResult(value) {
  const next = {
    skills: Array.isArray(value) ? value : (Array.isArray(value?.skills) ? value.skills : []),
    diagnostics: Array.isArray(value?.diagnostics) ? value.diagnostics : [],
  };
  return jsonClone(next, { skills: [], diagnostics: [] });
}

function freezeAgentsFilesResult(value) {
  const next = {
    agentsFiles: Array.isArray(value?.agentsFiles) ? value.agentsFiles : [],
  };
  return jsonClone(next, { agentsFiles: [] });
}

function normalizePromptSnapshot(value) {
  if (!value || typeof value !== "object") return null;
  if (value.version !== SESSION_PROMPT_SNAPSHOT_VERSION) return null;
  if (typeof value.systemPrompt !== "string") return null;
  return {
    version: SESSION_PROMPT_SNAPSHOT_VERSION,
    systemPrompt: value.systemPrompt,
    appendSystemPrompt: normalizeStringArray(value.appendSystemPrompt),
    skillsResult: freezeSkillsResult(value.skillsResult),
    agentsFilesResult: freezeAgentsFilesResult(value.agentsFilesResult),
    ...(typeof value.finalSystemPrompt === "string"
      ? { finalSystemPrompt: value.finalSystemPrompt }
      : {}),
  };
}

function computeRuntimeDisabledToolNames(tools, agentConfig, context = {}) {
  const disabled = [];
  for (const tool of tools || []) {
    if (!tool?.name || typeof tool.isEnabledForAgentConfig !== "function") continue;
    try {
      if (!tool.isEnabledForAgentConfig(agentConfig, context)) {
        disabled.push(tool.name);
      }
    } catch (err) {
      log.warn(`tool "${tool.name}" runtime enablement check failed, disabling for fresh session: ${err.message}`);
      disabled.push(tool.name);
    }
  }
  return disabled;
}

function buildBackgroundTaskPrompt(locale) {
  const isZh = String(locale || "").startsWith("zh");
  return isZh
    ? `## 后台任务

派出 subagent 或其他后台任务后：
1. 先继续做手头还没做完的工作，不要立刻停下来等
2. 手头工作做完后，调 check_pending_tasks 查看后台任务状态
3. 如果还有任务未完成，根据任务复杂度自行估算等待时间，调 wait 等待后再检查。最多检查 2 次，之后不再轮询，告知用户任务仍在后台运行，完成后会自动通知
4. 后台任务完成时系统也会通过 <codia-background-result> 消息自动送达结果，届时处理并告知用户`
    : `## Background Tasks

After dispatching a subagent or other background task:
1. Continue with any remaining work first; do not stop immediately to wait
2. Once your other work is done, call check_pending_tasks to check status
3. If tasks are still pending, estimate a reasonable wait time based on task complexity, then call wait and check again. Check at most 2 times; after that, stop polling and inform the user the task is still running and they will be notified when it completes
4. The system will also automatically deliver results via <codia-background-result> messages when tasks finish; process and relay them to the user`;
}
export class SessionCoordinator {
  [key: string]: any;

  /**
   * @param {object} deps
   * @param {string} deps.agentsDir
   * @param {() => object} deps.getAgent - current focused agent
   * @param {() => string} deps.getActiveAgentId
   * @param {() => import('./model-manager.ts').ModelManager} deps.getModels
   * @param {() => object} deps.getResourceLoader
   * @param {() => import('./skill-manager.ts').SkillManager} deps.getSkills
    *
   * @param {(event, sp) => void} deps.emitEvent
   * @param {() => string|null} deps.getHomeCwd
   * @param {(path) => string|null} deps.agentIdFromSessionPath
   * @param {(id) => Promise} deps.switchAgentOnly - switch only the focused agent pointer
   * @param {() => object} deps.getConfig
   * @param {() => Map} deps.getAgents
   * @param {(agentId) => object} deps.getActivityStore
   * @param {(agentId) => object|null} deps.getAgentById
   * @param {() => object} deps.listAgents - list all agents
   * @param {(cwd: string) => Promise<void>} [deps.onBeforeSessionCreate]
   */
  constructor(deps) {
    this._d = deps;
    this._pendingModel = null;
    this._session = null;
    this._currentSessionPath = null;
    this._sessionStarted = false;
    this._sessions = new Map();
    this._headlessOps = new Set();
    this._titlesCache = new Map(); // sessionDir -> { titles, ts }
    this._metaCache = new Map();   // metaPath -> { data, ts }
    this._sessionListProjectionCache = deps.sessionListProjectionCache || new SessionListProjectionCache();
    this._sessionManifestStore = deps.sessionManifestStore || null;
    this._pendingPermissionMode = null;
    this._runtimePermissionModeDefault = null;
    this._metaWriteQueue = Promise.resolve();
    this._activeTraceContexts = new Map();
    this._prePromptAbortControllers = new Map();
    this._turnContextBySession = new Map();
  }

  static _TITLES_TTL = 60_000; // 60 seconds
  get session() { return this._session; }
  get sessionStarted() { return this._sessionStarted; }
  get sessions() { return this._sessions; }

  _executionControl(sessionPath) {
    if (!sessionPath) return new RunController();
    const control = loadExecutionRun(sessionPath, run => this._d.emitEvent?.({ type: "execution_run", run }, sessionPath));
    const store = this._d.getDeferredResultStore?.();
    for (const id of control.snapshot()?.pendingTasks || []) {
      const task = store?.query?.(id);
      if (task && task.status !== "pending") control.finishTask(id);
    }
    return control;
  }

  _beginExecutionRun(session) {
    const run = session?.codiaRunControl;
    if (!run) return null;
    run.begin();
    return run.enter();
  }

  getExecutionRun(sessionPath) { return this._executionControl(sessionPath).snapshot(); }
  acknowledgeExecutionRun(sessionPath, runId, revision, toolIds) {
    return this._executionControl(sessionPath).acknowledgeResults(runId, revision, toolIds);
  }

  async resumeExecutionRun(sessionPath, runId, revision) {
    const run = this._executionControl(sessionPath);
    run.resume(runId, revision);
    // The revision is consumed synchronously before any await.
    const pending = this.promptSession(sessionPath,
      "Continue the paused task from the recorded progress. Check current files and completed tool results; do not repeat completed writes. Keep the original goal and permissions.",
      {});
    pending.catch(error => {
      log.warn(`resume task failed: ${error?.message || error}`);
      if (run.canContinueAutomatically()) run.pause("resume_failed");
    });
    return run.snapshot();
  }

  setPendingModel(model) { this._pendingModel = model; }
  get pendingModel() { return this._pendingModel; }

  _getDefaultThinkingLevelForModel(model = null) {
    const models = this._d.getModels();
    const fallback = normalizeSessionThinkingLevel(this._d.getPrefs().getThinkingLevel());
    const targetModel = model || this._pendingModel || models?.currentModel || null;
    if (typeof models?.getModelDefaultThinkingLevel === "function") {
      return models.getModelDefaultThinkingLevel(targetModel, fallback);
    }
    return resolveModelDefaultThinkingLevel(targetModel, fallback);
  }

  getDefaultThinkingLevel() {
    return this._getDefaultThinkingLevelForModel();
  }

  async setDefaultThinkingLevel(level) {
    const models = this._d.getModels();
    const fallback = normalizeSessionThinkingLevel(this._d.getPrefs().getThinkingLevel());
    const targetModel = this._pendingModel || models?.currentModel || null;
    if (!targetModel?.id || !targetModel.provider) {
      return { ok: false, error: "model not found", thinkingLevel: fallback };
    }
    if (typeof models.setModelDefaultThinkingLevel !== "function") {
      return { ok: false, error: "model thinking defaults unavailable", thinkingLevel: fallback };
    }
    const result = await models.setModelDefaultThinkingLevel(targetModel, level);
    if (
      this._pendingModel
      && result?.model?.id === this._pendingModel.id
      && result.model.provider === this._pendingModel.provider
    ) {
      this._pendingModel = result.model;
    }
    return {
      ok: true,
      thinkingLevel: normalizeSessionThinkingLevel(result?.thinkingLevel),
    };
  }

  get currentSessionPath() {
    return this._session?.sessionManager?.getSessionFile?.() ?? this._currentSessionPath ?? null;
  }

  async reloadExtensionRunners(reason = "extension_factories_changed") {
    const summary = { reloaded: 0, skipped: 0, failed: 0 };
    for (const [sessionPath, entry] of this._sessions) {
      const session = entry?.session;
      if (!session || typeof session.reload !== "function") {
        summary.skipped += 1;
        continue;
      }
      if (session.isStreaming || session.isCompacting || entry._switching) {
        summary.skipped += 1;
        continue;
      }
      try {
        await session.reload();
        entry.lastTouchedAt = Date.now();
        summary.reloaded += 1;
      } catch (err) {
        summary.failed += 1;
        log.warn(`reload extensions failed for ${path.basename(sessionPath)} (${reason}): ${err?.message || err}`);
      }
    }
    return summary;
  }

  _normalizeSessionPath(sessionPath) {
    if (!sessionPath) return "";
    try {
      // Match the manifest store's identity boundary, including Windows 8.3
      // aliases, canonical casing and directory junctions for existing files.
      return sessionLocatorKey(String(sessionPath));
    } catch {
      const fallback = String(sessionPath).replace(/\\/g, "/");
      return process.platform === "win32" ? fallback.toLowerCase() : fallback;
    }
  }

  _getTraceStore() {
    return this._d.runtimeTraceStore || this._d.getRuntimeTraceStore?.() || null;
  }

  _traceKey(sessionPath) {
    return this._sessionIdForPath(sessionPath) || this._normalizeSessionPath(sessionPath || "");
  }

  _getActiveTraceContext(sessionPath) {
    const key = this._traceKey(sessionPath);
    return key ? (this._activeTraceContexts.get(key) || null) : null;
  }

  _setActiveTraceContext(sessionPath, traceContext) {
    const key = this._traceKey(sessionPath);
    if (!key) return;
    if (traceContext) this._activeTraceContexts.set(key, traceContext);
    else this._activeTraceContexts.delete(key);
  }

  _startLifecycleTrace({ sessionPath, agentId, kind = "chat_turn", text, opts, model }) {
    const store = this._getTraceStore();
    if (!store || typeof store.startTrace !== "function") return null;
    try {
      const trace = store.startTrace({
        traceId: opts?.traceId,
        sessionPath: sessionPath || null,
        agentId: agentId || null,
        kind,
      });
      if (!trace?.traceId) return null;
      const traceContext = {
        traceId: trace.traceId,
        sessionPath: sessionPath || null,
        agentId: agentId || null,
      };
      this._setActiveTraceContext(sessionPath, traceContext);
      this._recordLifecyclePhase(traceContext, "input.received", {
        summary: "user input received",
        details: {
          textLength: typeof text === "string" ? text.length : 0,
          hasImages: Array.isArray(opts?.images) && opts.images.length > 0,
          hasVideos: Array.isArray(opts?.videos) && opts.videos.length > 0,
        },
      });
      this._recordLifecyclePhase(traceContext, "message.parsed", {
        summary: "message parsed",
        details: {
          hasDisplayMessage: opts?.displayMessage != null,
        },
      });
      this._recordLifecyclePhase(traceContext, "context.assembled", {
        summary: "runtime context assembled",
        details: {
          sessionPath,
          agentId,
        },
      });
      if (model) {
        this._recordLifecyclePhase(traceContext, "model.route", {
          summary: "selected provider/model",
          details: {
            role: "chat",
            providerId: model.provider || null,
            modelId: model.id || model.name || null,
          },
        });
      }
      return traceContext;
    } catch (err) {
      log.warn(`runtime trace start failed: ${err.message}`);
      return null;
    }
  }

  _recordLifecyclePhase(traceContext, phase, input = {}) {
    if (!traceContext?.traceId) return;
    const store = this._getTraceStore();
    if (!store || typeof store.recordPhase !== "function") return;
    try {
      store.recordPhase(traceContext.traceId, phase, input);
    } catch (err) {
      log.warn(`runtime trace phase failed: ${err.message}`);
    }
  }

  _endLifecycleTrace(traceContext, input = {}) {
    if (!traceContext?.traceId) return;
    const store = this._getTraceStore();
    if (!store || typeof store.endTrace !== "function") return;
    try {
      store.endTrace(traceContext.traceId, input);
    } catch (err) {
      log.warn(`runtime trace end failed: ${err.message}`);
    } finally {
      this._setActiveTraceContext(traceContext.sessionPath, null);
    }
  }

  _recordLifecycleEvent(sessionPath, event) {
    const traceContext = this._getActiveTraceContext(sessionPath);
    if (!traceContext) return;
    if (event?.type === "message_update") {
      const sub = event.assistantMessageEvent;
      if (sub?.type === "text_delta") {
        this._recordLifecyclePhase(traceContext, "model.stream.delta", {
          summary: "assistant text delta",
          details: { deltaLength: String(sub.delta || "").length },
        });
      } else if (sub?.type === "toolcall_start") {
        this._recordLifecyclePhase(traceContext, "tool.detected", {
          summary: "tool call detected",
        });
      }
      return;
    }
    if (event?.type === "tool_execution_start") {
      this._recordLifecyclePhase(traceContext, "tool.detected", {
        summary: "tool execution started",
        details: { toolName: event.toolName || null },
      });
      return;
    }
    if (event?.type === "tool_execution_end") {
      this._recordLifecyclePhase(traceContext, "tool.execute", {
        summary: "tool execution finished",
        details: { toolName: event.toolName || null, success: !event.isError },
      });
    }
  }

  _resolveSessionManifestForPath(sessionPath) {
    if (!this._sessionManifestStore || !sessionPath) return null;
    try {
      return this._sessionManifestStore.resolveByLocatorPath(sessionPath);
    } catch (err) {
      log.warn(`session manifest lookup failed for ${path.basename(String(sessionPath))}: ${err?.message || err}`);
      return null;
    }
  }

  _resolveSessionManifestForId(sessionId) {
    if (!this._sessionManifestStore || !sessionId) return null;
    try {
      return this._sessionManifestStore.getBySessionId(sessionId);
    } catch (err) {
      log.warn(`session manifest lookup failed for ${sessionId}: ${err?.message || err}`);
      return null;
    }
  }

  _normalizeSessionRef(ref) {
    if (typeof ref === "string") return { sessionId: null, sessionPath: ref };
    if (!ref || typeof ref !== "object") return { sessionId: null, sessionPath: null };
    const sessionId = typeof ref.sessionId === "string" && ref.sessionId.trim()
      ? ref.sessionId.trim()
      : null;
    const sessionPath = typeof ref.sessionPath === "string" && ref.sessionPath.trim()
      ? ref.sessionPath
      : (typeof ref.path === "string" && ref.path.trim() ? ref.path : null);
    return { sessionId, sessionPath };
  }

  _resolveSessionWriteRef(ref, operation = "session") {
    const normalized = this._normalizeSessionRef(ref);
    if (normalized.sessionId) {
      const manifest = this._resolveSessionManifestForId(normalized.sessionId);
      if (!manifest) {
        const error = new Error(`${operation}: session manifest not found for ${normalized.sessionId}`) as Error & { code?: string };
        error.code = "session_manifest_not_found";
        throw error;
      }
      return {
        sessionId: manifest.sessionId,
        sessionPath: manifest.currentLocator?.path || normalized.sessionPath,
        manifest,
      };
    }
    const manifest = this._resolveSessionManifestForPath(normalized.sessionPath);
    return {
      sessionId: manifest?.sessionId || null,
      sessionPath: manifest?.currentLocator?.path || normalized.sessionPath,
      manifest,
    };
  }

  _ensureSessionManifestForPath(sessionPath, input: UnknownRecord = {}) {
    if (!this._sessionManifestStore || !sessionPath) return null;
    try {
      const existing = this._sessionManifestStore.resolveByLocatorPath(sessionPath);
      if (existing) return existing;
      return this._sessionManifestStore.createForPath({
        sessionPath,
        ...(input || {}),
      });
    } catch (err) {
      log.warn(`session manifest create failed for ${path.basename(String(sessionPath))}: ${err?.message || err}`);
      return null;
    }
  }

  _sessionIdForPath(sessionPath) {
    try {
      return this._resolveSessionManifestForPath(sessionPath)?.sessionId || null;
    } catch {
      return null;
    }
  }

  _makeSessionLocatorStateError(operation: string, sessionPath: any, manifest: any) {
    const lifecycle = manifest?.lifecycle || "unknown";
    const currentPath = manifest?.currentLocator?.path || null;
    const error: any = new Error(
      `${operation}: session path is not runnable because its current lifecycle is ${lifecycle}`
      + (currentPath ? ` at ${currentPath}` : "")
      + `; requested ${sessionPath}`,
    );
    error.code = "session_locator_not_active";
    error.status = 409;
    error.sessionId = manifest?.sessionId || null;
    error.currentPath = currentPath;
    error.lifecycle = lifecycle;
    return error;
  }

  _assertCurrentActiveSessionLocator(sessionPath: any, operation: string) {
    if (!sessionPath) return null;
    const manifest = this._resolveSessionManifestForPath(sessionPath);
    if (!manifest) return null;
    const currentPath = manifest.currentLocator?.path;
    const requestedPath = this._normalizeSessionPath(sessionPath);
    if (manifest.lifecycle && manifest.lifecycle !== "active") {
      throw this._makeSessionLocatorStateError(operation, sessionPath, manifest);
    }
    if (currentPath && this._normalizeSessionPath(currentPath) !== requestedPath) {
      throw this._makeSessionLocatorStateError(operation, sessionPath, manifest);
    }
    return manifest;
  }

  _isCurrentActiveSessionLocator(sessionPath: any) {
    try {
      const manifest = this._resolveSessionManifestForPath(sessionPath);
      if (!manifest) return true;
      if (manifest.lifecycle && manifest.lifecycle !== "active") return false;
      const currentPath = manifest.currentLocator?.path;
      return !currentPath || this._normalizeSessionPath(currentPath) === this._normalizeSessionPath(sessionPath);
    } catch {
      return false;
    }
  }

  async moveSessionLifecycle({ fromPath = null, toPath = null, lifecycle = null, reason = "session_lifecycle", manifestDefaults = {} }: any = {}) {
    if (!this._sessionManifestStore || typeof this._sessionManifestStore.updateLocatorLifecycle !== "function") {
      const error: any = new Error("Session manifest lifecycle transition is unavailable.");
      error.code = "session_manifest_unavailable";
      error.status = 503;
      throw error;
    }
    if (!toPath) {
      const error: any = new Error("moveSessionLifecycle: toPath is required");
      error.code = "session_lifecycle_path_required";
      error.status = 400;
      throw error;
    }
    if (lifecycle !== "active" && lifecycle !== "archived") {
      const error: any = new Error(`moveSessionLifecycle: unsupported lifecycle ${lifecycle || "(empty)"}`);
      error.code = "session_lifecycle_invalid";
      error.status = 400;
      throw error;
    }

    let manifest = null;
    for (const candidate of [fromPath, toPath]) {
      if (!candidate) continue;
      manifest = this._resolveSessionManifestForPath(candidate);
      if (manifest) break;
    }
    if (!manifest) {
      const seedPath = fromPath || toPath;
      const initialLifecycle = isArchivedDesktopSessionPath(seedPath, this._d.agentsDir) ? "archived" : "active";
      manifest = this._ensureSessionManifestForPath(seedPath, {
        ownerAgentId: this._d.agentIdFromSessionPath?.(seedPath) || null,
        domain: "desktop",
        kind: "chat",
        lifecycle: initialLifecycle,
        provenance: { createdBy: "session_lifecycle_transition" },
        locatorReason: reason,
        ...(manifestDefaults || {}),
      });
    }
    if (!manifest?.sessionId) {
      const error: any = new Error("moveSessionLifecycle: session manifest could not be established");
      error.code = "session_manifest_not_found";
      error.status = 404;
      throw error;
    }

    const updated = this._sessionManifestStore.updateLocatorLifecycle(
      manifest.sessionId,
      toPath,
      lifecycle,
      reason,
    );
    if (!updated?.currentLocator?.path || path.resolve(updated.currentLocator.path) !== path.resolve(toPath) || updated.lifecycle !== lifecycle) {
      const error: any = new Error("moveSessionLifecycle: manifest transition verification failed");
      error.code = "session_lifecycle_transition_failed";
      error.status = 500;
      error.sessionId = manifest.sessionId;
      error.toPath = toPath;
      error.lifecycle = lifecycle;
      throw error;
    }
    return updated;
  }

  _sessionRuntimeKeyForPath(sessionPath, opts: SessionRuntimeKeyOptions = {}) {
    if (!this._sessionManifestStore) return sessionPath;
    const manifest = opts.create
      ? this._ensureSessionManifestForPath(sessionPath, opts.manifestDefaults || {})
      : this._resolveSessionManifestForPath(sessionPath);
    return manifest?.sessionId || sessionPath;
  }

  _sessionTitleKeyForPath(sessionPath) {
    return this._sessionIdForPath(sessionPath) || sessionPath;
  }

  _sessionTitleFromMap(titles, sessionPath, extraLegacyPaths: string[] = []) {
    if (!titles || !sessionPath) return null;
    const keys = [];
    const sessionId = this._sessionIdForPath(sessionPath);
    if (sessionId) keys.push(sessionId);
    keys.push(sessionPath);
    keys.push(path.basename(sessionPath));
    for (const legacyPath of extraLegacyPaths || []) {
      if (legacyPath) {
        const legacySessionId = this._sessionIdForPath(legacyPath);
        if (legacySessionId) keys.push(legacySessionId);
        keys.push(legacyPath);
        keys.push(path.basename(legacyPath));
      }
    }
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(titles, key) && titles[key]) return titles[key];
    }
    return null;
  }

  _resolveSessionEntry(sessionPath) {
    if (!sessionPath) return null;
    const { sessionId, sessionPath: inputPath } = this._normalizeSessionRef(sessionPath);
    if (sessionId) {
      const exactById = this._sessions.get(sessionId);
      if (exactById) return { key: sessionId, entry: exactById };
    }
    const manifest = inputPath ? this._resolveSessionManifestForPath(inputPath) : null;
    if (manifest?.sessionId) {
      const exactByManifest = this._sessions.get(manifest.sessionId);
      if (exactByManifest) return { key: manifest.sessionId, entry: exactByManifest };
    }
    const lookupPath = inputPath || sessionPath;
    const exact = this._sessions.get(lookupPath);
    if (exact) return { key: lookupPath, entry: exact };

    const normalized = this._normalizeSessionPath(lookupPath);
    const basename = path.basename(String(lookupPath));
    for (const [key, entry] of this._sessions.entries()) {
      if (this._normalizeSessionPath(key) === normalized) {
        return { key, entry };
      }
      const entryPath = entry?.session?.sessionManager?.getSessionFile?.()
        || entry?.sessionPath
        || entry?.path
        || null;
      if (entryPath && this._normalizeSessionPath(entryPath) === normalized) {
        return { key, entry };
      }
    }
    for (const [key, entry] of this._sessions.entries()) {
      if (path.basename(String(key)) === basename) {
        return { key, entry };
      }
      const entryPath = entry?.session?.sessionManager?.getSessionFile?.()
        || entry?.sessionPath
        || entry?.path
        || null;
      if (entryPath && path.basename(String(entryPath)) === basename) {
        return { key, entry };
      }
    }
    return null;
  }

  // Session creation / switching

  async _shouldIncludeLegacyArtifactToolForRestore(agent, sessionPath) {
    if (!sessionPath) return true;
    try {
      const metaPath = path.join(agent.sessionDir, "session-meta.json");
      const meta = await this._readMetaCached(metaPath);
      const metaEntry = meta[path.basename(sessionPath)];
      if (Array.isArray(metaEntry?.toolNames)) {
        return metaEntry.toolNames.includes("create_artifact");
      }
      return true;
    } catch (err) {
      return err.code === "ENOENT";
    }
  }

  async createSession(sessionMgr, cwd, memoryEnabled = true, model = null, {
    restore = false,
    agent: explicitAgent = null,
    agentId: explicitAgentId = null,
    preserveAgentMemoryState: _preserveAgentMemoryState = false,
    workspaceFolders = [],
    authorizedFolders = [],
    visibleInSessionList = null,
    thinkingLevel = null,
    workspaceMountId = null,
    workspaceLabel = null,
    ownerPluginId = null,
    sessionKind = null,
    sessionVisibility = null,
    refreshCapabilitySnapshots = false,
  } = {}) {
    const t0 = Date.now();
    const agent = explicitAgent
      || (explicitAgentId ? this._d.getAgentById?.(explicitAgentId) : null)
      || this._d.getAgent();
    if (!agent) throw new Error("createSession: target agent unavailable");
    const ownerAgentId = explicitAgentId || agent.id || this._d.getActiveAgentId();
    const configuredHomeCwd = this._d.getHomeCwd(agent.id);
    const effectiveCwd = cwd || configuredHomeCwd || process.cwd();
    if (!restore && !cwd && isDefaultWorkspacePath(configuredHomeCwd) && isDefaultWorkspacePath(effectiveCwd)) {
      restoreDefaultWorkspaceIfMissing(effectiveCwd);
    }
    const models = this._d.getModels();
    // In restore mode, do not pass a model. PI SDK restores it from JSONL.
    const effectiveModel = restore ? null : (model || this._pendingModel || models.currentModel);
    this._pendingModel = null;
    log.log(`createSession cwd=${effectiveCwd} restore=${restore} (input: ${cwd || "unspecified"})`);

    await this._d.onBeforeSessionCreate?.(effectiveCwd);

    if (!restore && !effectiveModel) {
      throw new Error(t("error.noAvailableModel"));
    }
    if (!sessionMgr) {
      sessionMgr = SessionManager.create(effectiveCwd, agent.sessionDir);
    }
    const sessionPathForMeta = sessionMgr.getSessionFile?.() || null;
    let restoredPluginSessionMeta = null;
    let restoredWorkspaceMount = null;
    if (restore && sessionPathForMeta) {
      try {
        const metaPath = path.join(agent.sessionDir, "session-meta.json");
        const meta = await this._readMetaCached(metaPath);
        const metaEntry = meta[path.basename(sessionPathForMeta)];
        restoredPluginSessionMeta = metaEntry?.plugin || null;
        restoredWorkspaceMount = normalizeSessionWorkspaceMount({
          workspaceMountId: metaEntry?.workspaceMountId,
          workspaceLabel: metaEntry?.workspaceLabel,
        });
      } catch (err) {
        if (err.code !== "ENOENT") {
          log.warn(`session plugin/workspace mount restore failed: ${err.message}`);
        }
      }
    }
    const pluginSessionMeta = normalizePluginSessionMeta({
      ownerPluginId: ownerPluginId ?? restoredPluginSessionMeta?.ownerPluginId,
      sessionKind: sessionKind ?? restoredPluginSessionMeta?.kind,
      sessionVisibility: sessionVisibility ?? restoredPluginSessionMeta?.visibility,
    });
    const workspaceMount = normalizeSessionWorkspaceMount({
      workspaceMountId: workspaceMountId ?? restoredWorkspaceMount?.mountId,
      workspaceLabel: workspaceLabel ?? restoredWorkspaceMount?.label,
    });
    let restoredThinkingLevel = null;
    if (restore && sessionPathForMeta) {
      try {
        const metaPath = path.join(agent.sessionDir, "session-meta.json");
        const meta = await this._readMetaCached(metaPath);
        const metaEntry = meta[path.basename(sessionPathForMeta)];
        if (typeof metaEntry?.thinkingLevel === "string") {
          restoredThinkingLevel = metaEntry.thinkingLevel;
        }
      } catch (err) {
        if (err.code !== "ENOENT") {
          log.warn(`session thinking level restore failed: ${err.message}`);
        }
      }
    }
    const restoredPromptSnapshot = restore && sessionPathForMeta && !refreshCapabilitySnapshots
      ? await this._readSessionPromptSnapshot(agent, sessionPathForMeta)
      : null;
    const restoredPromptModel = restore && !restoredPromptSnapshot
      ? this._resolvePromptModelFromSessionManager(sessionMgr, models)
      : null;
    const promptPatchModel = restoredPromptSnapshot ? null : (effectiveModel || restoredPromptModel);
    const requestedThinkingLevel = normalizeSessionThinkingLevel(
      restore
        ? (restoredThinkingLevel || this._getDefaultThinkingLevelForModel(promptPatchModel))
        : (thinkingLevel ?? this._getDefaultThinkingLevelForModel(effectiveModel)),
    );
    let initialThinkingLevel = promptPatchModel
      ? normalizeThinkingLevelForModel(requestedThinkingLevel, promptPatchModel)
      : normalizeSessionThinkingLevel(requestedThinkingLevel);
    let resolvedThinkingLevel = models.resolveThinkingLevel(initialThinkingLevel);
    const providerPromptPatches = promptPatchModel
      ? getProviderPromptPatches(promptPatchModel, {
        reasoningLevel: resolvedThinkingLevel,
        locale: agent.config?.locale || getLocale(),
      })
      : [];

    let workspaceScope = normalizeWorkspaceScope({
      primaryCwd: effectiveCwd,
      workspaceFolders,
    });
    let folderScope = normalizeSessionFolderScope({
      primaryCwd: effectiveCwd,
      workspaceFolders: workspaceScope.workspaceFolders,
      authorizedFolders,
    });
    if (restore && sessionPathForMeta) {
      try {
        const metaPath = path.join(agent.sessionDir, "session-meta.json");
        const meta = await this._readMetaCached(metaPath);
        const metaEntry = meta[path.basename(sessionPathForMeta)];
        const restoredFolders = metaEntry?.workspaceFolders;
        const restoredAuthorizedFolders = metaEntry?.authorizedFolders;
        workspaceScope = normalizeWorkspaceScope({
          primaryCwd: effectiveCwd,
          workspaceFolders: restoredFolders,
        });
        folderScope = normalizeSessionFolderScope({
          primaryCwd: effectiveCwd,
          workspaceFolders: workspaceScope.workspaceFolders,
          authorizedFolders: restoredAuthorizedFolders,
        });
      } catch {}
    }
    const includeLegacyArtifactTool = restore
      ? await this._shouldIncludeLegacyArtifactToolForRestore(agent, sessionPathForMeta)
      : false;

    const restoredMemoryEnabled = restore && sessionPathForMeta
      ? this._readSessionMemoryEnabledFromMeta(sessionPathForMeta)
      : null;
    const frozenMemoryEnabled = restore
      ? (typeof restoredMemoryEnabled === "boolean" ? restoredMemoryEnabled : !!memoryEnabled)
      : (agent.memoryMasterEnabled !== false && !!memoryEnabled);
    let restoredExperienceEnabled = false;
    if (restore && sessionPathForMeta) {
      try {
        const metaPath = path.join(agent.sessionDir, "session-meta.json");
        const meta = await this._readMetaCached(metaPath);
        restoredExperienceEnabled = meta[path.basename(sessionPathForMeta)]?.experienceEnabled === true;
      } catch (err) {
        if (err.code !== "ENOENT") {
          log.warn(`session-meta.json experienceEnabled restore failed: ${err.message}`);
        }
      }
    }
    const agentHasExperienceSwitch = typeof agent.experienceEnabled === "boolean";
    const frozenExperienceEnabled = restore
      ? restoredExperienceEnabled
      : (agentHasExperienceSwitch ? agent.experienceEnabled === true : false);

    const baseResourceLoader = this._d.getResourceLoader();
    let restoredPermissionMode = null;
    if (restore && sessionPathForMeta) {
      try {
        const metaPath = path.join(agent.sessionDir, "session-meta.json");
        const meta = await this._readMetaCached(metaPath);
        const metaEntry = meta[path.basename(sessionPathForMeta)];
        if (metaEntry) restoredPermissionMode = normalizeSessionPermissionMode(metaEntry);
      } catch (err) {
        if (err.code !== "ENOENT") {
          log.warn(`session permission mode restore failed: ${err.message}`);
        }
      }
    }
    let initialPermissionMode = restore
      ? normalizeSessionPermissionMode(restoredPermissionMode)
      : normalizeSessionPermissionMode(this._pendingPermissionMode || this._getDefaultPermissionMode());
    this._pendingPermissionMode = null;
    let initialAccessMode = legacyAccessModeFromPermissionMode(initialPermissionMode);
    let initialPlanMode = isReadOnlyPermissionMode(initialPermissionMode);
    const sessionEntry = {
      permissionMode: initialPermissionMode,
      accessMode: initialAccessMode,
      planMode: initialPlanMode,
      thinkingLevel: initialThinkingLevel,
      sessionId: null as string | null,
    }; // pre-populated for resourceLoader proxy

    if (!restore && typeof agent.refreshAppearanceSummary === "function") {
      try {
        await agent.refreshAppearanceSummary({
          targetModel: promptPatchModel,
          rebuildSystemPrompt: true,
        });
      } catch (err) {
        log.warn(`agent appearance summary refresh failed: ${err?.message || err}`);
      }
    }

    // Per-session prompt snapshot.
    const rawPromptSnapshot = restoredPromptSnapshot?.systemPrompt
      ?? agent.buildSystemPrompt({
        forceMemoryEnabled: frozenMemoryEnabled,
        ...(agentHasExperienceSwitch ? { forceExperienceEnabled: frozenExperienceEnabled } : {}),
        targetModel: promptPatchModel,
      });
    const promptSnapshot = agent.agentDir ? sanitizeMemoryPrompt(rawPromptSnapshot, path.join(agent.agentDir, 'memory')) : rawPromptSnapshot;
    const appendSystemPromptSnapshot = restoredPromptSnapshot?.appendSystemPrompt
      ?? (() => {
        const parts = [
          ...(baseResourceLoader.getAppendSystemPrompt?.() || []),
          ...providerPromptPatches,
        ];
        if (this._d.getDeferredResultStore?.()) {
          parts.push(buildBackgroundTaskPrompt(agent.config?.locale || getLocale()));
        }
        const workspacePrompt = formatWorkspaceScopePrompt({
          primaryCwd: workspaceScope.primaryCwd,
          workspaceFolders: workspaceScope.workspaceFolders,
          locale: agent.config?.locale || getLocale(),
        });
        if (workspacePrompt) parts.push(workspacePrompt);
        return normalizeStringArray(parts);
      })();
    const rawSkillsResultSnapshot = restoredPromptSnapshot?.skillsResult
      ?? (
        this._d.getSkills?.()?.getSkillsForAgent?.(agent)
        || baseResourceLoader.getSkills?.()
        || { skills: [], diagnostics: [] }
      );
    const skillsResultSnapshot = restoredPromptSnapshot?.skillsResult
      ? freezeSkillsResult(restoredPromptSnapshot.skillsResult)
      : freezeSkillsResult(await snapshotSkillsForSession(rawSkillsResultSnapshot, sessionPathForMeta));
    const agentsFilesResultSnapshot = restoredPromptSnapshot?.agentsFilesResult
      ?? freezeAgentsFilesResult(baseResourceLoader.getAgentsFiles?.());
    const promptSnapshotForPersist = restoredPromptSnapshot || {
      version: SESSION_PROMPT_SNAPSHOT_VERSION,
      systemPrompt: promptSnapshot,
      appendSystemPrompt: appendSystemPromptSnapshot,
      skillsResult: skillsResultSnapshot,
      agentsFilesResult: agentsFilesResultSnapshot,
    };

    const getEngine = this._d.getEngine;
    const visionContextExtension = createVisionContextInjectionExtension({
      path: "codia-vision-context-injection",
      sessionPathRef: () => session?.sessionManager?.getSessionFile?.() || sessionPath || null,
      getVisionBridge: () => getEngine?.()?.getVisionBridge?.() || null,
      isVisionAuxiliaryEnabled: () => getEngine?.()?.isVisionAuxiliaryEnabled?.() === true,
      resolveSessionFile: ({ fileId, filePath, sessionPath: lookupPath }) => {
        const engine = getEngine?.();
        const lookupSessionPath = lookupPath || session?.sessionManager?.getSessionFile?.() || sessionPath || null;
        if (fileId) return engine?.getSessionFile?.(fileId, { sessionPath: lookupSessionPath });
        if (filePath) return engine?.getSessionFileByPath?.(filePath, { sessionPath: lookupSessionPath });
        return null;
      },
      warn: (msg) => log.warn(msg),
    } as unknown as Parameters<typeof createVisionContextInjectionExtension>[0]);
    const turnContextExtension = createSessionTurnContextExtension({
      path: "codia-desktop-session-turn-context",
      sessionPathRef: () => session?.sessionManager?.getSessionFile?.() || sessionPathForMeta || null,
      getTurnContext: (targetSessionPath) => targetSessionPath
        ? this._turnContextBySession.get(targetSessionPath)
          || this._turnContextBySession.get(this._sessionIdForPath(targetSessionPath))
          || null
        : null,
    });

    // Wrap resourceLoader: per-session prompt snapshot + plan mode injection
    const resourceLoader = Object.create(baseResourceLoader, {
      getSystemPrompt: {
        value: () => promptSnapshot,
      },
      getExtensions: {
        value: () => {
          const base = baseResourceLoader.getExtensions?.() ?? { extensions: [], errors: [] };
          return {
            ...base,
            extensions: [turnContextExtension, visionContextExtension, ...(base.extensions || [])],
          };
        },
      },
      getAppendSystemPrompt: {
        value: () => [...appendSystemPromptSnapshot],
      },
      getSkills: {
        value: () => resolveSessionSkillsForRuntime(skillsResultSnapshot),
      },
      getAgentsFiles: {
        value: () => freezeAgentsFilesResult(agentsFilesResultSnapshot),
      },
    });

    const agentToolsSnapshot = typeof agent.getToolsSnapshot === "function"
      ? agent.getToolsSnapshot({
        forceMemoryEnabled: frozenMemoryEnabled,
        model: effectiveModel,
        ...(agentHasExperienceSwitch ? { forceExperienceEnabled: frozenExperienceEnabled } : {}),
        ...(includeLegacyArtifactTool ? { includeLegacyArtifactTool: true } : {}),
      })
      : agent.tools;
    const { tools: sessionTools, customTools: sessionCustomTools } = this._d.buildTools(
      effectiveCwd,
      agentToolsSnapshot,
      {
        workspace: effectiveCwd,
        workspaceFolders: workspaceScope.workspaceFolders,
        authorizedFolders: folderScope.authorizedFolders,
        getAuthorizedFolders: () => this.getSessionAuthorizedFolders(
          sessionMgr?.getSessionFile?.() || sessionPathForMeta,
        ),
        agentDir: agent.agentDir,
        getSessionPath: () => sessionMgr?.getSessionFile?.() || null,
        getTraceContext: () => this._getActiveTraceContext(sessionMgr?.getSessionFile?.() || null),
      },
    );
    const sessionOpts: DynamicRecord = {
      cwd: effectiveCwd,
      sessionManager: sessionMgr,
      settingsManager: this._createSettings(effectiveModel),
      modelRuntime: models.modelRuntime,
      thinkingLevel: resolvedThinkingLevel,
      resourceLoader,
      tools: sessionTools,
      customTools: sessionCustomTools,
      executionControl: this._executionControl(sessionMgr?.getSessionFile?.()),
    };
    // New sessions pass a model. Restored sessions read the model from JSONL.
    if (effectiveModel) sessionOpts.model = effectiveModel;
    const { session, modelFallbackMessage } = await createAgentSession(sessionOpts);
    installMemoryAppendGuard(session, agent.agentDir);
    if (modelFallbackMessage) {
      log.warn(`session model fallback: ${modelFallbackMessage}`);
    }
    const resolvedModel = session.model;
    const actualThinkingLevel = normalizeThinkingLevelForModel(initialThinkingLevel, resolvedModel);
    if (actualThinkingLevel !== initialThinkingLevel) {
      initialThinkingLevel = actualThinkingLevel;
      resolvedThinkingLevel = models.resolveThinkingLevel(initialThinkingLevel);
      session.setThinkingLevel?.(resolvedThinkingLevel);
    }
    const elapsed = Date.now() - t0;
    log.log(`session created (${elapsed}ms), model=${resolvedModel?.name || effectiveModel?.name || "?"}`);
    const sessionPath = session.sessionManager?.getSessionFile?.();
    this._session = session;
    this._currentSessionPath = sessionPath || null;
    this._sessionStarted = false;

 //
    if (restore && sessionPath && restoredPermissionMode === null) {
      try {
        const metaPath = path.join(agent.sessionDir, "session-meta.json");
        const meta = await this._readMetaCached(metaPath);
        const metaEntry = meta[path.basename(sessionPath)];
        if (metaEntry) {
          initialPermissionMode = normalizeSessionPermissionMode(metaEntry);
          initialAccessMode = legacyAccessModeFromPermissionMode(initialPermissionMode);
          initialPlanMode = isReadOnlyPermissionMode(initialPermissionMode);
          sessionEntry.permissionMode = initialPermissionMode;
          sessionEntry.accessMode = initialAccessMode;
          sessionEntry.planMode = initialPlanMode;
        }
      } catch (err) {
        if (err.code !== "ENOENT") {
          log.warn(`session permission mode restore failed: ${err.message}`);
        }
      }
    }
    const creatingAgentId = ownerAgentId;
    installUsageBudgetGuard(session, () => this._d.getUsageLedger?.(), () => ({
      source: { subsystem: 'session', operation: 'reply', surface: 'desktop', trigger: 'user' },
      attribution: { kind: 'session', agentId: creatingAgentId, sessionPath, sessionId: session.sessionManager?.getSessionId?.() || null },
    }), model => findModel(this._d.getModels().availableModels, model.id, model.provider));
    const manifestDefaults = sessionPath ? {
      ownerAgentId: creatingAgentId,
      domain: "desktop",
      kind: pluginSessionMeta?.kind || "chat",
      lifecycle: "active",
      memoryPolicy: {
        mode: frozenMemoryEnabled ? "enabled" : "disabled",
        inheritedFrom: "session_create",
      },
      permissionModeSnapshot: {
        mode: initialPermissionMode,
        source: "session_create",
      },
      thinkingLevel: initialThinkingLevel,
      workspaceScope: {
        primaryCwd: workspaceScope.primaryCwd,
        workspaceFolders: workspaceScope.workspaceFolders,
        authorizedFolders: folderScope.authorizedFolders,
        ...(workspaceMount?.mountId ? {
          workspaceMount: {
            mountId: workspaceMount.mountId,
            ...(workspaceMount.label ? { label: workspaceMount.label } : {}),
          },
        } : {}),
      },
      plugin: pluginSessionMeta,
      locatorReason: restore ? "restore" : "create",
      migration: restore ? { createdBy: "session_restore" } : { createdBy: "session_create" },
    } : null;
    const manifest = sessionPath ? this._ensureSessionManifestForPath(sessionPath, manifestDefaults) : null;
    if (manifest?.sessionId) sessionEntry.sessionId = manifest.sessionId;
    const unsub = session.subscribe((event) => {
      recordAssistantUsage({
          session,
        ledger: this._d.getUsageLedger?.(),
        event,
        sessionPath,
        sessionId: manifest?.sessionId || null,
        agentId: creatingAgentId,
        model: resolvedModel,
        source: {
          subsystem: "session",
          operation: "reply",
          surface: "desktop",
          trigger: "user",
        },
        attribution: {
          kind: "session",
          agentId: creatingAgentId || null,
          ...(manifest?.sessionId ? { sessionId: manifest.sessionId } : {}),
          sessionPath,
        },
      });
      this._recordLifecycleEvent(sessionPath, event);
      const eventAgent = event as { agentId?: unknown };
      this._d.emitEvent(
        eventAgent.agentId ? event : { ...event, agentId: creatingAgentId },
        sessionPath,
      );
    });

    // Store in the map. sessionEntry is the same object the resourceLoader proxy references.
    const mapKey = manifest?.sessionId || sessionPath || `_anon_${Date.now()}`;
    const old = this._sessions.get(mapKey);
    if (old) old.unsub();

    // Tool snapshot for session-tool-isolation (parallels session-model-isolation)
    // Three branches:
    //   A. restore=true + meta has toolNames  -> replay the snapshot (applied below)
    //   B. restore=true + meta missing        -> legacy session, keep stable tools
    //   C. restore=false                      -> fresh compute from agent config
    //
    // allToolNames must cover the COMPLETE active set: Pi SDK built-ins
    // (read/bash/edit/write/grep/find/ls) from sessionTools + Codia
    // customs + plugin tools from sessionCustomTools. Using only agent.tools
    // would silently drop SDK built-ins and plugin tools when
    // setActiveToolsByName is applied.
    const allToolObjects = [
      ...(sessionTools || []),
      ...(sessionCustomTools || []),
    ];
    const allToolNames = toolNamesFromObjects(allToolObjects);
    const stableRestoreToolNames = toolNamesFromObjects(allToolObjects, {
      includePluginTools: false,
    });
    const channelsEnabled = this._d.getPrefs?.()?.getChannelsEnabled?.();
    const stableFeatureDisabledToolNames = getStableFeatureDisabledToolNames({
      channelsEnabled,
    });
    const runtimeDisabledToolNames = computeRuntimeDisabledToolNames(
      allToolObjects,
      agent.config,
      { agentId: creatingAgentId, restore, channelsEnabled },
    );
    const extraDisabledToolNames = [
      ...stableFeatureDisabledToolNames,
      ...runtimeDisabledToolNames,
    ];
    const disabledForLiveTools = agent.config?.tools?.disabled ?? DEFAULT_DISABLED_TOOL_NAMES;
    const liveToolNamesForDrift = computeToolSnapshot(allToolNames, disabledForLiveTools, {
      extraDisabled: extraDisabledToolNames,
    });
    let snapshotToolNames = null;  // null signals "do not call setActiveToolsByName"
    let droppedSnapshotToolNames = [];
    let capabilityDrift = null;
    let capabilityDriftDismissedFingerprint = null;
    let shouldPersistRestoredToolNames = false;

    if (restore) {
      if (sessionPath) {
        const metaPathForRestore = path.join(agent.sessionDir, "session-meta.json");
        let metaEntry = null;
        try {
          const raw = await fsp.readFile(metaPathForRestore, "utf-8");
          const meta = JSON.parse(raw);
          metaEntry = meta[path.basename(sessionPath)];
        } catch (err) {
          if (err.code !== "ENOENT") {
            log.warn(`session-meta read for tool-snapshot restore failed, recomputing from current agent config: ${err.message}`);
          }
        }
        capabilityDriftDismissedFingerprint = metaEntry?.capabilityDriftDismissedFingerprint || null;
        if (refreshCapabilitySnapshots) {
          const disabled = agent.config?.tools?.disabled ?? DEFAULT_DISABLED_TOOL_NAMES;
          snapshotToolNames = computeToolSnapshot(allToolNames, disabled, {
            extraDisabled: extraDisabledToolNames,
          });
          shouldPersistRestoredToolNames = true;
          capabilityDriftDismissedFingerprint = null;
        } else if (metaEntry && Array.isArray(metaEntry.toolNames)) {
          const restoredToolNames = uniqueToolNames(metaEntry.toolNames);
          const gatedRestoredToolNames = computeToolSnapshot(restoredToolNames, [], {
            extraDisabled: stableFeatureDisabledToolNames,
          });
          const repairedSnapshot = repairRestoredToolSnapshotDetailed(gatedRestoredToolNames, allToolNames);
          snapshotToolNames = repairedSnapshot.toolNames;
          droppedSnapshotToolNames = repairedSnapshot.droppedToolNames;
          shouldPersistRestoredToolNames = !sameToolNames(snapshotToolNames, metaEntry.toolNames);
        } else {
          // Legacy sessions created before tool snapshots had no stable tool
          // identity boundary. Establish one on first restore so future plugin
          // or dynamic tool registrations only affect newly created sessions.
          const disabled = agent.config?.tools?.disabled ?? DEFAULT_DISABLED_TOOL_NAMES;
          snapshotToolNames = computeToolSnapshot(stableRestoreToolNames, disabled, {
            extraDisabled: extraDisabledToolNames,
          });
          shouldPersistRestoredToolNames = true;
        }
      }
    } else {
      // Case C. Fresh agents (and agents upgrading from a pre-feature version)
      // have no tools.disabled field - apply DEFAULT_DISABLED_TOOL_NAMES so
      // update_settings and dm are off by default. Explicit `[]` means "all on"
      // and is preserved via nullish-coalescing rather than `||`.
      const disabled = agent.config?.tools?.disabled ?? DEFAULT_DISABLED_TOOL_NAMES;
      snapshotToolNames = computeToolSnapshot(allToolNames, disabled, {
        extraDisabled: extraDisabledToolNames,
      });
    }

    Object.assign(sessionEntry, {
      session,
      sessionPath,
      sessionId: manifest?.sessionId || null,
      agentId: creatingAgentId,
      memoryEnabled: frozenMemoryEnabled,
      experienceEnabled: frozenExperienceEnabled,
      modelId: resolvedModel?.id || effectiveModel?.id || null,
      modelProvider: resolvedModel?.provider || effectiveModel?.provider || null,
      workspaceFolders: workspaceScope.workspaceFolders,
      workspaceMountId: workspaceMount?.mountId || null,
      workspaceLabel: workspaceMount?.label || null,
      authorizedFolders: folderScope.authorizedFolders,
      permissionMode: initialPermissionMode,
      accessMode: initialAccessMode,
      planMode: initialPlanMode,
      thinkingLevel: initialThinkingLevel,
      toolNames: snapshotToolNames,
      liveToolNames: liveToolNamesForDrift,
      capabilityDrift,
      capabilityDriftDismissedFingerprint,
      visibleInSessionList: !restore && (
        visibleInSessionList === true
        || (visibleInSessionList == null && !!this._sessionManifestStore)
      ),
      ownerPluginId: pluginSessionMeta?.ownerPluginId || null,
      sessionKind: pluginSessionMeta?.kind || null,
      sessionVisibility: pluginSessionMeta?.visibility || "public",
      lastTouchedAt: Date.now(),
      _promptInFlight: false,
      unsub,
    });
    this._sessions.set(mapKey, sessionEntry);
    if (sessionPath && mapKey !== sessionPath) this._sessions.delete(sessionPath);

    // Apply tool snapshot (Case A / Case C). Permission mode is enforced by the
    // session-permission wrapper, so the stable tool schema stays unchanged.
    if (snapshotToolNames !== null) {
      session.setActiveToolsByName(snapshotToolNames);
    }

    if (restoredPromptSnapshot?.finalSystemPrompt) {
      this._applyFinalPromptSnapshot(session, agent.agentDir ? sanitizeMemoryPrompt(restoredPromptSnapshot.finalSystemPrompt, path.join(agent.agentDir, 'memory')) : restoredPromptSnapshot.finalSystemPrompt);
    }
    const finalSystemPrompt = this._getFinalSystemPrompt(session);
    if (restore && sessionPath && snapshotToolNames !== null) {
      try {
        const disabled = agent.config?.tools?.disabled ?? DEFAULT_DISABLED_TOOL_NAMES;
        const liveToolNames = computeToolSnapshot(allToolNames, disabled, {
          extraDisabled: extraDisabledToolNames,
        });
        capabilityDrift = buildSessionCapabilityDrift({
          frozenToolNames: snapshotToolNames,
          liveToolNames,
          invalidToolNames: droppedSnapshotToolNames,
          frozenSystemPrompt: restoredPromptSnapshot?.finalSystemPrompt
            || restoredPromptSnapshot?.systemPrompt
            || "",
          liveSystemPrompt: finalSystemPrompt || "",
        });
        (sessionEntry as DynamicRecord).capabilityDrift = capabilityDrift;
      } catch (err) {
        log.warn(`capability drift detection failed for ${path.basename(sessionPath)}: ${err.message}`);
      }
    }
    const promptSnapshotToWrite = finalSystemPrompt
      ? { ...promptSnapshotForPersist, finalSystemPrompt }
      : promptSnapshotForPersist;
    this._renewCachePrefixContract(sessionPath || mapKey, sessionEntry, restore ? "restore" : "create");
    this._installCachePrefixGuard(sessionPath || mapKey, sessionEntry);

    // Persist fresh snapshots and repair/establish restored snapshots. Legacy
    // sessions get a stable baseline on first restore so plugin registrations
    // in newer builds do not silently alter old conversations.
    if (!restore && sessionPath) {
      const metaPatch: DynamicRecord = {
        memoryEnabled: frozenMemoryEnabled,
        experienceEnabled: frozenExperienceEnabled,
        visibleInSessionList: (sessionEntry as DynamicRecord).visibleInSessionList === true,
        workspaceFolders: workspaceScope.workspaceFolders,
        memoryProjectId: resolveMemoryProjectId(effectiveCwd),
        authorizedFolders: folderScope.authorizedFolders,
        permissionMode: initialPermissionMode,
        accessMode: initialAccessMode,
        planMode: initialPlanMode,
        thinkingLevel: initialThinkingLevel,
        promptSnapshot: promptSnapshotToWrite,
      };
      if (workspaceMount?.mountId) {
        metaPatch.workspaceMountId = workspaceMount.mountId;
        metaPatch.workspaceLabel = workspaceMount.label || null;
      }
      if (pluginSessionMeta) {
        metaPatch.plugin = pluginSessionMeta;
      }
      if (snapshotToolNames !== null) metaPatch.toolNames = snapshotToolNames;
      await this.writeSessionMeta(sessionPath, metaPatch);
    } else if (restore && sessionPath) {
      const metaPatch: DynamicRecord = {};
      if (!restoredPromptSnapshot) metaPatch.promptSnapshot = promptSnapshotToWrite;
      if (shouldPersistRestoredToolNames && snapshotToolNames !== null) {
        metaPatch.toolNames = snapshotToolNames;
      }
      if (refreshCapabilitySnapshots) {
        metaPatch.capabilityDriftDismissedFingerprint = null;
      }
      if (Object.keys(metaPatch).length > 0) {
        await this.writeSessionMeta(sessionPath, metaPatch);
      }
    }

    // A restore must never retrofit today's environment onto legacy conversation history.
    // For previously recorded sessions the helper preserves the first snapshot and marks changes ambiguous.
    if (sessionPath && (!restore || fs.existsSync(`${sessionPath}.memory-runtime.json`))) {
      try {
        let appVersion = null;
        if (agent.productDir) {
          try { appVersion = JSON.parse(fs.readFileSync(path.join(agent.productDir, '..', 'package.json'), 'utf8')).version || null; } catch {}
        }
        const environment = buildTrustedMemoryContext({
          cwd: effectiveCwd, sessionPath, appVersion,
          bridgeMetadata: agent._cb?.getEngine?.()?.getBridgeContextForSessionPath?.(sessionPath),
        });
        persistMemoryRuntimeSnapshot(sessionPath, {...environment, cwd: effectiveCwd, provenance: 'recorded'});
      } catch (error) { log.warn(`Session memory environment unavailable: ${error.message}`); }
    }

    // LRU eviction by lastTouchedAt, skipping the focused and streaming sessions.
    if (this._sessions.size > MAX_CACHED_SESSIONS) {
      const focusPath = this.currentSessionPath;
      const focusKey = focusPath ? this._sessionRuntimeKeyForPath(focusPath) : null;
      const candidates = [...this._sessions.entries()]
        .filter(([key, e]) => key !== mapKey && key !== focusPath && key !== focusKey && !e.session.isStreaming)
        .sort((a, b) => a[1].lastTouchedAt - b[1].lastTouchedAt);
      for (const [key, entry] of candidates) {
        // Best-effort memory flush. Do not block eviction on cleanup work.
        const evictedAgent = this._d.getAgentById(entry.agentId) || this._d.getAgent();
        evictedAgent?._memoryTicker?.notifySessionEnd(key).catch((err) =>
          log.warn(`LRU eviction ${path.basename(key)}: notifySessionEnd failed: ${err.message}`),
        );
        await this._teardownSessionEntry(entry, key, "lru");
        this._d.getDeferredResultStore?.()?.clearBySession(key);
        this._sessions.delete(key);
        await this._notifySessionRuntimeDiscarded(key, "lru");
        if (this._sessions.size <= MAX_CACHED_SESSIONS) break;
      }
    }

    return { session, sessionPath: sessionPath || mapKey, sessionId: manifest?.sessionId || null, agentId: creatingAgentId };
  }

  async createDetachedSession({
    sessionMgr = null,
    cwd = undefined,
    memoryEnabled = true,
    model = null,
    agent = null,
    agentId = null,
    preserveAgentMemoryState = false,
    workspaceFolders = [],
    authorizedFolders = [],
    visibleInSessionList = true,
    permissionMode = null,
    thinkingLevel = null,
    workspaceMountId = null,
    workspaceLabel = null,
    ownerPluginId = null,
    sessionKind = null,
    sessionVisibility = null,
  } = {}) {
    const prevFocus = this._session;
    const prevCurrentSessionPath = this._currentSessionPath;
    const prevSessionStarted = this._sessionStarted;
    const prevPendingPermissionMode = this._pendingPermissionMode;

    if (permissionMode !== null && permissionMode !== undefined) {
      this._pendingPermissionMode = normalizeSessionPermissionMode(permissionMode);
    }

    try {
      return await this.createSession(sessionMgr, cwd, memoryEnabled, model, {
        agent,
        agentId,
        preserveAgentMemoryState,
        workspaceFolders,
        authorizedFolders,
        visibleInSessionList,
        thinkingLevel,
        workspaceMountId,
        workspaceLabel,
        ownerPluginId,
        sessionKind,
        sessionVisibility,
      });
    } finally {
      this._session = prevFocus;
      this._currentSessionPath = prevCurrentSessionPath;
      this._sessionStarted = prevSessionStarted;
      this._pendingPermissionMode = prevPendingPermissionMode;
    }
  }

  async continueDeletedAgentSession(sourceSessionPath: string) {
    this._assertActiveDesktopSessionPath(sourceSessionPath, "continueDeletedAgentSession");
    const sourceAgentId = this._d.agentIdFromSessionPath(sourceSessionPath);
    if (!sourceAgentId) {
      throw new Error(`continueDeletedAgentSession: cannot resolve source agentId for ${sourceSessionPath}`);
    }
    if (!this._d.isAgentDeleted?.(sourceAgentId)) {
      throw new Error(`continueDeletedAgentSession: source agent "${sourceAgentId}" is not deleted`);
    }
    try {
      await fsp.access(sourceSessionPath);
    } catch {
      throw new Error("continueDeletedAgentSession: source session not found");
    }

    const primaryAgentId = this._d.getPrefs?.()?.getPrimaryAgent?.() || this._d.getActiveAgentId?.();
    const targetAgent = primaryAgentId
      ? this._d.getAgentById?.(primaryAgentId)
      : this._d.getAgent();
    if (!targetAgent) {
      throw new Error(`continueDeletedAgentSession: primary agent "${primaryAgentId || "(missing)"}" not found`);
    }
    if (this._d.isAgentDeleted?.(targetAgent.id)) {
      throw new Error(`continueDeletedAgentSession: primary agent "${targetAgent.id}" has been deleted`);
    }

    let sourceCwd = null;
    try {
      const sourceManager = SessionManager.open(sourceSessionPath, path.dirname(sourceSessionPath));
      sourceCwd = sourceManager.getCwd?.() || null;
    } catch {
      sourceCwd = null;
    }
    const targetCwd = sourceCwd || this._d.getHomeCwd?.(targetAgent.id) || process.cwd();
    const sourceMessages = readSessionBranchMessages(sourceSessionPath);
    const transcriptMessages = sourceMessages
      .map(normalizeDeletedAgentTranscriptMessage)
      .filter(Boolean);
    if (transcriptMessages.length === 0) {
      throw new Error("continueDeletedAgentSession: source session has no displayable transcript");
    }

    let createdSessionPath = null;
    try {
      const result = await this.createSession(null, targetCwd, true, null, {
        agent: targetAgent,
        agentId: targetAgent.id,
        visibleInSessionList: true,
      });
      const session = result.session;
      createdSessionPath = result.sessionPath;
      const manager = session.sessionManager;
      for (const message of transcriptMessages) {
        manager.appendMessage(message as unknown as Parameters<typeof manager.appendMessage>[0]);
      }
      if (session.model?.provider && session.model?.id) {
        manager.appendModelChange(session.model.provider, session.model.id);
      }

      await this.writeSessionMeta(createdSessionPath, {
        continuedFrom: {
          sourceSessionPath,
          sourceAgentId,
          sourceAgentDeleted: true,
          migratedAt: new Date().toISOString(),
        },
      });

      let compacted = false;
      let compactionError = null;
      try {
        await this._freshCompactDeletedAgentContinuation(session, transcriptMessages, {
          sourceSessionPath,
          sourceAgentId,
        });
        compacted = true;
      } catch (error) {
        compactionError = error?.message || String(error);
      }
      rewriteSessionManagerFile(manager);

      return {
        session,
        sessionPath: createdSessionPath,
        agentId: targetAgent.id,
        agentName: targetAgent.agentName || targetAgent.name || targetAgent.id,
        cwd: manager.getCwd?.() || targetCwd,
        workspaceFolders: this.getSessionWorkspaceFolders(createdSessionPath),
        authorizedFolders: this.getSessionAuthorizedFolders(createdSessionPath),
        compacted,
        compactionError,
      };
    } catch (err) {
      if (createdSessionPath) {
        try { await this.discardSessionRuntime(createdSessionPath, "deleted agent continuation failed"); } catch {}
        try { await fsp.rm(createdSessionPath, { force: true }); } catch {}
      }
      throw err;
    }
  }

  async _freshCompactDeletedAgentContinuation(
    session: unknown,
    transcriptMessages: HistoryMessageLike[],
    { sourceSessionPath, sourceAgentId }: { sourceSessionPath: string; sourceAgentId: string },
  ) {
    const compactSession = session as DeletedAgentCompactionSession;
    if (!compactSession?.sessionManager) throw new Error("deleted-agent continuation compaction requires a session manager");
    const model = compactSession.model;
    if (!model) throw new Error("deleted-agent continuation compaction requires a model");
    const settings = compactSession.settingsManager?.getCompactionSettings?.() || this._createSettings(model)?.getCompactionSettings?.();
    const tokensBefore = transcriptMessages.reduce(
      (sum, message) => sum + estimateTokens(message as unknown as Parameters<typeof estimateTokens>[0]),
      0,
    );
    const preparation = {
      messagesToSummarize: transcriptMessages,
      turnPrefixMessages: [],
      previousSummary: null,
      isSplitTurn: false,
      firstKeptEntryId: null,
      tokensBefore,
      settings,
      fileOps: { read: new Set(), written: new Set(), edited: new Set() },
    };
    compactSession?._emit?.({ type: "compaction_start", reason: "deleted_agent_continue" });
    try {
      const result = await createCachePreservingCompactionResult({
        preparation,
        model,
        systemPrompt: compactSession.agent?.state?.systemPrompt ?? compactSession.systemPrompt,
        customInstructions: [
          "This is a fresh continuation summary created from a read-only session whose agent was deleted.",
          `Source agent id: ${sourceAgentId}.`,
          `Source session path: ${sourceSessionPath}.`,
          "Summarize the old transcript so the new primary agent can continue without depending on the deleted agent runtime.",
        ].join(" "),
        thinkingLevel: compactSession.thinkingLevel ?? compactSession.agent?.state?.thinkingLevel,
        streamFn: compactSession.agent?.streamFunction ?? compactSession.agent?.streamFn,
        streamOptions: {
          sessionId: compactSession.agent?.sessionId,
          onPayload: compactSession.agent?.onPayload,
          onResponse: compactSession.agent?.onResponse,
          transport: compactSession.agent?.transport,
          thinkingBudgets: compactSession.agent?.thinkingBudgets,
          maxRetryDelayMs: compactSession.agent?.maxRetryDelayMs,
        },
        convertToLlm: compactSession.agent?.convertToLlm,
        usageLedger: this._d.getUsageLedger?.(),
        usageContext: {
          source: {
            subsystem: "compaction",
            operation: "deleted_agent_continue",
            surface: "desktop",
            trigger: "user",
          },
          attribution: {
            kind: "session",
            agentId: compactSession.agentId || compactSession.agent?.id || null,
            sessionPath: compactSession.sessionManager?.getSessionFile?.() || null,
          },
        },
      } as unknown as Parameters<typeof createCachePreservingCompactionResult>[0]);
      const saved = await appendCompactionResultToSession(session, result, { fromExtension: false });
      compactSession?._emit?.({
        type: "compaction_end",
        reason: "deleted_agent_continue",
        result: saved,
        aborted: false,
        willRetry: false,
      });
      return saved;
    } catch (error) {
      const message = error?.message || String(error);
      compactSession?._emit?.({
        type: "compaction_end",
        reason: "deleted_agent_continue",
        aborted: false,
        willRetry: false,
        errorMessage: `Compaction failed: ${message}`,
      });
      throw error;
    }
  }

  getSessionWorkspaceFolders(sessionPath = this.currentSessionPath) {
    if (!sessionPath) return [];
    const resolved = this._resolveSessionEntry(sessionPath);
    const entry = resolved?.entry;
    if (Array.isArray(entry?.workspaceFolders)) return [...entry.workspaceFolders];
    const manifest = this._resolveSessionManifestForPath(sessionPath);
    if (Array.isArray(manifest?.workspaceScope?.workspaceFolders)) {
      return normalizeWorkspaceScope({ workspaceFolders: manifest.workspaceScope.workspaceFolders }).workspaceFolders;
    }
    const metaEntry = this._readSessionMetaEntrySync(sessionPath);
    return Array.isArray(metaEntry?.workspaceFolders)
      ? normalizeWorkspaceScope({ workspaceFolders: metaEntry.workspaceFolders }).workspaceFolders
      : [];
  }

  getSessionWorkspaceMount(sessionPath = this.currentSessionPath) {
    if (!sessionPath) return null;
    const resolved = this._resolveSessionEntry(sessionPath);
    const entry = resolved?.entry;
    const liveMount = normalizeSessionWorkspaceMount({
      workspaceMountId: entry?.workspaceMountId,
      workspaceLabel: entry?.workspaceLabel,
    });
    if (liveMount) return liveMount;
    const manifest = this._resolveSessionManifestForPath(sessionPath);
    const manifestMount = normalizeSessionWorkspaceMount({
      workspaceMountId: manifest?.workspaceScope?.workspaceMount?.mountId,
      workspaceLabel: manifest?.workspaceScope?.workspaceMount?.label,
    });
    if (manifestMount) return manifestMount;
    const metaEntry = this._readSessionMetaEntrySync(sessionPath);
    return normalizeSessionWorkspaceMount({
      workspaceMountId: metaEntry?.workspaceMountId,
      workspaceLabel: metaEntry?.workspaceLabel,
    });
  }

  getSessionAuthorizedFolders(sessionPath = this.currentSessionPath) {
    if (!sessionPath) return [];
    const resolved = this._resolveSessionEntry(sessionPath);
    const entry = resolved?.entry;
    const folders = Array.isArray(entry?.authorizedFolders)
      ? entry.authorizedFolders
      : Array.isArray(this._resolveSessionManifestForPath(sessionPath)?.workspaceScope?.authorizedFolders)
        ? this._resolveSessionManifestForPath(sessionPath)?.workspaceScope?.authorizedFolders
      : this._readSessionMetaEntrySync(sessionPath)?.authorizedFolders;
    return normalizeSessionFolderScope({ authorizedFolders: folders }).authorizedFolders;
  }

  getSessionFolderScope(sessionPath = this.currentSessionPath) {
    const resolved = sessionPath ? this._resolveSessionEntry(sessionPath) : null;
    const entry = resolved?.entry || null;
    const manifest = sessionPath ? this._resolveSessionManifestForPath(sessionPath) : null;
    const metaEntry = sessionPath && !entry ? this._readSessionMetaEntrySync(sessionPath) : null;
    const cwd = this._sessionCwdFor(sessionPath, entry) || manifest?.workspaceScope?.primaryCwd || null;
    const scope = normalizeSessionFolderScope({
      primaryCwd: cwd,
      workspaceFolders: Array.isArray(entry?.workspaceFolders)
        ? entry.workspaceFolders
        : Array.isArray(manifest?.workspaceScope?.workspaceFolders)
          ? manifest.workspaceScope.workspaceFolders
        : metaEntry?.workspaceFolders,
      authorizedFolders: Array.isArray(entry?.authorizedFolders)
        ? entry.authorizedFolders
        : Array.isArray(manifest?.workspaceScope?.authorizedFolders)
          ? manifest.workspaceScope.authorizedFolders
        : metaEntry?.authorizedFolders,
    });
    return {
      sessionPath: sessionPath || null,
      cwd: scope.primaryCwd,
      workspaceFolders: scope.workspaceFolders,
      authorizedFolders: scope.authorizedFolders,
      sandboxFolders: scope.sandboxFolders,
    };
  }

  buildSessionCacheSnapshot(sessionPath = this.currentSessionPath, { reason = "unknown", messages = null } = {}) {
    const resolved = sessionPath ? this._resolveSessionEntry(sessionPath) : null;
    const entry = resolved?.entry;
    if (!entry?.session) {
      throw new Error(`Session cache snapshot unavailable: unknown session ${sessionPath || "(empty)"}`);
    }
    const session = entry.session;
    const state = session.agent?.state || {};
    const cacheContract = this._buildCachePrefixContract(entry);
    const snapshotMessages = Array.isArray(messages)
      ? messages
      : (Array.isArray(state.messages) ? state.messages : []);
    const thinkingLevel = entry.thinkingLevel
      ?? state.thinkingLevel
      ?? session.thinkingLevel
      ?? "off";
    const cachePrefixContract = cacheContract as CachePrefixContractLike | null | undefined;
    const snapshotOwner = this._d?.getAgentById?.(entry.agentId) || this._d?.getAgent?.();
    const safeContext = snapshotOwner?.agentDir ? guardMemoryContext({
      systemPrompt: cachePrefixContract?.systemPrompt ?? this._getFinalSystemPrompt(session) ?? '', messages: snapshotMessages,
    }, snapshotOwner.agentDir) : { systemPrompt: cachePrefixContract?.systemPrompt ?? this._getFinalSystemPrompt(session) ?? '', messages: snapshotMessages };
    return buildSessionCacheSnapshotValue({
      sessionPath: resolved.key || sessionPath,
      reason,
      model: session.model || state.model || null,
      cacheKeyParams: {
        thinkingLevel: thinkingLevel || "off",
      },
      systemPrompt: safeContext.systemPrompt,
      tools: cachePrefixContract?.tools ?? (Array.isArray(state.tools) ? state.tools : []),
      messages: safeContext.messages,
    });
  }

  async setSessionAuthorizedFolders(sessionPath, folders) {
    if (!isActiveSessionPath(sessionPath, this._d.agentsDir)) {
      throw new Error(`setSessionAuthorizedFolders: path must be in active desktop session agents/{id}/sessions/*.jsonl; got ${sessionPath}`);
    }
    const current = this.getSessionFolderScope(sessionPath);
    const scope = normalizeSessionFolderScope({
      primaryCwd: current.cwd,
      workspaceFolders: current.workspaceFolders,
      authorizedFolders: folders,
    });
    const resolved = this._resolveSessionEntry(sessionPath);
    if (resolved?.entry) {
      resolved.entry.workspaceFolders = [...scope.workspaceFolders];
      resolved.entry.authorizedFolders = [...scope.authorizedFolders];
    }
    const manifest = this._resolveSessionManifestForPath(sessionPath);
    if (manifest) {
      this._sessionManifestStore.setWorkspaceScope(manifest.sessionId, {
        primaryCwd: scope.primaryCwd,
        workspaceFolders: scope.workspaceFolders,
        authorizedFolders: scope.authorizedFolders,
      });
    }
    await this.writeSessionMeta(sessionPath, {
      workspaceFolders: scope.workspaceFolders,
      authorizedFolders: scope.authorizedFolders,
    });
    this._d.emitEvent?.({
      type: "app_event",
      event: {
        type: "session-authorized-folders-updated",
        payload: {
          sessionPath,
          authorizedFolders: scope.authorizedFolders,
          workspaceFolders: scope.workspaceFolders,
          sandboxFolders: scope.sandboxFolders,
        },
        source: "server",
      },
    }, sessionPath);
    return this.getSessionFolderScope(sessionPath);
  }

  async addSessionAuthorizedFolder(sessionPath, folder) {
    return this.setSessionAuthorizedFolders(sessionPath, [
      ...this.getSessionAuthorizedFolders(sessionPath),
      folder,
    ]);
  }

  async removeSessionAuthorizedFolder(sessionPath, folder) {
    const target = normalizeSessionFolderScope({ authorizedFolders: [folder] }).authorizedFolders[0];
    const current = this.getSessionAuthorizedFolders(sessionPath);
    return this.setSessionAuthorizedFolders(
      sessionPath,
      target ? current.filter((item) => item !== target) : current,
    );
  }

  _sessionCwdFor(sessionPath, entry = null) {
    if (entry?.cwd) return entry.cwd;
    const liveCwd = entry?.session?.sessionManager?.getCwd?.();
    if (liveCwd) return liveCwd;
    if (sessionPath && this._session?.sessionManager?.getSessionFile?.() === sessionPath) {
      return this._session.sessionManager?.getCwd?.() || null;
    }
    if (!sessionPath) return null;
    try {
      return SessionManager.open(sessionPath, path.dirname(sessionPath)).getCwd?.() || null;
    } catch {
      return null;
    }
  }

  _readSessionMetaEntrySync(sessionPath) {
    if (!sessionPath) return null;
    try {
      const metaPath = this._sessionMetaPathFor(sessionPath);
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
      const entry = meta[path.basename(sessionPath)];
      return entry && typeof entry === "object" ? entry : null;
    } catch {
      return null;
    }
  }

  _readSessionMemoryEnabledFromMeta(sessionPath) {
    const manifest = this._resolveSessionManifestForPath(sessionPath);
    if (manifest?.memoryPolicy?.mode === "enabled") return true;
    if (manifest?.memoryPolicy?.mode === "disabled") return false;
    const metaEntry = this._readSessionMetaEntrySync(sessionPath);
    return typeof metaEntry?.memoryEnabled === "boolean" ? metaEntry.memoryEnabled : null;
  }

  getSessionMemoryEnabled(sessionPath = this.currentSessionPath) {
    if (!sessionPath) return true;
    const resolved = this._resolveSessionEntry(sessionPath);
    if (typeof resolved?.entry?.memoryEnabled === "boolean") return resolved.entry.memoryEnabled;
    const manifest = this._resolveSessionManifestForPath(sessionPath);
    if (manifest?.memoryPolicy?.mode === "enabled") return true;
    if (manifest?.memoryPolicy?.mode === "disabled") return false;
    const stored = this._readSessionMemoryEnabledFromMeta(sessionPath);
    return typeof stored === "boolean" ? stored : true;
  }

  async setSessionMemoryEnabled(sessionPath, enabled) {
    if (!sessionPath) {
      return { ok: false, error: "session memory requires sessionPath", memoryEnabled: true };
    }
    this._assertActiveDesktopSessionPath(sessionPath, "setSessionMemoryEnabled");
    const next = enabled !== false;
    const resolved = this._resolveSessionEntry(sessionPath);
    if (resolved?.entry) resolved.entry.memoryEnabled = next;
    const { sessionId, sessionPath: writePath, manifest } = this._resolveSessionWriteRef(sessionPath, "setSessionMemoryEnabled");
    if (manifest || sessionId) {
      this._sessionManifestStore?.setMemoryPolicy(manifest?.sessionId || sessionId, {
        mode: next ? "enabled" : "disabled",
        inheritedFrom: "session_override",
      });
    }
    await this.writeSessionMeta(writePath || sessionPath, { memoryEnabled: next });
    this._emitSessionMetadataUpdated(writePath || sessionPath, { memoryEnabled: next });
    return { ok: true, memoryEnabled: next };
  }

  async switchSession(sessionPath) {
    if (!isActiveSessionPath(sessionPath, this._d.agentsDir)) {
      throw new Error(`switchSession: path must be in agents/{id}/sessions/ - got ${sessionPath}`);
    }
    this._pendingModel = null;

    const targetAgentId = this._d.agentIdFromSessionPath(sessionPath);
    if (targetAgentId && targetAgentId !== this._d.getActiveAgentId()) {
      await this._d.switchAgentOnly(targetAgentId);
    }

    const memoryEnabled = this.getSessionMemoryEnabled(sessionPath);

    const resolvedExisting = this._resolveSessionEntry(sessionPath);
    if (resolvedExisting) {
      const { entry: existing } = resolvedExisting;
      if (this._session && this._session !== existing.session) {
        const oldSp = this._session.sessionManager?.getSessionFile?.();
        if (oldSp) {
          const oldEntry = this._resolveSessionEntry(oldSp)?.entry;
          const oldAgent = oldEntry ? this._d.getAgentById(oldEntry.agentId) : this._d.getAgent();
          await oldAgent?._memoryTicker?.notifySessionEnd(oldSp).catch((err) =>
            log.warn(`switchSession ${path.basename(oldSp)}: notifySessionEnd failed: ${err.message}`),
          );
        }
      }
      this._session = existing.session;
      existing.lastTouchedAt = Date.now();
      return existing.session;
    }

    if (this._session) {
      const oldSp = this._session.sessionManager?.getSessionFile?.();
      if (oldSp) {
        const oldEntry = this._resolveSessionEntry(oldSp)?.entry;
        const oldAgent = oldEntry ? this._d.getAgentById(oldEntry.agentId) : this._d.getAgent();
        await oldAgent?._memoryTicker?.notifySessionEnd(oldSp).catch((err) =>
          log.warn(`switchSession ${path.basename(oldSp)}: notifySessionEnd failed: ${err.message}`),
        );
      }
    }
    this._emitSessionHealthWarning(sessionPath);
    this._repairOrphanToolHistory(sessionPath);
    this._repairInlineMediaHistory(sessionPath);
    const sessionMgr = SessionManager.open(sessionPath, this._d.getAgent().sessionDir);
    const cwd = sessionMgr.getCwd?.() || undefined;
    const result = await this.createSession(sessionMgr, cwd, memoryEnabled, null, {
      restore: true,
      agent: this._d.getAgent(),
      agentId: targetAgentId || this._d.getActiveAgentId(),
    });
    return result.session;
  }

  _emitSessionHealthWarning(sessionPath) {
    try {
      const health = evaluateSessionHealth(sessionPath);
      if (health.healthy) return;

      log.warn(
        `session restore: ${path.basename(sessionPath)} unhealthy (`
        + `${health.recentErrors}/${health.totalChecked} recent assistant messages had stopReason=error). `
        + "User may need to start a new session.",
      );
      this._d.emitEvent?.({
        type: "session_unhealthy_warning",
        recentErrors: health.recentErrors,
        totalChecked: health.totalChecked,
      }, sessionPath);
    } catch (err) {
      log.warn(`session health check failed for ${path.basename(sessionPath)}: ${err.message}`);
    }
  }

  _repairOrphanToolHistory(sessionPath) {
    try {
      const { repaired, removed } = repairOrphanToolResultEntriesInFile(sessionPath);
      if (repaired) {
        log.warn(
          `session restore: ${path.basename(sessionPath)} cleaned ${removed} orphan toolResult entries`,
        );
      }
    } catch (err) {
      log.warn(`orphan tool history repair failed for ${path.basename(sessionPath)}: ${err.message}`);
    }
  }

  _repairInlineMediaHistory(sessionPath) {
    try {
      const result = repairSessionInlineMediaEntriesInFile(sessionPath);
      if (result.repaired) {
        log.warn(
          `session restore: ${path.basename(sessionPath)} cleaned ${result.stripped} inline media blocks `
          + `(image=${result.strippedImages}, video=${result.strippedVideos}, audio=${result.strippedAudios})`,
        );
      }
    } catch (err) {
      log.warn(`inline media history repair failed for ${path.basename(sessionPath)}: ${err.message}`);
    }
  }

  async _maybeAutoCompactBeforePrompt(session, sessionPath) {
    if (!session || session.isStreaming || session.isCompacting) return;
    if (typeof session.getContextUsage !== "function" || typeof session.compact !== "function") return;

    let before;
    try {
      before = session.getContextUsage();
    } catch (err) {
      log.warn(`auto compaction usage check failed: ${err.message}`);
      return;
    }
    const percent = contextUsageRatio(before);
    if (!Number.isFinite(percent) || percent < AUTO_COMPACTION_THRESHOLD) return;

    this._d.emitEvent?.({ type: "auto_compaction_start" }, sessionPath);
    let endUsage = before;
    let error = null;
    try {
      await session.compact();
      endUsage = session.getContextUsage?.() || before;
    } catch (err) {
      error = err;
      log.warn(`auto compaction skipped: ${err.message}`);
    }

    const endTokens = Number(endUsage?.tokens);
    const endContextWindow = Number(endUsage?.contextWindow);
    const endPercent = contextUsageRatio(endUsage) ?? percent;
    this._d.emitEvent?.({
      type: "auto_compaction_end",
      tokens: Number.isFinite(endTokens) ? endTokens : null,
      contextWindow: Number.isFinite(endContextWindow) ? endContextWindow : null,
      percent: Number.isFinite(endPercent) ? endPercent : null,
      ...(error ? { error: error.message } : {}),
    }, sessionPath);
  }

  async prompt(text, opts) {
    if (!this._session) throw new Error(t("error.noActiveSessionPrompt"));
    const turnContext = normalizeSessionTurnContext(opts?.context);
    this._sessionStarted = true;
    const sp = this._session.sessionManager?.getSessionFile?.();
    const promptEntry = sp ? this._resolveSessionEntry(sp)?.entry : null;
    if (promptEntry?._promptInFlight) throw new Error("session_busy");
    const releaseRun = this._beginExecutionRun(this._session);
    opts?.onExecutionStarted?.();
    if (sp) {
      const entry = this._sessions.get(sp);
      if (entry) entry.lastTouchedAt = Date.now();
    }
 //
    if (promptEntry) promptEntry._promptInFlight = true;
    let traceContext = null;
    try {
      traceContext = this._startLifecycleTrace({
        sessionPath: sp,
        agentId: promptEntry?.agentId || this._d.getActiveAgentId?.(),
        text,
        opts,
        model: this._session.model,
      });
      const engine = this._d.getEngine?.();
      const abortController = sp ? new AbortController() : null;
      if (sp && abortController) this._prePromptAbortControllers.set(sp, abortController);
      try {
        ({ text, opts } = await prepareVisionInputForTextOnlyModel({
          targetModel: this._session.model,
          text,
          opts,
          sessionPath: sp,
          getVisionBridge: () => engine?.getVisionBridge?.(),
          visionPolicyTarget: engine,
          warn: (msg) => log.warn(msg),
          signal: abortController?.signal,
        }));
        ({ text, opts } = await prepareModelImageInputsForPrompt({
          text,
          opts,
          signal: abortController?.signal,
        }));
      } finally {
        if (sp && this._prePromptAbortControllers.get(sp) === abortController) {
          this._prePromptAbortControllers.delete(sp);
        }
      }
      assertVideoInputSupported(this._session.model, opts?.videos);
      assertAudioInputSupported(this._session.model, opts?.audios);
      const promptOpts = buildPromptMediaOptions(opts);
      const nativeMediaTurn = engine?.beginCurrentTurnNativeMedia?.(sp, opts);
      if (sp && turnContext) this._turnContextBySession.set(sp, turnContext);
      await this._maybeAutoCompactBeforePrompt(this._session, sp);
      try {
        this._recordLifecyclePhase(traceContext, "model.stream.start", {
          summary: "model stream started",
        });
        await promptWithProcessingFallback(this._session, text, promptOpts);
      } finally {
        if (sp && turnContext) this._turnContextBySession.delete(sp);
        engine?.endCurrentTurnNativeMedia?.(nativeMediaTurn);
        pruneSessionInlineMediaHistory(this._session);
      }
      this._recordLifecyclePhase(traceContext, "state.updated", {
        summary: "session state updated",
      });
      this._recordLifecyclePhase(traceContext, "render.emitted", {
        summary: "terminal render emitted",
      });
      this._endLifecycleTrace(traceContext, { status: "completed" });
    } catch (err) {
      releaseRun?.(true);
      this._endLifecycleTrace(traceContext, {
        status: err?.message?.includes("aborted") ? "aborted" : "failed",
        error: err,
      });
      throw err;
    } finally {
      releaseRun?.();
      if (promptEntry) promptEntry._promptInFlight = false;
      if (sp) this._d.emitEvent?.({ type: "session_status", isStreaming: false }, sp);
    }
    if (sp) {
      const entry = this._sessions.get(sp);
      const agent = entry ? this._d.getAgentById(entry.agentId) : this._d.getAgent();
      agent?._memoryTicker?.notifyTurn(sp);
    }
  }

  async abort() {
    const sessionPath = this.currentSessionPath;
    if (sessionPath) return this.abortSession(sessionPath);
    if (!this._session?.isStreaming) return false;

    try {
      const abortPromise = this._session.abort?.();
      Promise.resolve(abortPromise).catch((err) =>
        log.warn(`abort focus session: abort failed: ${err.message}`),
      );
    } catch (err) {
      log.warn(`abort focus session: abort failed: ${err.message}`);
    }
    this._session = null;
    this._sessionStarted = false;
    return true;
  }

  steer(text) {
    if (!this._session?.isStreaming) return false;
    const sp = this._session.sessionManager?.getSessionFile?.();
    if (sp) {
      const entry = this._resolveSessionEntry(sp)?.entry;
      if (entry) entry.lastTouchedAt = Date.now();
    }
    this._session.steer(getSteerPrefix() + text);
    return true;
  }

  // Path-aware API (Phase 2)

  async promptSession(sessionPath, text, opts) {
    assertAgentReviewActive(this._d.getEngine?.(), sessionPath, opts?.reviewRequestId);

    const turnContext = normalizeSessionTurnContext(opts?.context);
    let resolved = this._resolveSessionEntry(sessionPath);
    let entry = resolved?.entry;
    if (!entry) {
      await this.ensureSessionLoaded(sessionPath);
      resolved = this._resolveSessionEntry(sessionPath);
      entry = resolved?.entry;
    }
    if (!entry) throw new Error(t("error.sessionNotInCache", { path: sessionPath }));
    assertAgentReviewActive(this._d.getEngine?.(), sessionPath, opts?.reviewRequestId);
    if (entry._promptInFlight || isAgentReviewPending(this._d.getEngine?.(), sessionPath, opts?.reviewRequestId)) throw new Error("session_busy");
    const releaseRun = this._beginExecutionRun(entry.session);
    opts?.onExecutionStarted?.();
    if (sessionPath === this.currentSessionPath && this._session !== entry.session) {
      this._session = entry.session;
    }
    entry.lastTouchedAt = Date.now();
    let visibilityPersistPromise: Promise<void> | null = null;
    if (entry.sessionVisibility !== "plugin_private" && entry.sessionVisibility !== "private") {
      if (entry.visibleInSessionList !== true) {
        visibilityPersistPromise = this.writeSessionMeta(sessionPath, { visibleInSessionList: true });
      }
      entry.visibleInSessionList = true;
    }
    if (sessionPath === this.currentSessionPath) this._sessionStarted = true;
 //
    entry._promptInFlight = true;
    const traceSessionPath = resolved.key || sessionPath;
    let traceContext = null;
    try {
      traceContext = this._startLifecycleTrace({
        sessionPath: traceSessionPath,
        agentId: entry.agentId || this._d.getActiveAgentId?.(),
        text,
        opts,
        model: entry.session.model,
      });
      const engine = this._d.getEngine?.();
      const abortController = new AbortController();
      this._prePromptAbortControllers.set(traceSessionPath, abortController);
      try {
        ({ text, opts } = await prepareVisionInputForTextOnlyModel({
          targetModel: entry.session.model,
          text,
          opts,
          sessionPath,
          getVisionBridge: () => engine?.getVisionBridge?.(),
          visionPolicyTarget: engine,
          warn: (msg) => log.warn(msg),
          signal: abortController.signal,
        }));
        ({ text, opts } = await prepareModelImageInputsForPrompt({
          text,
          opts,
          signal: abortController.signal,
        }));
      } finally {
        if (this._prePromptAbortControllers.get(traceSessionPath) === abortController) {
          this._prePromptAbortControllers.delete(traceSessionPath);
        }
      }
      assertVideoInputSupported(entry.session.model, opts?.videos);
      assertAudioInputSupported(entry.session.model, opts?.audios);
      const promptOpts = buildPromptMediaOptions(opts);
      const nativeMediaTurn = engine?.beginCurrentTurnNativeMedia?.(sessionPath, opts);
      if (turnContext) this._turnContextBySession.set(traceSessionPath, turnContext);
      await this._maybeAutoCompactBeforePrompt(entry.session, traceSessionPath);
      try {
        this._recordLifecyclePhase(traceContext, "model.stream.start", {
          summary: "model stream started",
        });
        await promptWithProcessingFallback(entry.session, text, promptOpts);
      } finally {
        if (turnContext) this._turnContextBySession.delete(traceSessionPath);
        engine?.endCurrentTurnNativeMedia?.(nativeMediaTurn);
        pruneSessionInlineMediaHistory(entry.session);
      }
      this._recordLifecyclePhase(traceContext, "state.updated", {
        summary: "session state updated",
      });
      this._recordLifecyclePhase(traceContext, "render.emitted", {
        summary: "terminal render emitted",
      });
      this._endLifecycleTrace(traceContext, { status: "completed" });
    } catch (err) {
      releaseRun?.(true);
      this._endLifecycleTrace(traceContext, {
        status: err?.message?.includes("aborted") ? "aborted" : "failed",
        error: err,
      });
      throw err;
    } finally {
      releaseRun?.();
      if (visibilityPersistPromise) await visibilityPersistPromise;
      entry._promptInFlight = false;
      this._d.emitEvent?.({ type: "session_status", isStreaming: false }, traceSessionPath);
    }
    const agent = this._d.getAgentById(entry.agentId) || this._d.getAgent();
    agent?._memoryTicker?.notifyTurn(sessionPath);
  }

  steerSession(sessionPath, text) {
    const entry = this._resolveSessionEntry(sessionPath)?.entry;
    if (!entry?.session.isStreaming) return false;
    entry.lastTouchedAt = Date.now();
    entry.session.steer(getSteerPrefix() + text);
    return true;
  }

  _emitTurnInputPresentation(sessionPath, message, deliveryMode) {
    const event = buildTurnInputPresentationEvent(message, { deliveryMode });
    if (!event) return;
    this._d.emitEvent?.(event, sessionPath);
  }

  async deliverCustomMessage(sessionPath, message, options: DynamicRecord = {}) {
    if (!sessionPath) throw new Error("deliverCustomMessage: sessionPath is required");
    this._assertActiveDesktopSessionPath(sessionPath, "deliverCustomMessage");
    let resolved = this._resolveSessionEntry(sessionPath);
    if (!resolved?.entry) {
      await this.ensureSessionLoaded(sessionPath);
      resolved = this._resolveSessionEntry(sessionPath);
    }
    const entry = resolved?.entry;
    if (!entry?.session) {
      throw new Error(`deliverCustomMessage: session not loaded for ${sessionPath}`);
    }
    if (typeof entry.session.sendCustomMessage !== "function") {
      throw new Error("deliverCustomMessage: session does not support custom messages");
    }

    entry.lastTouchedAt = Date.now();
    if (entry.session.isStreaming || entry._promptInFlight) {
      await entry.session.sendCustomMessage(message, { deliverAs: "followUp" });
      this._emitTurnInputPresentation(sessionPath, message, "followUp");
      return { ok: true, mode: "followUp" };
    }

    const triggerTurn = options?.triggerTurn !== false;
    if (triggerTurn) {
      this._emitTurnInputPresentation(sessionPath, message, "triggerTurn");
    }
    await entry.session.sendCustomMessage(message, { triggerTurn });
    return { ok: true, mode: triggerTurn ? "triggerTurn" : "notifyOnly" };
  }

  recordCustomEntry(sessionPath, customType, data) {
    if (!sessionPath) throw new Error("recordCustomEntry: sessionPath is required");
    if (!customType) throw new Error("recordCustomEntry: customType is required");
    this._assertActiveDesktopSessionPath(sessionPath, "recordCustomEntry");

    const liveManager = this._resolveSessionEntry(sessionPath)?.entry?.session?.sessionManager;
    if (typeof liveManager?.appendCustomEntry === "function") {
      liveManager.appendCustomEntry(customType, data);
      return { ok: true, mode: "live" };
    }

    const manager = SessionManager.open(sessionPath, path.dirname(sessionPath));
    manager.appendCustomEntry(customType, data);
    return { ok: true, mode: "file" };
  }

  _cleanupAbortedSessionSidecars(sessionPath, reason) {
    if (!sessionPath) return;
    const shortPath = path.basename(sessionPath);
    const taskRegistry = this._d.getTaskRegistry?.() || this._d.taskRegistry || this._d.getEngine?.()?.taskRegistry;
    const subagentRuns = this._d.getSubagentRunStore?.() || this._d.subagentRuns || this._d.getEngine?.()?.subagentRuns;
    const subagentThreads = this._d.getSubagentThreadStore?.() || this._d.subagentThreads || this._d.getEngine?.()?.subagentThreads;
    const deferredResults = this._d.getDeferredResultStore?.() || this._d.deferredResults || this._d.getEngine?.()?.deferredResults;
    const confirmStore = this._d.getConfirmStore?.() || this._d.confirmStore || this._d.getEngine?.()?.confirmStore;

    try {
      taskRegistry?.abortByParentSession?.(sessionPath, reason);
    } catch (err) {
      log.warn(`abort cleanup ${shortPath}: task cleanup failed: ${err?.message || err}`);
    }
    try {
      subagentRuns?.abortByParentSession?.(sessionPath, reason);
    } catch (err) {
      log.warn(`abort cleanup ${shortPath}: subagent run cleanup failed: ${err?.message || err}`);
    }
    try {
      subagentThreads?.removeBySession?.(sessionPath);
    } catch (err) {
      log.warn(`abort cleanup ${shortPath}: subagent thread cleanup failed: ${err?.message || err}`);
    }
    try {
      deferredResults?.suppressBySession?.(sessionPath, reason);
    } catch (err) {
      log.warn(`abort cleanup ${shortPath}: deferred cleanup failed: ${err?.message || err}`);
    }
    try {
      confirmStore?.abortBySession?.(sessionPath);
    } catch (err) {
      log.warn(`abort cleanup ${shortPath}: confirm cleanup failed: ${err?.message || err}`);
    }
    try {
      this._d.closeTerminalsForSession?.(sessionPath);
    } catch (err) {
      log.warn(`abort cleanup ${shortPath}: terminal cleanup failed: ${err?.message || err}`);
    }
    try {
      Promise.resolve(BrowserManager.instance().closeBrowserForSession(sessionPath)).catch((err) => {
        log.warn(`abort cleanup ${shortPath}: browser cleanup failed: ${err?.message || err}`);
      });
    } catch (err) {
      log.warn(`abort cleanup ${shortPath}: browser cleanup failed: ${err?.message || err}`);
    }
  }

  async abortSession(sessionPath) {
    cancelSessionSubmissions(sessionPath);
    const resolved = this._resolveSessionEntry(sessionPath);
    const entry = resolved?.entry;
    const key = resolved?.key || sessionPath;
    findExecutionRun(key)?.cancel();
    const pending = this._prePromptAbortControllers.get(key);
    if (pending) {
      pending.abort();
      this._prePromptAbortControllers.delete(key);
      this._cleanupAbortedSessionSidecars(key, "abort");
      this._d.emitEvent?.({
        type: "session_status",
        isStreaming: false,
        aborted: true,
        reason: "abort",
      }, key);
      return true;
    }
    if (!entry?.session.isStreaming) return false;
    this._cleanupAbortedSessionSidecars(resolved.key || sessionPath, "abort");
    return this._forceReleaseStreamingSession(entry, resolved.key || sessionPath, "abort");
  }

  // Mid-session model switch

  /**
   * Switch the model for an existing session without creating a new one.
   * If the target model cannot fit the current context window, compact or truncate first.
   * @param {string} sessionPath
   * @param {object} newModel - Pi SDK model object
   */
  async switchSessionModel(sessionPath, newModel) {
    const resolved = this._resolveSessionEntry(sessionPath);
    const entry = resolved?.entry;
    if (!entry) throw new Error(t("error.sessionNotInCache", { path: sessionPath }));

    const { session } = entry;

    // Concurrency guard
    if (entry._switching) {
      throw new Error("Model switch already in progress for this session");
    }
    if (session.isCompacting) {
      throw new Error("Cannot switch model while compaction is in progress");
    }

    entry._switching = true;
    const adaptations = [];
    const oldModel = session.model;

    try {
      // Estimate current context token usage.
      const usage = session.getContextUsage?.();
      const msgs = Array.isArray(session.agent?.state?.messages)
        ? session.agent.state.messages
        : [];
      let currentTokens = Number.isFinite(usage?.tokens) ? usage.tokens : null;
      if (currentTokens == null) {
        // Fallback: sum every message locally.
        currentTokens = msgs.reduce((sum, m) => sum + estimateTokens(m), 0);
      }

      const contextWindow = Number.isFinite(newModel.contextWindow) ? newModel.contextWindow : 128000;
      const effectiveWindow = Math.max(1000, Math.floor(contextWindow * 0.9) - 4000);

      if (currentTokens > effectiveWindow) {
        // Try compaction first.
        try {
          await this._compactWithModel(session, effectiveWindow, oldModel);
          adaptations.push("compacted");
        } catch (compactErr) {
          log.warn(`compactWithModel failed, falling back to hard truncate: ${compactErr.message}`);
          // If compaction fails, fall back to hard truncation.
          try {
            await this._hardTruncate(session, effectiveWindow);
            adaptations.push("truncated");
          } catch (truncErr) {
            throw new Error(`Failed to fit context into new model window: ${truncErr.message}`);
          }
        }

        // Final safety check after compaction/truncation.
        const postMsgs = Array.isArray(session.agent?.state?.messages)
          ? session.agent.state.messages
          : [];
        const postTokens = postMsgs.reduce((sum, m) => sum + estimateTokens(m), 0);
        if (postTokens > effectiveWindow) {
          throw new Error(
            `Context still exceeds new model window after adaptation (${postTokens} > ${effectiveWindow})`
          );
        }
      }

      // Apply the actual model switch.
      await session.setModel(newModel);
      entry.modelId = newModel.id;
      entry.modelProvider = newModel.provider;
      const key = resolved?.key || sessionPath;
      const models = this._d.getModels?.();
      const supportsSessionThinking = typeof this._d.getPrefs === "function";
      let nextThinkingLevel = null;
      if (supportsSessionThinking) {
        const currentThinkingLevel = this.getSessionThinkingLevel(key);
        nextThinkingLevel = normalizeThinkingLevelForModel(currentThinkingLevel, newModel);
        entry.thinkingLevel = nextThinkingLevel;
        session.setThinkingLevel?.(models?.resolveThinkingLevel?.(nextThinkingLevel) || nextThinkingLevel);
        this.writeSessionMeta(key, { thinkingLevel: nextThinkingLevel });
      }
      this._renewCachePrefixContract(key, entry, "model_switch");

      return nextThinkingLevel ? { adaptations, thinkingLevel: nextThinkingLevel } : { adaptations };
    } finally {
      entry._switching = false;
    }
  }

  /**
   * Compact conversation history with an LLM-generated summary before switching models.   * @private
   */
  async _compactWithModel(session, effectiveWindow, model) {
    const sessionPath = session?.sessionManager?.getSessionFile?.() || this.currentSessionPath;
    return await runCachePreservingCompactionForSession(session, {
      model,
      settings: {
        enabled: true,
        reserveTokens: 4000,
        keepRecentTokens: effectiveWindow,
      },
      emitLifecycle: true,
      lifecycleReason: "model_switch",
      usageLedger: this._d.getUsageLedger?.(),
      usageContext: {
        source: {
          subsystem: "compaction",
          operation: "compact",
          surface: "desktop",
          trigger: "overflow",
        },
        attribution: {
          kind: "session",
          agentId: this._d.agentIdFromSessionPath?.(sessionPath) || this._d.getActiveAgentId?.() || null,
          sessionPath,
        },
      },
    } as unknown as Parameters<typeof createCachePreservingCompactionResult>[0]);
  }

  /**
   * Hard-truncate conversation history with a fixed summary placeholder.   * @private
   */
  async _hardTruncate(session, effectiveWindow) {
    const sm = session.sessionManager;
    const pathEntries = sm.getBranch();
    const reason = "model_switch";
    session?._emit?.({ type: "compaction_start", reason });

    try {
      const result = computeHardTruncation(pathEntries, effectiveWindow, {
      summary: "[由于模型切换，早期对话历史已被截断]",
      reason: "model-switch-truncation",
    });
      if (!result) {
        throw new Error("Cannot hard-truncate: not enough messages or cut at beginning");
      }

      const saved = await appendCompactionResultToSession(session, result, { fromExtension: false });
      session?._emit?.({
        type: "compaction_end",
        reason,
        result: saved,
        aborted: false,
        willRetry: false,
      });
      return saved;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      session?._emit?.({
        type: "compaction_end",
        reason,
        result: undefined,
        aborted: false,
        willRetry: false,
        errorMessage: `Compaction failed: ${message}`,
      });
      throw error;
    }
  }

  /** Get plan mode for the current (focused) session */
  getPlanMode() {
    return isReadOnlyPermissionMode(this.getPermissionMode());
  }

  _readStoredPermissionModeDefault() {
    const prefs = this._d.getPrefs?.();
    if (typeof prefs?.getSessionPermissionModeDefault !== "function") {
      return DEFAULT_SESSION_PERMISSION_MODE;
    }
    return normalizeSessionPermissionMode(prefs.getSessionPermissionModeDefault());
  }

  _getDefaultPermissionMode() {
    return normalizeSessionPermissionMode(
      this._runtimePermissionModeDefault ?? this._readStoredPermissionModeDefault(),
    );
  }

  _setDefaultPermissionMode(mode, { persist = true } = {}) {
    let normalized = normalizeSessionPermissionMode(mode);
    this._runtimePermissionModeDefault = normalized;
    if (!persist) return normalized;

    const prefs = this._d.getPrefs?.();
    if (typeof prefs?.setSessionPermissionModeDefault === "function") {
      normalized = normalizeSessionPermissionMode(prefs.setSessionPermissionModeDefault(normalized));
      this._runtimePermissionModeDefault = normalized;
    }
    return normalized;
  }

  getPermissionModeDefault() {
    return this._getDefaultPermissionMode();
  }

  setPermissionModeDefault(mode) {
    return this._setDefaultPermissionMode(mode);
  }

  getPermissionMode(sessionPath = this.currentSessionPath) {
    if (!sessionPath) return this._pendingPermissionMode || this._getDefaultPermissionMode();
    const resolved = this._resolveSessionEntry(sessionPath);
    const manifest = resolved?.entry ? null : this._resolveSessionManifestForPath(sessionPath);
    const metaEntry = resolved?.entry ? null : this._readSessionMetaEntrySync(sessionPath);
    return normalizeSessionPermissionMode(
      resolved?.entry
      || manifest?.permissionModeSnapshot?.mode
      || metaEntry
      || { permissionMode: this._getDefaultPermissionMode() },
    );
  }

  getSessionThinkingLevel(sessionPath = this.currentSessionPath) {
    const fallback = normalizeSessionThinkingLevel(this._d.getPrefs?.()?.getThinkingLevel?.());
    if (!sessionPath) return fallback;
    const resolved = this._resolveSessionEntry(sessionPath);
    const manifest = resolved?.entry ? null : this._resolveSessionManifestForPath(sessionPath);
    const metaEntry = resolved?.entry ? null : this._readSessionMetaEntrySync(sessionPath);
    return normalizeSessionThinkingLevel(resolved?.entry?.thinkingLevel || manifest?.thinkingLevel || metaEntry?.thinkingLevel || fallback);
  }

  async setSessionThinkingLevel(sessionPath, level) {
    if (!sessionPath) {
      return { ok: false, error: "session thinking level requires sessionPath" };
    }
    const resolved = this._resolveSessionEntry(sessionPath);
    const entry = resolved?.entry;
    const writePath = this._resolveSessionWriteRef(sessionPath, "setSessionThinkingLevel").sessionPath || sessionPath;
    if (!entry?.session) {
      const nextLevel = normalizeSessionThinkingLevel(level);
      const manifest = this._resolveSessionManifestForPath(sessionPath);
      if (manifest) this._sessionManifestStore.setThinkingLevel(manifest.sessionId, nextLevel);
      await this.writeSessionMeta(writePath, { thinkingLevel: nextLevel });
      this._emitSessionMetadataUpdated(writePath, { thinkingLevel: nextLevel });
      return { ok: true, thinkingLevel: nextLevel };
    }
    const models = this._d.getModels();
    const nextLevel = normalizeThinkingLevelForModel(level, entry.session.model);
    entry.thinkingLevel = nextLevel;
    entry.session.setThinkingLevel?.(models.resolveThinkingLevel(nextLevel));
    const manifest = this._resolveSessionManifestForPath(sessionPath);
    if (manifest) this._sessionManifestStore.setThinkingLevel(manifest.sessionId, nextLevel);
    await this.writeSessionMeta(writePath, { thinkingLevel: nextLevel });
    this._emitSessionMetadataUpdated(writePath, { thinkingLevel: nextLevel });
    return { ok: true, thinkingLevel: nextLevel };
  }

  _emitSessionMetadataUpdated(sessionPath, metadata) {
    if (!sessionPath || !metadata || typeof metadata !== "object") return;
    this._d.emitEvent({
      type: "session_metadata_updated",
      metadata: { ...metadata },
    }, sessionPath);
  }

  getAccessMode(sessionPath = this.currentSessionPath) {
    return legacyAccessModeFromPermissionMode(this.getPermissionMode(sessionPath));
  }

  setPendingAccessMode(mode) {
    return this.setPendingPermissionMode(mode);
  }

  setPendingPermissionMode(mode) {
    const nextMode = normalizeSessionPermissionMode(mode);
    this._setDefaultPermissionMode(nextMode);
    this._pendingPermissionMode = nextMode;
    this._emitPermissionModeChanged(nextMode, null);
    return { ok: true, mode: nextMode, enabled: isReadOnlyPermissionMode(nextMode) };
  }

  _applyPermissionModeToEntry(sessionPath, entry, nextMode, { persistDefault = false } = {}) {
    if (persistDefault) {
      nextMode = this._setDefaultPermissionMode(nextMode);
    }
    entry.permissionMode = nextMode;
    entry.accessMode = legacyAccessModeFromPermissionMode(nextMode);
    entry.planMode = isReadOnlyPermissionMode(nextMode);
    const manifest = this._resolveSessionManifestForPath(sessionPath);
    if (manifest) {
      this._sessionManifestStore.setPermissionModeSnapshot(manifest.sessionId, {
        mode: entry.permissionMode,
        source: "session_update",
      });
    }
    this.writeSessionMeta(sessionPath, {
      permissionMode: entry.permissionMode,
      accessMode: entry.accessMode,
      planMode: entry.planMode,
    });
    this._emitPermissionModeChanged(nextMode, sessionPath);
    return { ok: true, mode: nextMode, enabled: entry.planMode };
  }

  setCurrentSessionPermissionMode(mode) {
    const nextMode = normalizeSessionPermissionMode(mode);
    const sp = this.currentSessionPath;
    if (!sp) {
      return {
        ok: false,
        error: "current session permission mode requires an active session",
        mode: this._getDefaultPermissionMode(),
      };
    }
    const resolved = this._resolveSessionEntry(sp);
    const entry = resolved?.entry;
    if (!entry) {
      return {
        ok: false,
        error: "current session not found",
        mode: this.getPermissionMode(sp),
      };
    }
    return this._applyPermissionModeToEntry(sp, entry, nextMode);
  }

  setSessionPermissionMode(sessionPath, mode, options: DynamicRecord = {}) {
    const nextMode = normalizeSessionPermissionMode(mode);
    if (!sessionPath) {
      return {
        ok: false,
        error: "session permission mode requires sessionPath",
        mode: this._getDefaultPermissionMode(),
      };
    }
    const resolved = this._resolveSessionEntry(sessionPath);
    const entry = resolved?.entry;
    if (!entry) {
      return {
        ok: false,
        error: "session not found",
        mode: this.getPermissionMode(sessionPath),
      };
    }
    return this._applyPermissionModeToEntry(sessionPath, entry, nextMode, {
      persistDefault: options?.persistDefault === true,
    });
  }

  setPermissionMode(mode) {
    const nextMode = normalizeSessionPermissionMode(mode);
    const sp = this.currentSessionPath;
    if (sp) {
      const defaultMode = this._setDefaultPermissionMode(nextMode);
      const resolved = this._resolveSessionEntry(sp);
      const entry = resolved?.entry;
      if (!entry) return { ok: false, mode: this.getPermissionMode(sp) };
      return this._applyPermissionModeToEntry(sp, entry, defaultMode);
    }

    return this.setPendingPermissionMode(nextMode);
  }

  setAccessMode(mode) {
    return this.setPermissionMode(mode);
  }

  /** Backward-compatible route for the old Plan Mode API. */
  setPlanMode(enabled) {
    return this.setPermissionMode(enabled ? SESSION_PERMISSION_MODES.READ_ONLY : SESSION_PERMISSION_MODES.OPERATE);
  }

  _emitPermissionModeChanged(mode, sessionPath) {
    const normalized = normalizeSessionPermissionMode(mode);
    const readOnly = isReadOnlyPermissionMode(normalized);
    const accessMode = legacyAccessModeFromPermissionMode(normalized);
    this._d.emitEvent({ type: "permission_mode", mode: normalized, readOnly }, sessionPath);
    this._d.emitEvent({ type: "access_mode", mode: accessMode, permissionMode: normalized, readOnly }, sessionPath);
    this._d.emitEvent({ type: "plan_mode", enabled: readOnly, mode: normalized, permissionMode: normalized, accessMode }, sessionPath);
    const label = normalized === SESSION_PERMISSION_MODES.READ_ONLY
      ? "只读"
      : (normalized === SESSION_PERMISSION_MODES.ASK ? "先问" : "操作");
    this._d.emitDevLog(`Permission Mode: ${label}`, "info");
  }

  /** Get the focused session's modelId snapshot. */
  getCurrentSessionModelId() {
    const sp = this.currentSessionPath;
    if (!sp) return null;
    return this._resolveSessionEntry(sp)?.entry?.modelId || null;
  }

  /** Get the focused session's full model reference {id, provider}. */
  getCurrentSessionModelRef() {
    const sp = this.currentSessionPath;
    if (!sp) return null;
    const entry = this._resolveSessionEntry(sp)?.entry;
    const metaEntry = entry ? null : this._readSessionMetaEntrySync(sp);
    const id = entry?.modelId || metaEntry?.modelId || metaEntry?.modelRef?.id || null;
    const provider = entry?.modelProvider || metaEntry?.modelProvider || metaEntry?.modelRef?.provider || null;
    if (!id || !provider) return null;
    return { id, provider };
  }

  getSessionContextUsage(sessionPath = this.currentSessionPath) {
    if (!sessionPath) return null;
    const entry = this._resolveSessionEntry(sessionPath)?.entry;
    const liveUsage = entry?.session?.getContextUsage?.();
    if (liveUsage) return liveUsage;
    return this._readSessionMetaEntrySync(sessionPath)?.contextUsage || null;
  }

  /** Abort every session that is currently streaming. */
  async abortAllStreaming() {
    let count = 0;
    for (const [sp, entry] of this._sessions) {
      if (entry.session.isStreaming) {
        this._cleanupAbortedSessionSidecars(sp, "abort_all");
        if (this._forceReleaseStreamingSession(entry, sp, "abort_all")) count++;
      }
    }
    return count;
  }

  // Lifecycle teardown (resource release)

  /**
   * Force-release a session stuck in streaming state.
   *
   * Stop/close is a control-plane operation; the UI must not wait for a provider
   * stream to finish its own cleanup. We release the app session ownership first,
   * then let SDK abort/dispose/teardown continue in the background.
   *
   * @param {object} entry
   * @param {string} sessionPath
   * @param {string} reason
   * @returns {boolean}
   * @private
   */
  _forceReleaseStreamingSession(entry, sessionPath, reason) {
    cancelSessionSubmissions(sessionPath);
    entry?.session?.codiaRunControl?.cancel();
    if (!entry?.session?.isStreaming) return false;

    const session = entry.session;
    const spShort = sessionPath ? path.basename(sessionPath) : "(anon)";
    entry.lastTouchedAt = Date.now();

    this._sessions.delete(sessionPath);
    if (
      this._session === session
      || this._normalizeSessionPath(this.currentSessionPath) === this._normalizeSessionPath(sessionPath)
    ) {
      this._session = null;
      this._sessionStarted = false;
    }

    const unsub = entry.unsub;
    entry.unsub = null;
    try {
      unsub?.();
    } catch (err) {
      log.warn(`forceRelease[${reason}] ${spShort}: unsub failed: ${err.message}`);
    }

    this._d.emitEvent?.({
      type: "session_status",
      isStreaming: false,
      aborted: true,
      reason,
    }, sessionPath);

    try {
      const abortPromise = session.abort?.();
      Promise.resolve(abortPromise).catch((err) =>
        log.warn(`forceRelease[${reason}] ${spShort}: abort failed: ${err.message}`),
      );
    } catch (err) {
      log.warn(`forceRelease[${reason}] ${spShort}: abort failed: ${err.message}`);
    }

    try {
      session.dispose?.();
    } catch (err) {
      log.warn(`forceRelease[${reason}] ${spShort}: session.dispose failed: ${err.message}`);
    }

    this._teardownSessionEntry(entry, sessionPath, reason).catch((err) =>
      log.warn(`forceRelease[${reason}] ${spShort}: teardown failed: ${err.message}`),
    );
    this._notifySessionRuntimeDiscarded(sessionPath, reason).catch((err) =>
      log.warn(`forceRelease[${reason}] ${spShort}: runtime state cleanup failed: ${err.message}`),
    );
    return true;
  }

  /**
   * Release every resource owned by one sessionEntry.   *
   * Teardown contract:
   *   1. emit session_shutdown so SDK extensions can clean timers/subscriptions
   *   2. unsubscribe Codia session event forwarding
   *   3. session.dispose so SDK listeners and agent subscriptions are released
   *
   * Every step is best-effort: failures are logged and teardown continues.   *
   * This matters because AgentSession.dispose() does not emit session_shutdown by itself,
   * so deferred-result-ext can leak timers without the explicit emit.
   *   *
   * @param {object} entry - sessionEntry (session, unsub, agentId, ...)
   * @param {string} sessionPath - used for logging
    *
   * @private
   */
  async _teardownSessionEntry(entry, sessionPath, reason) {
    if (!entry) return;
    await teardownSessionResources({
      session: entry?.session,
      unsub: entry?.unsub,
      label: `session.${reason}[${sessionPath ? path.basename(sessionPath) : "anon"}]`,
      warn: (msg) => log.warn(msg),
    });
  }

  async _notifySessionRuntimeDiscarded(sessionPath, reason) {
    if (!sessionPath || typeof this._d.onSessionRuntimeDiscarded !== "function") return;
    try {
      await this._d.onSessionRuntimeDiscarded(sessionPath, reason);
    } catch (err) {
      log.warn(`discardRuntime[${reason}] ${path.basename(sessionPath)}: runtime state cleanup failed: ${err.message}`);
    }
  }

  // Session shutdown

  async discardSessionRuntime(sessionPath, reason = "discard", options: { skipMemory?: boolean } = {}) {
    if (!sessionPath) return false;
    const resolved = this._resolveSessionEntry(sessionPath);
    const entry = resolved?.entry;
    const entryKey = resolved?.key || sessionPath;
    if (entry) {
      const agent = this._d.getAgentById(entry.agentId) || this._d.getAgent();
      if (options?.skipMemory !== true) {
        agent?._memoryTicker?.notifySessionEnd(sessionPath).catch((err) =>
          log.warn(`discardSessionRuntime ${path.basename(sessionPath)}: notifySessionEnd failed: ${err.message}`),
        );
      }
      if (entry.session.isStreaming) {
        this._forceReleaseStreamingSession(entry, entryKey, reason);
      } else {
        await this._teardownSessionEntry(entry, entryKey, reason);
        this._sessions.delete(entryKey);
        await this._notifySessionRuntimeDiscarded(entryKey, reason);
      }

      this._d.getConfirmStore?.()?.abortBySession(sessionPath);
      this._d.getDeferredResultStore?.()?.clearBySession(sessionPath);
    }
    if (sessionPath) {
      try {
        this._d.closeTerminalsForSession?.(sessionPath);
      } catch (err) {
        log.warn(`discardSessionRuntime ${path.basename(sessionPath)}: close terminals failed: ${err.message}`);
      }
    }
    if (this._normalizeSessionPath(sessionPath) === this._normalizeSessionPath(this.currentSessionPath)) {
      this._session = null;
    }
    return !!entry;
  }

  async hibernateSessionRuntime(sessionPath, reason = "hibernate") {
    if (!sessionPath) return false;
    const resolved = this._resolveSessionEntry(sessionPath);
    const entry = resolved?.entry;
    const entryKey = resolved?.key || sessionPath;
    if (!entry?.session) return false;

    const wasFocused = this._normalizeSessionPath(entryKey) === this._normalizeSessionPath(this.currentSessionPath)
      || entry.session === this._session;
    const contextUsage = entry.session.getContextUsage?.() || null;
    const writePath = entry.sessionPath
      || entry.session.sessionManager?.getSessionFile?.()
      || this._resolveSessionManifestForId(entry.sessionId)?.currentLocator?.path
      || sessionPath;
    await this.writeSessionMeta(writePath, {
      workspaceFolders: Array.isArray(entry.workspaceFolders) ? entry.workspaceFolders : [],
      authorizedFolders: Array.isArray(entry.authorizedFolders) ? entry.authorizedFolders : [],
      permissionMode: entry.permissionMode,
      accessMode: entry.accessMode,
      planMode: entry.planMode,
      thinkingLevel: entry.thinkingLevel,
      modelRef: {
        id: entry.modelId || entry.session.model?.id || null,
        provider: entry.modelProvider || entry.session.model?.provider || null,
      },
      modelId: entry.modelId || entry.session.model?.id || null,
      modelProvider: entry.modelProvider || entry.session.model?.provider || null,
      contextUsage,
    });

    const discarded = await this.discardSessionRuntime(entryKey, reason, { skipMemory: true });
    if (wasFocused) {
      this._currentSessionPath = entryKey;
      this._sessionStarted = true;
      this._session = null;
    }
    return discarded;
  }

  async checkRuntimeMemoryPressure(sessionPath = this.currentSessionPath, reason = "memory_pressure") {
    const pressure = this._d.memoryPressure;
    if (!pressure || !sessionPath) return { hibernated: false, reason: "disabled" };
    const usage = pressure.getMemoryUsage?.() || {};
    const thresholds = pressure.thresholds || {};
    const highRssBytes = Number(thresholds.highRssBytes || 0);
    if (highRssBytes > 0 && Number(usage.rss || 0) < highRssBytes) {
      return { hibernated: false, reason: "rss_below_threshold" };
    }
    const entry = this._resolveSessionEntry(sessionPath)?.entry;
    if (!entry?.session || entry.session.isStreaming || entry.session.isCompacting) {
      return { hibernated: false, reason: "not_idle" };
    }
    const payloadBytes = Buffer.byteLength(JSON.stringify(entry.session.messages || []), "utf8");
    const highPayloadBytes = Number(thresholds.highPayloadBytes || 0);
    const minRetainedBytes = Number(thresholds.minRetainedBytes || 0);
    const payloadThreshold = Math.max(highPayloadBytes, minRetainedBytes, 0);
    if (payloadThreshold > 0 && payloadBytes < payloadThreshold) {
      return { hibernated: false, reason: "payload_below_threshold", payloadBytes };
    }
    const hibernated = await this.hibernateSessionRuntime(sessionPath, reason);
    return { hibernated, payloadBytes };
  }

  async closeSession(sessionPath) {
    return this.discardSessionRuntime(sessionPath, "close");
  }

  async closeAllSessions() {
    // Release all streaming sessions immediately, then tear down idle sessions.
    for (const [sessionPath, entry] of this._sessions) {
      if (entry.session.isStreaming) {
        this._forceReleaseStreamingSession(entry, sessionPath, "close_all");
      } else {
        await this._teardownSessionEntry(entry, sessionPath, "close_all");
        await this._notifySessionRuntimeDiscarded(sessionPath, "close_all");
      }
      // Sidecar cleanup. Keep semantics aligned with closeSession().
      this._d.getConfirmStore?.()?.abortBySession(sessionPath);
    }
    try {
      this._d.closeAllTerminals?.();
    } catch (err) {
      log.warn(`closeAllSessions: close terminals failed: ${err.message}`);
    }
    this._sessions.clear();
    this._session = null;
  }

  async cleanupSession() {
    await this.closeAllSessions();
    log.log("sessions cleaned up");
  }

  /**
   * After provider config changes, force every active session to refresh from ModelRegistry.
   * Current model references are held by session objects.   *
   * PI SDK stores baseUrl on the model object. After ModelRegistry.refresh(),
   * sessions can still point at stale model objects unless we explicitly refresh them.
   * This method is called by engine.onProviderChanged().   */
  refreshAllSessionsModels() {
    for (const entry of this._sessions.values()) {
      try {
        refreshSessionModelFromRegistry(entry.session);
      } catch (err) {
        log.warn(`refreshAllSessionsModels: ${err.message}`);
      }
    }
  }

  // Session queries

  getSessionByPath(sessionPath) {
    return this._resolveSessionEntry(sessionPath)?.entry?.session ?? null;
  }

  getSessionCapabilityDriftNotice(sessionPath) {
    const entry = this._resolveSessionEntry(sessionPath)?.entry;
    const drift = entry?.capabilityDrift;
    if (!drift?.hasDrift) return null;
    if (entry.capabilityDriftDismissedFingerprint === drift.fingerprint) return null;
    return {
      ...drift,
      addedToolNames: [...drift.addedToolNames],
      removedToolNames: [...drift.removedToolNames],
      invalidToolNames: [...drift.invalidToolNames],
    };
  }

  _computeLiveToolSnapshotForEntry(entry, sessionPath) {
    const agent = this._d.getAgentById?.(entry?.agentId) || this._d.getAgent?.();
    if (!agent) return null;
    const cwd = entry?.cwd || entry?.session?.sessionManager?.getCwd?.() || this._d.getHomeCwd?.(agent.id) || process.cwd();
    const models = this._d.getModels?.() || {};
    const model = entry?.session?.model
      || (entry?.modelId && entry?.modelProvider && Array.isArray(models.availableModels)
        ? findModel(models.availableModels, entry.modelId, entry.modelProvider)
        : null)
      || models.currentModel
      || null;
    const toolSnapshotOptions: Record<string, unknown> = {
      forceMemoryEnabled: entry?.memoryEnabled !== false,
      model,
    };
    if (typeof agent.experienceEnabled === "boolean") {
      toolSnapshotOptions.forceExperienceEnabled = entry?.experienceEnabled === true;
    }
    const agentToolsSnapshot = typeof agent.getToolsSnapshot === "function"
      ? agent.getToolsSnapshot(toolSnapshotOptions)
      : agent.tools;
    const workspaceScope = normalizeWorkspaceScope({
      primaryCwd: cwd,
      workspaceFolders: Array.isArray(entry?.workspaceFolders) ? entry.workspaceFolders : [],
    });
    const folderScope = normalizeSessionFolderScope({
      primaryCwd: cwd,
      workspaceFolders: workspaceScope.workspaceFolders,
      authorizedFolders: Array.isArray(entry?.authorizedFolders) ? entry.authorizedFolders : [],
    });
    const built = this._d.buildTools?.(cwd, agentToolsSnapshot, {
      workspace: cwd,
      workspaceFolders: workspaceScope.workspaceFolders,
      authorizedFolders: folderScope.authorizedFolders,
      getAuthorizedFolders: () => this.getSessionAuthorizedFolders(sessionPath),
      agentDir: agent.agentDir,
    }) || { tools: [], customTools: [] };
    const allToolObjects = [
      ...(built.tools || []),
      ...(built.customTools || []),
    ];
    const allToolNames = toolNamesFromObjects(allToolObjects);
    const channelsEnabled = this._d.getPrefs?.()?.getChannelsEnabled?.();
    const extraDisabledToolNames = [
      ...getStableFeatureDisabledToolNames({ channelsEnabled }),
      ...computeRuntimeDisabledToolNames(
        allToolObjects,
        agent.config,
        { agentId: entry?.agentId, restore: false, channelsEnabled },
      ),
    ];
    const disabled = agent.config?.tools?.disabled ?? DEFAULT_DISABLED_TOOL_NAMES;
    return computeToolSnapshot(allToolNames, disabled, {
      extraDisabled: extraDisabledToolNames,
    });
  }

  markCapabilitySnapshotsStale({ agentId = null, reason = "capability_changed" } = {}) {
    const targetAgentId = typeof agentId === "string" && agentId ? agentId : null;
    let scanned = 0;
    let marked = 0;
    for (const entry of this._sessions.values()) {
      if (!entry?.sessionPath || !entry?.session) continue;
      if (targetAgentId && entry.agentId !== targetAgentId) continue;
      scanned += 1;
      const frozenToolNames = Array.isArray(entry.toolNames)
        ? entry.toolNames
        : (entry.activeToolDefinitions || []).map((tool) => tool?.name).filter(Boolean);
      const liveToolNames = this._computeLiveToolSnapshotForEntry(entry, entry.sessionPath);
      if (!liveToolNames) continue;
      const drift = buildSessionCapabilityDrift({
        frozenToolNames,
        liveToolNames,
        frozenSystemPrompt: "",
        liveSystemPrompt: "",
      });
      entry.capabilityDrift = drift.hasDrift ? { ...drift, reason } : null;
      if (drift.hasDrift) {
        marked += 1;
        this._emitSessionMetadataUpdated(entry.sessionPath, {
          capabilityDrift: this.getSessionCapabilityDriftNotice(entry.sessionPath),
        });
      } else {
        this._emitSessionMetadataUpdated(entry.sessionPath, { capabilityDrift: null });
      }
    }
    return { ok: true, scanned, marked };
  }

  async refreshSessionCapabilityBaseline(sessionPath) {
    this._assertActiveDesktopSessionPath(sessionPath, "refreshSessionCapabilityBaseline");
    const resolved = this._resolveSessionEntry(sessionPath);
    const entry = resolved?.entry;
    if (!entry?.session) {
      throw new Error("refreshSessionCapabilityBaseline: session not found");
    }

    const session = entry.session;
    const state = session?.agent?.state;
    const currentToolNames = Array.isArray(entry.liveToolNames)
      ? uniqueToolNames(entry.liveToolNames)
      : toolNamesFromObjects(state?.tools || []);
    const finalSystemPrompt = this._getFinalSystemPrompt(session) || "";
    const previousPromptSnapshot = this._readSessionMetaEntrySync(sessionPath)?.promptSnapshot;
    const normalizedPromptSnapshot = normalizePromptSnapshot(previousPromptSnapshot);
    const promptSnapshot = {
      ...(normalizedPromptSnapshot || {
        version: SESSION_PROMPT_SNAPSHOT_VERSION,
        systemPrompt: finalSystemPrompt,
        appendSystemPrompt: [],
        skillsResult: { skills: [], diagnostics: [] },
        agentsFilesResult: { agentsFiles: [] },
      }),
      finalSystemPrompt,
    };

    session.setActiveToolsByName?.(currentToolNames);
    entry.toolNames = currentToolNames;
    entry.capabilityDrift = buildSessionCapabilityDrift({
      frozenToolNames: currentToolNames,
      liveToolNames: currentToolNames,
      frozenSystemPrompt: finalSystemPrompt,
      liveSystemPrompt: finalSystemPrompt,
    });
    entry.capabilityDriftDismissedFingerprint = null;

    await this.writeSessionMeta(sessionPath, {
      toolNames: currentToolNames,
      promptSnapshot,
      capabilityDriftDismissedFingerprint: null,
    });
    this._renewCachePrefixContract(sessionPath, entry, "fresh_compact");
    return { toolNames: currentToolNames, promptSnapshot };
  }

  async dismissSessionCapabilityDrift(sessionPath, fingerprint) {
    this._assertActiveDesktopSessionPath(sessionPath, "dismissSessionCapabilityDrift");
    if (!fingerprint) {
      throw new Error("dismissSessionCapabilityDrift: fingerprint required");
    }
    const resolved = this._resolveSessionEntry(sessionPath);
    if (resolved?.entry) {
      resolved.entry.capabilityDriftDismissedFingerprint = fingerprint;
    }
    await this.writeSessionMeta(sessionPath, {
      capabilityDriftDismissedFingerprint: fingerprint,
    });
  }

  _assertActiveDesktopSessionPath(sessionPath, operation) {
    if (!isActiveSessionPath(sessionPath, this._d.agentsDir)) {
      throw new Error(`${operation}: path must be an active desktop session under agents/{id}/sessions/*.jsonl; got ${sessionPath}`);
    }
  }

  isSessionSwitching(sessionPath) {
    return !!this._resolveSessionEntry(sessionPath)?.entry?._switching;
  }

  isSessionStreaming(sessionPath) {
    const entry = this._resolveSessionEntry(sessionPath)?.entry;
    return !!entry?._promptInFlight;
  }

  async abortSessionByPath(sessionPath) {
    return this.abortSession(sessionPath);
  }

  async reloadSessionRuntime(sessionPath, { refreshCapabilitySnapshots = false } = {}) {
    this._assertActiveDesktopSessionPath(sessionPath, "reloadSessionRuntime");
    this._assertCurrentActiveSessionLocator(sessionPath, "reloadSessionRuntime");
    const targetAgentId = this._d.agentIdFromSessionPath(sessionPath);
    if (!targetAgentId) {
      throw new Error(`reloadSessionRuntime: cannot resolve agentId for ${sessionPath}`);
    }
    const agent = this._d.getAgentById?.(targetAgentId);
    if (!agent) {
      throw new Error(`reloadSessionRuntime: agent "${targetAgentId}" not found`);
    }

    const resolved = this._resolveSessionEntry(sessionPath);
    const oldEntry = resolved?.entry || null;
    const entryKey = resolved?.key || sessionPath;
    if (oldEntry) {
      if (oldEntry.session?.isStreaming || oldEntry.session?.isCompacting || oldEntry._switching) {
        throw new Error("reloadSessionRuntime: session is busy");
      }
      await this._teardownSessionEntry(oldEntry, entryKey, "reload");
      this._sessions.delete(entryKey);
      await this._notifySessionRuntimeDiscarded(entryKey, "reload");
    }

    const memoryEnabled = typeof oldEntry?.memoryEnabled === "boolean"
      ? oldEntry.memoryEnabled
      : this.getSessionMemoryEnabled(sessionPath) !== false;

    this._emitSessionHealthWarning(sessionPath);
    this._repairOversizedSessionHistory?.(sessionPath);
    this._repairOrphanToolHistory(sessionPath);
    this._repairInlineMediaHistory(sessionPath);
    const sessionMgr = SessionManager.open(sessionPath, agent.sessionDir);
    const cwd = sessionMgr.getCwd?.() || undefined;
    const result = await this.createSession(sessionMgr, cwd, memoryEnabled, null, {
      restore: true,
      agent,
      agentId: targetAgentId,
      preserveAgentMemoryState: true,
      refreshCapabilitySnapshots,
    });
    return result.session;
  }

  async ensureSessionLoaded(sessionPath) {
    const resolved = this._resolveSessionEntry(sessionPath);
    if (resolved?.entry?.session) return resolved.entry.session;

    if (!isActiveSessionPath(sessionPath, this._d.agentsDir)) {
      throw new Error(`ensureSessionLoaded: path must be in agents/{id}/sessions/ - got ${sessionPath}`);
    }
    this._assertCurrentActiveSessionLocator(sessionPath, "ensureSessionLoaded");

    const targetAgentId = this._d.agentIdFromSessionPath(sessionPath);
    if (!targetAgentId) {
      throw new Error(`ensureSessionLoaded: cannot resolve agentId for ${sessionPath}`);
    }
    const agent = this._d.getAgentById?.(targetAgentId);
    if (!agent) {
      throw new Error(`ensureSessionLoaded: agent "${targetAgentId}" not found`);
    }

    let memoryEnabled = true;
    try {
      const metaPath = path.join(agent.sessionDir, "session-meta.json");
      const meta = await this._readMetaCached(metaPath);
      const sessKey = path.basename(sessionPath);
      if (meta[sessKey]?.memoryEnabled === false) memoryEnabled = false;
    } catch (err) {
      if (err.code !== "ENOENT") {
        log.warn(`ensureSessionLoaded: session-meta.json read failed: ${err.message}`);
      }
    }

    const prevFocus = this._session;
    const prevSessionStarted = this._sessionStarted;
    try {
      this._emitSessionHealthWarning(sessionPath);
      this._repairOrphanToolHistory(sessionPath);
      this._repairInlineMediaHistory(sessionPath);
      const sessionMgr = SessionManager.open(sessionPath, agent.sessionDir);
      const cwd = sessionMgr.getCwd?.() || undefined;
      await this.createSession(sessionMgr, cwd, memoryEnabled, null, {
        restore: true,
        agent,
        agentId: targetAgentId,
        preserveAgentMemoryState: true,
      });
    } finally {
      this._session = prevFocus;
      this._sessionStarted = prevSessionStarted;
    }

    const loaded = this._resolveSessionEntry(sessionPath)?.entry;
    if (!loaded) throw new Error("ensureSessionLoaded: session not in cache after createSession");
    if (loaded.agentId !== targetAgentId) {
      throw new Error(`ensureSessionLoaded: restored agentId mismatch (${loaded.agentId} !== ${targetAgentId})`);
    }
    return loaded.session;
  }

  async listSessions(options: DynamicRecord = {}) {
    const activeAgents = this._d.listAgents({
      includePluginPrivate: options.includePluginPrivate === true,
      ...(options.ownerPluginId ? { ownerPluginId: options.ownerPluginId } : {}),
    });
    const deletedAgents = this._d.listDeletedAgents?.() || [];
    const agents = [
      ...activeAgents.map((agent) => ({ ...agent, agentDeleted: false })),
      ...deletedAgents.map((agent) => ({ ...agent, agentDeleted: true })),
    ];

    // Process agents in parallel to avoid serial I/O blocking.
    const perAgent = await Promise.all(agents.map(async (agent) => {
      const sessionDir = path.join(this._d.agentsDir, agent.id, "sessions");
      try { await fsp.access(sessionDir); } catch { return []; }
      try {
        const [sessions, titles, meta] = await Promise.all([
          this._sessionListProjectionCache.list(sessionDir),
          this._loadSessionTitlesFor(sessionDir),
          this._readMetaCached(path.join(sessionDir, "session-meta.json")),
        ]);
        for (const s of sessions) {
          const title = this._sessionTitleFromMap(titles, s.path);
          if (title) s.title = title;
          s.agentId = agent.id;
          s.agentName = agent.name;
          if (agent.agentDeleted) {
            s.agentDeleted = true;
            s.readOnlyReason = "agent_deleted";
            s.continuationAvailable = true;
            s.deletedAt = agent.deletedAt || null;
          }
          const sessKey = path.basename(s.path);
          const metaEntry = meta[sessKey];
          const manifest = this._resolveSessionManifestForPath(s.path);
          s.sessionId = manifest?.sessionId || null;
          s.pinnedAt = typeof manifest?.pinnedAt === "string"
            ? manifest.pinnedAt
            : (typeof metaEntry?.pinnedAt === "string" ? metaEntry.pinnedAt : null);
          s.projectId = typeof metaEntry?.projectId === "string" && metaEntry.projectId.trim()
            ? metaEntry.projectId.trim()
            : null;
          // Read either new-style model:{id,provider} or legacy modelId metadata.
          if (metaEntry?.model && typeof metaEntry.model === "object") {
            s.modelId = metaEntry.model.id || null;
            s.modelProvider = metaEntry.model.provider || null;
          } else {
            s.modelId = metaEntry?.modelId || null;
            s.modelProvider = metaEntry?.modelProvider || null;
          }
          const pluginMeta = manifest?.plugin
            || (metaEntry?.plugin && typeof metaEntry.plugin === "object" ? metaEntry.plugin : null);
          s.ownerPluginId = typeof pluginMeta?.ownerPluginId === "string" ? pluginMeta.ownerPluginId : null;
          s.sessionKind = typeof pluginMeta?.kind === "string" ? pluginMeta.kind : null;
          s.sessionVisibility = typeof pluginMeta?.visibility === "string" ? pluginMeta.visibility : "public";
          s.visibility = s.sessionVisibility;
          s.workspaceMountId = typeof metaEntry?.workspaceMountId === "string"
            ? metaEntry.workspaceMountId
            : (manifest?.workspaceScope?.workspaceMount?.mountId || null);
          s.workspaceLabel = typeof metaEntry?.workspaceLabel === "string"
            ? metaEntry.workspaceLabel
            : (manifest?.workspaceScope?.workspaceMount?.label || null);
          const metaVisibleInSessionList = typeof metaEntry?.visibleInSessionList === "boolean"
            ? metaEntry.visibleInSessionList
            : true;
          s.visibleInSessionList = metaVisibleInSessionList
            && s.sessionVisibility !== "plugin_private"
            && s.sessionVisibility !== "private";
        }
        return sessions.filter((session) => sessionMatchesListOptions(session, options));
      } catch (err) {
        // Log explicitly. Silent failures here make the sidebar appear empty with no clue why.
        log.warn(`listSessions: agent="${agent.id}" sessionDir="${sessionDir}" failed: ${err?.message || err}`);
        return [];
      }
    }));
    const allSessions = perAgent.flat();

    const currentPath = this.currentSessionPath;
    const activeAgentId = this._d.getActiveAgentId();
    if (
      currentPath
      && this._sessionStarted
      && isActiveSessionPath(currentPath, this._d.agentsDir)
      && !allSessions.find(s => s.path === currentPath)
    ) {
      const currentEntry = this._resolveSessionEntry(currentPath)?.entry;
      allSessions.unshift({
        path: currentPath,
        sessionId: currentEntry?.sessionId || this._sessionIdForPath(currentPath),
        title: null,
        firstMessage: "",
        modified: new Date(),
        revision: null,
        messageCount: 0,
        cwd: this._session?.sessionManager?.getCwd?.() || "",
        agentId: activeAgentId,
        agentName: this._d.getAgent().agentName,
        modelId: currentEntry?.modelId || null,
        modelProvider: currentEntry?.modelProvider || null,
        projectId: null,
        pinnedAt: null,
        workspaceMountId: currentEntry?.workspaceMountId || null,
        workspaceLabel: currentEntry?.workspaceLabel || null,
        ownerPluginId: currentEntry?.ownerPluginId || null,
        sessionKind: currentEntry?.sessionKind || null,
        sessionVisibility: currentEntry?.sessionVisibility || "public",
        visibility: currentEntry?.sessionVisibility || "public",
      });
    }

    allSessions.sort((a, b) => b.modified - a.modified);
    return allSessions;
  }

  async saveSessionTitle(sessionPath, title) {
    const writePath = this._resolveSessionWriteRef(sessionPath, "saveSessionTitle").sessionPath || sessionPath;
    const agentId = this._d.agentIdFromSessionPath(writePath);
    const sessionDir = agentId
      ? path.join(this._d.agentsDir, agentId, "sessions")
      : this._d.getAgent().sessionDir;
    const titlePath = path.join(sessionDir, "session-titles.json");
    const titles = await this._loadSessionTitlesFor(sessionDir);
    const titleKey = this._sessionTitleKeyForPath(writePath);
    if (titleKey !== writePath) {
      delete titles[writePath];
      delete titles[path.basename(writePath)];
    }
    titles[titleKey] = title;
    await fsp.writeFile(titlePath, JSON.stringify(titles, null, 2), "utf-8");
    // Update title cache.
    this._titlesCache.set(sessionDir, { titles: { ...titles }, ts: Date.now() });
  }

  async setSessionPinned(sessionRef, pinned) {
    const { sessionId, sessionPath, manifest } = this._resolveSessionWriteRef(sessionRef, "setSessionPinned");
    if (!sessionPath) throw new Error("setSessionPinned: sessionPath is required");
    const pinnedAt = pinned ? new Date().toISOString() : null;
    if (manifest || sessionId) {
      this._sessionManifestStore?.setPinnedAt(manifest?.sessionId || sessionId, pinnedAt);
    }
    await this.writeSessionMeta(sessionPath, { pinnedAt });
    await this._verifySessionPinnedState(sessionPath, pinnedAt);
    this._emitSessionMetadataUpdated(sessionPath, { pinnedAt });
    return pinnedAt;
  }

  async setSessionPluginMeta(sessionPath, patch: DynamicRecord = {}) {
    const resolved = this._resolveSessionEntry(sessionPath);
    const entry = resolved?.entry;
    const manifest = this._resolveSessionManifestForPath(sessionPath);
    const writePath = manifest?.currentLocator?.path || sessionPath;
    let current = {
      ownerPluginId: entry?.ownerPluginId || manifest?.plugin?.ownerPluginId || null,
      kind: entry?.sessionKind || manifest?.plugin?.kind || null,
      visibility: entry?.sessionVisibility || manifest?.plugin?.visibility || "public",
    };
    try {
      const metaPath = this._sessionMetaPathFor(sessionPath);
      const meta = await this._readMetaCached(metaPath);
      const metaEntry = meta[path.basename(sessionPath)];
      if (metaEntry?.plugin && typeof metaEntry.plugin === "object") {
        current = {
          ownerPluginId: metaEntry.plugin.ownerPluginId || current.ownerPluginId || null,
          kind: metaEntry.plugin.kind || current.kind || null,
          visibility: metaEntry.plugin.visibility || current.visibility || "public",
        };
      }
    } catch (err) {
      if (err.code !== "ENOENT") {
        log.warn(`setSessionPluginMeta: meta read failed for ${path.basename(sessionPath)}: ${err.message}`);
      }
    }
    const plugin = normalizePluginSessionMeta({
      ownerPluginId: patch.ownerPluginId ?? current.ownerPluginId,
      sessionKind: patch.kind ?? patch.sessionKind ?? current.kind,
      sessionVisibility: patch.visibility ?? patch.sessionVisibility ?? current.visibility,
    }) || { ownerPluginId: null, kind: null, visibility: "public" };
    if (manifest) this._sessionManifestStore.setPlugin(manifest.sessionId, plugin);
    await this.writeSessionMeta(writePath, { plugin });
    if (entry) {
      entry.ownerPluginId = plugin.ownerPluginId || null;
      entry.sessionKind = plugin.kind || null;
      entry.sessionVisibility = plugin.visibility || "public";
    }
    this._emitSessionMetadataUpdated(writePath, { plugin });
    return plugin;
  }

  async _verifySessionPinnedState(sessionPath, expectedPinnedAt) {
    const metaPath = this._sessionMetaPathFor(sessionPath);
    const sessKey = path.basename(sessionPath);
    let meta = {};
    try {
      meta = JSON.parse(await fsp.readFile(metaPath, "utf-8"));
    } catch (err) {
      if (expectedPinnedAt === null && err.code === "ENOENT") return;
      throw new Error(`setSessionPinned: verify failed for ${sessKey}: ${err.message}`);
    }
    const actual = meta[sessKey]?.pinnedAt ?? null;
    if (actual !== expectedPinnedAt) {
      throw new Error(`setSessionPinned: expected pinnedAt=${expectedPinnedAt ?? "null"} for ${sessKey}, got ${actual ?? "null"}`);
    }
  }

  async clearSessionTitle(sessionPath) {
    const writePath = this._resolveSessionWriteRef(sessionPath, "clearSessionTitle").sessionPath || sessionPath;
    const agentId = this._d.agentIdFromSessionPath(writePath);
    const sessionDir = agentId
      ? path.join(this._d.agentsDir, agentId, "sessions")
      : this._d.getAgent().sessionDir;
    const titlePath = path.join(sessionDir, "session-titles.json");
    let titles;
    try {
      titles = JSON.parse(await fsp.readFile(titlePath, "utf-8"));
    } catch {
      return;
    }
    const keys = [
      this._sessionTitleKeyForPath(writePath),
      writePath,
      path.basename(writePath),
    ];
    let changed = false;
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(titles, key)) {
        delete titles[key];
        changed = true;
      }
    }
    if (!changed) return;
    await fsp.writeFile(titlePath, JSON.stringify(titles, null, 2), "utf-8");
    this._titlesCache.set(sessionDir, { titles: { ...titles }, ts: Date.now() });
  }

  async listArchivedSessions() {
    const agents = this._d.listAgents();
    const perAgent = await Promise.all(agents.map(async (agent) => {
      const sessionDir = path.join(this._d.agentsDir, agent.id, "sessions");
      const archDir = path.join(sessionDir, "archived");
      let files;
      try { files = await fsp.readdir(archDir); } catch { return []; }
      const titles = await this._loadSessionTitlesFor(sessionDir).catch(() => ({}));
      const rows = await Promise.all(files
        .filter((f) => f.endsWith(".jsonl"))
        .map(async (f) => {
          const full = path.join(archDir, f);
          try {
            const stat = await fsp.stat(full);
            const activeKey = path.join(sessionDir, f);
            return {
              path: full,
              title: this._sessionTitleFromMap(titles, full, [activeKey]) || null,
              archivedAt: stat.mtime.toISOString(),
              sizeBytes: stat.size,
              agentId: agent.id,
              agentName: agent.name,
            };
          } catch {
            return null;
          }
        }));
      return rows.filter(Boolean);
    }));
    const all = perAgent.flat();
    all.sort((a, b) => new Date(b.archivedAt).getTime() - new Date(a.archivedAt).getTime());
    return all;
  }

  async getTitlesForPaths(paths) {
    const titles = {};
    for (const p of paths) titles[p] = null;

    const byDir = new Map();
    for (const p of paths) {
      const dir = path.dirname(p);
      if (!byDir.has(dir)) byDir.set(dir, []);
      byDir.get(dir).push(p);
    }

    for (const [dir, sessionPaths] of byDir) {
      try {
        const dirTitles = await this._loadSessionTitlesFor(dir);
        for (const sp of sessionPaths) {
          const title = this._sessionTitleFromMap(dirTitles, sp);
          if (title) titles[sp] = title;
        }
      } catch { /* ignore */ }
    }

    return titles;
  }

  async _loadSessionTitlesFor(sessionDir) {
    const cached = this._titlesCache.get(sessionDir);
    if (cached && Date.now() - cached.ts < SessionCoordinator._TITLES_TTL) {
      return { ...cached.titles };
    }
    try {
      const raw = await fsp.readFile(path.join(sessionDir, "session-titles.json"), "utf-8");
      const titles = JSON.parse(raw);
      this._titlesCache.set(sessionDir, { titles, ts: Date.now() });
      return { ...titles };
    } catch {
      this._titlesCache.set(sessionDir, { titles: {}, ts: Date.now() });
      return {};
    }
  }

  /** Read session-meta.json asynchronously with a TTL cache. */
  async _readMetaCached(metaPath) {
    const cached = this._metaCache.get(metaPath);
    if (cached && Date.now() - cached.ts < SessionCoordinator._TITLES_TTL) {
      return cached.data;
    }
    try {
      const raw = await fsp.readFile(metaPath, "utf-8");
      const data = JSON.parse(raw);
      this._metaCache.set(metaPath, { data, ts: Date.now() });
      return data;
    } catch {
      return {};
    }
  }

  /** Drop the cached session-meta entry after a write. */
  invalidateMetaCache(metaPath) {
    this._metaCache.delete(metaPath);
  }

  /**
   * Single entry point for all session-meta.json writes. Both the memory-toggle
   * path (persistSessionMeta) and the tool-snapshot path (createSession) go
   * through this method. Writes are serialized via a promise chain to prevent
   * RMW races where two concurrent writers would each read stale meta and
   * clobber the other's fields on write-back.
   *
   * @param {string} sessionPath - absolute path to the session .jsonl file
   * @param {object} partial - fields to merge into meta[basename(sessionPath)]
   * @returns {Promise<void>} Resolves after this write (and any writes queued
   *   before it) has been attempted. I/O failures are logged and swallowed
   *   internally - the returned promise never rejects.
   */
  writeSessionMeta(sessionPath, partial) {
    const next = () => this._doWriteSessionMeta(sessionPath, partial);
    // Chain on both success and failure branches so a failed write does not
    // Poisoning the queue would be bad - the next write must still run.
    this._metaWriteQueue = this._metaWriteQueue.then(next, next);
    return this._metaWriteQueue;
  }

  async _doWriteSessionMeta(sessionPath, partial) {
    const metaPath = this._sessionMetaPathFor(sessionPath);
    const sessKey = path.basename(sessionPath);

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        let meta = {};
        try {
          meta = JSON.parse(await fsp.readFile(metaPath, "utf-8"));
        } catch {
          // file missing or parse error -> start fresh
        }
        meta[sessKey] = {
          ...meta[sessKey],
          ...partial,
        };
        // model is owned by PI SDK via session JSONL - keep session-meta clean
        delete meta[sessKey].model;
        delete meta[sessKey].modelId;
        await fsp.writeFile(metaPath, JSON.stringify(meta, null, 2));
        this.invalidateMetaCache(metaPath);
        return;
      } catch (err) {
        if (attempt === 0) {
          try { await fsp.mkdir(path.dirname(metaPath), { recursive: true }); } catch {
            // Ignore mkdir races and surface the original write error below.
          }
        } else {
          log.warn(`writeSessionMeta failed for ${sessKey}: ${err.message}`);
        }
      }
    }
  }

  _sessionMetaPathFor(sessionPath) {
    const agentId = typeof this._d.agentIdFromSessionPath === "function"
      ? this._d.agentIdFromSessionPath(sessionPath)
      : null;
    const activeSessionDir = this._d.getAgent?.()?.sessionDir;
    const sessionDir = agentId
      ? path.join(this._d.agentsDir, agentId, "sessions")
      : (typeof activeSessionDir === "string" && activeSessionDir ? activeSessionDir : path.dirname(sessionPath));
    return path.join(sessionDir, "session-meta.json");
  }

  async _readSessionPromptSnapshot(agent, sessionPath) {
    try {
      const metaPath = path.join(agent.sessionDir, "session-meta.json");
      const meta = await this._readMetaCached(metaPath);
      return normalizePromptSnapshot(meta[path.basename(sessionPath)]?.promptSnapshot);
    } catch {
      return null;
    }
  }

  _resolvePromptModelFromSessionManager(sessionMgr, models) {
    try {
      const ref = sessionMgr?.buildSessionContext?.()?.model;
      if (!ref?.provider || !ref?.modelId) return null;
      return findModel(models.availableModels, ref.modelId, ref.provider);
    } catch (err) {
      log.warn(`restore prompt patch model resolve failed: ${err.message}`);
      return null;
    }
  }

  _getFinalSystemPrompt(session) {
    if (typeof session?._baseSystemPrompt === "string") {
      return session._baseSystemPrompt;
    }
    if (typeof session?.agent?.state?.systemPrompt === "string") {
      return session.agent.state.systemPrompt;
    }
    return null;
  }

  _applyFinalPromptSnapshot(session, finalSystemPrompt) {
    if (typeof finalSystemPrompt !== "string") return;
    try {
      session._baseSystemPrompt = finalSystemPrompt;
    } catch {
      // Best effort: older SDK session objects may expose read-only fields.
    }
    if (session?.agent?.state && typeof session.agent.state === "object") {
      try {
        session.agent.state.systemPrompt = finalSystemPrompt;
      } catch {
        // Best effort for SDK-internal prompt cache compatibility.
      }
    }
  }

  _buildCachePrefixContract(entry, { model = null, context = null } = {}) {
    const session = entry?.session;
    const state = session?.agent?.state;
    const hasContextPrompt = context && Object.prototype.hasOwnProperty.call(context, "systemPrompt");
    return buildLlmContextCachePrefixContract({
      model: model || session?.model || state?.model || null,
      systemPrompt: hasContextPrompt ? context.systemPrompt : (this._getFinalSystemPrompt(session) ?? ""),
      tools: Array.isArray(context?.tools) ? context.tools : (Array.isArray(state?.tools) ? state.tools : []),
    });
  }

  _renewCachePrefixContract(sessionPath, entry, reason, options = {}) {
    if (!entry?.session) return null;
    const contract = this._buildCachePrefixContract(entry, options);
    entry.cachePrefixContract = contract;
    entry.cachePrefixContractRenewReason = reason;
    entry.cachePrefixContractRenewedAt = Date.now();
    entry.cachePrefixContractRequestCount = 0;

    if (cacheContractDebugEnabled()) {
      log.log(`cache_contract_renew ${JSON.stringify({
        session: sessionPath ? path.basename(sessionPath) : null,
        reason,
        contract: summarizeCachePrefixContract(contract),
      })}`);
    }
    return contract;
  }

  _assertCachePrefixContract(sessionPath, entry, { model = null, context = null } = {}) {
    if (!entry?.session) return null;
    const expected = entry.cachePrefixContract
      || this._renewCachePrefixContract(sessionPath, entry, "late_init", { model, context });
    const actual = this._buildCachePrefixContract(entry, { model, context });
    const diffs = diffCachePrefixContracts(expected, actual);
    if (diffs.length > 0) {
      const record = {
        session: sessionPath ? path.basename(sessionPath) : null,
        renewReason: entry.cachePrefixContractRenewReason || null,
        requestCount: entry.cachePrefixContractRequestCount || 0,
        diffs,
        expected: summarizeCachePrefixContract(expected),
        actual: summarizeCachePrefixContract(actual),
      };
      log.error(`cache_contract_violation ${JSON.stringify(record)}`);
      try {
        this._d.emitEvent?.({
          type: "cache_contract_violation",
          sessionPath,
          diffs,
          expected: summarizeCachePrefixContract(expected),
          actual: summarizeCachePrefixContract(actual),
        }, sessionPath);
      } catch {
        // The provider request must still fail even if UI event delivery fails.
      }
      throw new Error(`Cache prefix contract violated: ${diffs.map((d) => d.field).join(", ")}`);
    }

    entry.cachePrefixContractRequestCount = (entry.cachePrefixContractRequestCount || 0) + 1;
    if (cacheContractDebugEnabled()) {
      log.log(`cache_contract_check ${JSON.stringify({
        session: sessionPath ? path.basename(sessionPath) : null,
        requestCount: entry.cachePrefixContractRequestCount,
        contract: summarizeCachePrefixContract(actual),
      })}`);
    }
    return actual;
  }

  _installCachePrefixGuard(sessionPath, entry) {
    const agent = entry?.session?.agent;
    const streamSlot = typeof agent?.streamFunction === "function" ? "streamFunction" : "streamFn";
    if (!agent || typeof agent[streamSlot] !== "function" || entry.cachePrefixGuardInstalled) return;
    const originalStreamFn = agent[streamSlot];
    entry.cachePrefixGuardInstalled = true;
    entry.cachePrefixOriginalStreamFn = originalStreamFn;
    agent[streamSlot] = async (model, context, options) => {
      const owner = this._d?.getAgentById?.(entry.agentId) || this._d?.getAgent?.();
      const guarded = owner?.agentDir ? guardMemoryContext(context, owner.agentDir) : context;
      if (guarded.systemPrompt !== context.systemPrompt) {
        this._applyFinalPromptSnapshot(entry.session, guarded.systemPrompt);
        this._renewCachePrefixContract(sessionPath, entry, 'memory-revocation', { model, context: guarded });
      }
      context = guarded;
      this._assertCachePrefixContract(sessionPath, entry, { model, context });
      return originalStreamFn.call(agent, model, context, options);
    };
  }

  // Session context

  createSessionContext() {
    const models = this._d.getModels();
    const skills = this._d.getSkills();
    return {
      modelRuntime:   models.modelRuntime,
      resourceLoader: this._d.getResourceLoader(),
      allSkills:      skills.allSkills,
      getSkillsForAgent: (ag) => skills.getSkillsForAgent(ag),
      buildTools:     (cwd, customTools, opts) => this._d.buildTools(cwd, customTools, opts),
      resolveModel:   (agentConfig) => {
        const chatRef = agentConfig?.models?.chat;
        const ref = (typeof chatRef === "object" && chatRef?.id && chatRef?.provider) ? chatRef : null;
        if (!ref) {
          if (models.defaultModel) {
            log.log(`[resolveModel] agentConfig has no complete models.chat; falling back to ${models.defaultModel.provider}/${models.defaultModel.id}`);
            return models.defaultModel;
          }
          log.error("[resolveModel] agentConfig has no models.chat and no default model");
          throw new Error(t("error.resolveModelNoChatModel"));
        }
        const found = findModel(models.availableModels, ref.id, ref.provider);
        if (!found) {
          if (models.defaultModel) {
            log.log(`[resolveModel] model "${ref.provider}/${ref.id}" is unavailable; falling back to ${models.defaultModel.provider}/${models.defaultModel.id}`);
            return models.defaultModel;
          }
          const available = models.availableModels.map(m => `${m.provider}/${m.id}`).join(", ");
          log.error(`[resolveModel] model "${ref.provider}/${ref.id}" not found. availableModels=[${available}]`);
          throw new Error(t("error.resolveModelNotAvailable", { id: `${ref.provider}/${ref.id}` }));
        }
        return found;
      },
    };
  }

  promoteActivitySession(activitySessionFile, agentId) {
    const agent = agentId ? this._d.getAgentById(agentId) : this._d.getAgent();
    if (!agent) return null;
    const oldPath = path.join(agent.agentDir, "activity", activitySessionFile);
    if (!fs.existsSync(oldPath)) return null;

    const newPath = path.join(agent.sessionDir, activitySessionFile);
    try {
      fs.mkdirSync(agent.sessionDir, { recursive: true });
      moveSessionWithExecutionRunSync(oldPath, newPath);
      agent._memoryTicker?.notifyPromoted(newPath);
      log.log(`promoted activity session: ${activitySessionFile} (agent=${agent.id})`);
      return newPath;
    } catch (err) {
      log.error(`promoteActivitySession failed: ${err.message}`);
      return null;
    }
  }

  // Isolated execution

  /**
   * Run a prompt in an isolated temporary session.   *
   * opts:
   *   agentId, cwd, model, persist (directory path | falsy),
   *   toolFilter, builtinFilter, withMemory, subagentContext, signal,
   *   emitEvents (forward session events to EventBus),
   *   onSessionReady (sessionPath => void) callback before prompt execution.   */
  getWorkflowRuntimeSnapshot() {
    const models = this._d.getModels();
    const agents = [...this._d.getAgents().values()];
    return createResolvedRuntimeSnapshot({
      model: { available: models.availableModels.map(model => models.resolveExecutionModel(model)), default: models.defaultModel },
      thinkingLevel: this._d.getPrefs().getThinkingLevel(),
      systemPrompt: { agents: agents.map(agent => ({ id: agent.id, prompt: agent.buildSystemPrompt({ forSubagent: true }) })), append: this._d.getResourceLoader().getAppendSystemPrompt?.() },
      tools: agents.map(agent => ({ id: agent.id, tools: agent.tools })),
      agentConfig: { global: this._d.getConfig(), agents: agents.map(agent => ({ id: agent.id, config: agent.config })) },
      scope: null,
    });
  }

  async executeIsolated(prompt, opts: ExecuteIsolatedOptions = {}) {
    const targetAgent = opts.agentId ? this._d.getAgentById(opts.agentId) : this._d.getAgent();
    if (!targetAgent) throw new Error(t("error.agentNotInitialized", { id: opts.agentId }));

 // abort signal：提前中止检-
    if (opts.signal?.aborted) {
      return { sessionPath: null, replyText: "", error: "aborted" };
    }

    const inheritedExecutionControl = executionContext.getStore()
      || ((opts.subagentContext || opts.workflowContext || opts.subagentTaskId) ? findExecutionRun(opts.parentSessionPath) : undefined);
    if ((opts.workflowRuntimeGuard || opts.runBudget) && opts.forceLocalRuntime !== true && isWukongRuntimeAgent(targetAgent)) {
      throw new Error("Workflow runtime version pinning is unavailable for the external Wukong runtime.");
    }
    if (opts.forceLocalRuntime !== true && isWukongRuntimeAgent(targetAgent)) {
      try {
        if (inheritedExecutionControl) {
          throw new Error("External Wukong execution cannot enforce this task's shared model/tool allowance. Enable the configured local fallback or choose a local assistant.");
        }
        const result = await executeWukongAgentRuntimeTask({
          agent: targetAgent,
          engine: this._d,
          text: prompt,
          source: {
            subsystem: opts.subagentContext ? "subagent" : "workflow",
            surface: "isolated",
          },
          conversation: {
            parentSessionPath: opts.parentSessionPath || null,
            subagentTaskId: opts.subagentTaskId || null,
            subagentThreadId: opts.subagentThreadId || null,
          },
          metadata: {
            cwd: opts.cwd || null,
            workflowContext: opts.workflowContext === true,
          },
          attachments: [
            ...(opts.images || []),
            ...(opts.videos || []),
            ...(opts.audios || []),
          ],
        });
        if (result) {
          return {
            sessionPath: null,
            replyText: result.text || "",
            error: null,
            stopReason: result.status || "completed",
            sessionFiles: [],
            toolErrors: [],
            runtime: "wukong",
            externalTaskId: result.externalTaskId || null,
            raw: result.raw,
          };
        }
      } catch (err) {
        log.error(`isolated Wukong runtime failed: ${err.message}`);
        if (targetAgent.config?.wukong?.fallbackToLocal === true) {
          log.warn(`isolated Wukong runtime failed; falling back to local execution for ${targetAgent.id}`);
        } else {
          return { sessionPath: null, replyText: "", error: err.message, runtime: "wukong" };
        }
      }
    }

    const bm = BrowserManager.instance();
    const wasBrowserRunning = bm.hasAnyRunning;
    const opId = `iso_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    this._headlessOps.add(opId);
    if (this._headlessOps.size === 1) bm.setHeadless(true);
    let tempSessionMgr;
    let traceContext = null;
    let childSessionPath = null;
    let executionControl: RunController | undefined;
    let isResumedSession = false;
    const cleanupTempSession = () => {
      const sp = tempSessionMgr?.getSessionFile?.();
      if (sp && !isResumedSession) {
        try { fs.unlinkSync(sp); } catch {
          // Ignore temp session cleanup failures.
        }
      }
    };
    try {
      const resumeSessionPath = typeof opts.resumeSessionPath === "string" && opts.resumeSessionPath.trim()
        ? opts.resumeSessionPath
        : null;
      const sessionDir = opts.persist || (resumeSessionPath ? path.dirname(resumeSessionPath) : path.join(targetAgent.agentDir, '.ephemeral'));
      fs.mkdirSync(sessionDir, { recursive: true });

      const execCwd = opts.cwd || this._d.getHomeCwd(targetAgent.id) || process.cwd();
      const inheritedWorkspaceFolders = Array.isArray(opts.workspaceFolders)
        ? opts.workspaceFolders
        : (opts.parentSessionPath ? this.getSessionWorkspaceFolders(opts.parentSessionPath) : []);
      const inheritedAuthorizedFolders = Array.isArray(opts.authorizedFolders)
        ? opts.authorizedFolders
        : (opts.parentSessionPath ? this.getSessionAuthorizedFolders(opts.parentSessionPath) : []);
      const execWorkspaceScope = normalizeWorkspaceScope({
        primaryCwd: execCwd,
        workspaceFolders: inheritedWorkspaceFolders,
      });
      const execFolderScope = normalizeSessionFolderScope({
        primaryCwd: execCwd,
        workspaceFolders: execWorkspaceScope.workspaceFolders,
        authorizedFolders: inheritedAuthorizedFolders,
      });
      const models = this._d.getModels();
      const agentPreferredRef = targetAgent.config?.models?.chat;
      const preferredRef = opts.model ? null
        : ((typeof agentPreferredRef === "object" && agentPreferredRef?.id && agentPreferredRef?.provider)
            ? agentPreferredRef : null);
      let resolvedModel = opts.model;
      if (!resolvedModel) {
        if (preferredRef) {
          resolvedModel = findModel(models.availableModels, preferredRef.id, preferredRef.provider);
        }
        if (!resolvedModel) {
          resolvedModel = models.defaultModel;
        }
        if (!resolvedModel) {
          log.error(`[executeIsolated] agent "${targetAgent.agentName}" has no complete models.chat and no usable default model`);
          throw new Error(t("error.executeIsolatedNoModel", { name: targetAgent.agentName }));
        }
        if (preferredRef && resolvedModel.id !== preferredRef.id) {
          log.log(`[executeIsolated] model "${preferredRef.provider}/${preferredRef.id}" is unavailable; fallback -> ${resolvedModel.provider}/${resolvedModel.id}`);
        }
      }

      const execModel = models.resolveExecutionModel(resolvedModel);
      const execThinkingLevel = resolveThinkingLevelForModel(
        this._d.getPrefs().getThinkingLevel(),
        execModel,
        (level) => models.resolveThinkingLevel(level),
      );
      const execProviderPromptPatches = getProviderPromptPatches(execModel, {
        reasoningLevel: execThinkingLevel,
        locale: targetAgent.config?.locale || getLocale(),
      });
      const resumeExisting = !!resumeSessionPath && fs.existsSync(resumeSessionPath);
      if (resumeExisting) {
        this._repairOrphanToolHistory(resumeSessionPath);
        this._repairInlineMediaHistory(resumeSessionPath);
        tempSessionMgr = SessionManager.open(resumeSessionPath, sessionDir);
        isResumedSession = true;
      } else {
        tempSessionMgr = SessionManager.create(execCwd, sessionDir);
      }
      const execPermissionMode = normalizeSessionPermissionMode({
        permissionMode: opts.runBudget
          ? (opts.permissionMode === SESSION_PERMISSION_MODES.READ_ONLY ? SESSION_PERMISSION_MODES.READ_ONLY : SESSION_PERMISSION_MODES.ASK)
          : opts.permissionMode || SESSION_PERMISSION_MODES.OPERATE,
      });
      const targetAgentToolsSnapshot = typeof targetAgent.getToolsSnapshot === "function"
        ? targetAgent.getToolsSnapshot({
          forceMemoryEnabled: targetAgent.memoryMasterEnabled !== false,
          model: execModel,
          ...(typeof targetAgent.experienceEnabled === "boolean"
            ? { forceExperienceEnabled: targetAgent.experienceEnabled === true }
            : {}),
        })
        : targetAgent.tools;
      const { tools: allBuiltinTools, customTools: allCustomTools } = this._d.buildTools(
        execCwd,
        targetAgentToolsSnapshot,
        {
          agentDir: targetAgent.agentDir,
          workspace: execCwd,
          workspaceFolders: execWorkspaceScope.workspaceFolders,
          authorizedFolders: execFolderScope.authorizedFolders,
          getAuthorizedFolders: () => execFolderScope.authorizedFolders,
          getSessionPath: () => tempSessionMgr?.getSessionFile?.() || null,
          getTraceContext: () => this._getActiveTraceContext(tempSessionMgr?.getSessionFile?.() || null),
          fileReadSessionPaths: Array.isArray(opts.fileReadSessionPaths)
            ? opts.fileReadSessionPaths.filter((sp) => typeof sp === "string" && sp.trim())
            : [],
          getPermissionMode: () => execPermissionMode,
          permissionContext: opts.subagentContext ? { isSubagent: true, ...(opts.runBudget ? { requireInteractiveApproval: true } : {}) } : null,
        },
      );

      const patrolAllowed = opts.toolFilter
        || targetAgent.config?.desk?.patrol_tools
        || PATROL_TOOLS_DEFAULT;
      // Hide cron tools during heartbeat checks. Otherwise an agent can create
      // a short cron job during heartbeat and accidentally amplify patrol loops.
      const isHeartbeat = opts.activityType === "heartbeat";
      const heartbeatBlocked = new Set(isHeartbeat ? ["cron"] : []);
      const actCustomTools = patrolAllowed === "*"
        ? allCustomTools.filter(t => !heartbeatBlocked.has(t.name))
        : allCustomTools.filter(t => new Set(patrolAllowed).has(t.name) && !heartbeatBlocked.has(t.name));
      const extraCustomTools = Array.isArray(opts.extraCustomTools)
        ? opts.extraCustomTools.filter(t => t && typeof t.name === "string" && t.name.trim())
        : [];

      const actTools = opts.builtinFilter
        ? allBuiltinTools.filter(t => opts.builtinFilter.includes(t.name))
        : allBuiltinTools;

      const agent = this._d.getAgent();
      const skills = this._d.getSkills();
      const resourceLoader = this._d.getResourceLoader();
      let isolatedPrompt;
      if (opts.subagentContext) {
        isolatedPrompt = targetAgent.buildSystemPrompt({ forSubagent: true });
      } else {
        isolatedPrompt = targetAgent.systemPrompt;
      }
      const execResourceLoaderProps: DynamicRecord = {
        getSystemPrompt: { value: () => isolatedPrompt },
        getAppendSystemPrompt: {
          value: () => {
            const base = resourceLoader.getAppendSystemPrompt?.() || [];
            const parts = [...base, ...execProviderPromptPatches];
            const workspacePrompt = formatWorkspaceScopePrompt({
              primaryCwd: execWorkspaceScope.primaryCwd,
              workspaceFolders: execWorkspaceScope.workspaceFolders,
              locale: targetAgent.config?.locale || getLocale(),
            });
            if (workspacePrompt) parts.push(workspacePrompt);
            return parts;
          },
        },
      };
      if (targetAgent !== agent) {
        execResourceLoaderProps.getSkills = {
          value: () => skills.getSkillsForAgent(targetAgent),
        };
      }
      const execResourceLoader = Object.create(resourceLoader, execResourceLoaderProps);

      if (opts.runBudget) {
        opts.runBudget.assertActive();
        if (!Array.isArray(opts.toolFilter) || !Array.isArray(opts.builtinFilter)) {
          throw new Error("Budgeted execution requires explicit tool allowlists.");
        }
        const unboundedDelegation = new Set(["workflow", "subagent", "subagent_reply", "hermes_agent", "channel", "cron", "agent", "team"]);
        if ([...actTools, ...actCustomTools, ...extraCustomTools].some(tool => unboundedDelegation.has(tool.name))) {
          throw new Error("Budgeted execution cannot delegate outside its run budget.");
        }
      }
      executionControl = inheritedExecutionControl
        || (opts.persist ? this._executionControl(tempSessionMgr?.getSessionFile?.()) : new RunController());
      const { session } = await createAgentSession({
        cwd: execCwd,
        sessionManager: tempSessionMgr,
        settingsManager: this._createSettings(execModel),
        modelRuntime: models.modelRuntime,
        model: execModel,
        thinkingLevel: execThinkingLevel,
        resourceLoader: execResourceLoader,
        tools: actTools,
        customTools: [...actCustomTools, ...extraCustomTools],
        executionControl,
      });
      installMemoryContextGuard(session, targetAgent?.agentDir);

      if (opts.runBudget) {
        try {
          // SDK compaction can perform a separate provider call. Disable it and
          // SDK retries rather than letting hidden work evade this run's budget.
          if (typeof session.setAutoCompactionEnabled !== "function" || typeof session.setAutoRetryEnabled !== "function") {
            throw new Error("Budgeted execution requires controllable SDK compaction and retry settings.");
          }
          session.setAutoCompactionEnabled(false);
          session.setAutoRetryEnabled(false);
          installRunBudgetStreamGuard(session, opts.runBudget, () => findModel(this._d.getModels().availableModels, execModel.id, execModel.provider));
        } catch (error) {
          session.dispose();
          cleanupTempSession();
          throw error;
        }
      }

      // This is an execution gate, not an observer. Resolve the actual session's
      // final prompt/model/tools and durably approve them before any model call.
      if (opts.workflowRuntimeGuard) {
        try {
          const finalSystemPrompt = session.agent?.state?.systemPrompt;
          if (typeof finalSystemPrompt !== "string" || !Array.isArray(session.agent?.state?.tools)) {
            throw new Error("Workflow resolved prompt or tool snapshot is unavailable; execution blocked.");
          }
          const snapshot = createResolvedRuntimeSnapshot({
            model: session.model || execModel,
            thinkingLevel: execThinkingLevel,
            systemPrompt: finalSystemPrompt,
            tools: { exposed: session.agent?.state?.tools, implementations: [...actTools, ...actCustomTools, ...extraCustomTools] },
            agentConfig: targetAgent.config,
            scope: { cwd: execCwd, workspace: execWorkspaceScope, folders: execFolderScope, permissionMode: execPermissionMode },
          });
          const decision = opts.workflowRuntimeGuard(snapshot);
          if (decision?.replay) {
            session.dispose();
            cleanupTempSession();
            return { sessionPath: null, replyText: "", error: null, workflowReplay: true };
          }
        } catch (error) {
          session.dispose();
          cleanupTempSession();
          throw error;
        }
      }

      childSessionPath = session.sessionManager?.getSessionFile?.() || null;
      installUsageBudgetGuard(session, () => this._d.getUsageLedger?.(), () => ({
        source: { subsystem: opts.subagentContext ? 'subagent' : 'automation', operation: 'run', surface: 'system', trigger: opts.subagentContext ? 'tool' : 'scheduled', actor: { agentId: targetAgent.id } },
        attribution: { kind: 'session', agentId: targetAgent.id, sessionPath: opts.parentSessionPath || childSessionPath,
          childSessionPath, taskId: opts.subagentTaskId || null, runId: opts.runId || opts.workflowRunId || null, jobId: opts.jobId || opts.cronJobId || null },
      }), model => findModel(this._d.getModels().availableModels, model.id, model.provider));
      traceContext = this._startLifecycleTrace({
        sessionPath: childSessionPath,
        agentId: targetAgent.id || opts.agentId || this._d.getActiveAgentId?.(),
        kind: opts.subagentContext ? "subagent_task" : "isolated_task",
        text: prompt,
        opts,
        model: execModel,
      });

 //
      try { opts.onSessionReady?.(childSessionPath); } catch {
        // Ignore observer callback failures.
      }

      let replyText = "";
      let finalAssistantText = "";
      let finalStopReason = null;
      let finalErrorMessage = null;
      const sessionFiles = [];
      const toolErrors = [];
      const unsub = session.subscribe((event) => {
        const parentSessionPath = typeof opts.parentSessionPath === "string" && opts.parentSessionPath.trim()
          ? opts.parentSessionPath
          : null;
        recordAssistantUsage({
          session,
          ledger: this._d.getUsageLedger?.(),
          event,
          sessionPath: childSessionPath,
          agentId: targetAgent.id,
          model: execModel,
          source: {
            subsystem: opts.subagentContext ? "subagent" : "automation",
            operation: "run",
            surface: opts.subagentContext ? "desktop" : "system",
            trigger: opts.subagentContext ? "tool" : "scheduled",
            ...(opts.subagentContext ? {
              actor: {
                kind: "subagent",
                agentId: targetAgent.id || null,
                sessionPath: childSessionPath,
                taskId: opts.subagentTaskId || null,
                threadId: opts.subagentThreadId || null,
                threadKind: opts.subagentThreadKind || null,
              },
            } : {}),
            ...(parentSessionPath ? {
              parent: {
                kind: "session",
                sessionPath: parentSessionPath,
              },
            } : {}),
          },
          attribution: parentSessionPath
            ? {
                kind: "session",
                agentId: this._d.agentIdFromSessionPath?.(parentSessionPath) || null,
                sessionPath: parentSessionPath,
                childAgentId: opts.subagentContext ? targetAgent.id || null : undefined,
                childSessionPath: opts.subagentContext ? childSessionPath : undefined,
                taskId: opts.subagentContext ? opts.subagentTaskId || null : undefined,
                threadId: opts.subagentContext ? opts.subagentThreadId || null : undefined,
                threadKind: opts.subagentContext ? opts.subagentThreadKind || null : undefined,
              }
            : { kind: opts.subagentContext ? "utility" : "automation", agentId: targetAgent.id || null },
        });
        this._recordLifecycleEvent(childSessionPath, event);
        if (event.type === "message_update") {
          const sub = event.assistantMessageEvent;
          if (sub?.type === "text_delta") {
            replyText += sub.delta || "";
          }
        }
        if (event.type === "message_end" && event.message?.role === "assistant") {
          const assistantMessage = event.message as {
            stopReason?: unknown;
            errorMessage?: string | null;
            error?: string | null;
          };
          finalStopReason = assistantMessage.stopReason ?? null;
          finalErrorMessage = assistantMessage.errorMessage || assistantMessage.error || null;
          finalAssistantText = collectAssistantTextFromMessage(event.message) || finalAssistantText;
        }
        if (event.type === "tool_execution_end") {
          if (event.isError) {
            toolErrors.push(toolErrorSummary(event));
          } else {
            for (const file of collectSessionFilesFromToolResult(event.result)) {
              addUniqueSessionFile(sessionFiles, file);
            }
          }
        }
        if (opts.emitEvents && childSessionPath) {
          this._d.emitEvent({ ...event, isolated: true }, childSessionPath);
        }
      });

      const teardownIsolatedSession = async (label) => {
        await teardownSessionResources({
          session,
          unsub,
          label: `executeIsolated[${label}]`,
          warn: (msg) => log.warn(msg),
        });
      };

      const abortHandler = () => session.abort();
      opts.signal?.addEventListener("abort", abortHandler, { once: true });

      if (opts.signal?.aborted) {
        opts.signal.removeEventListener("abort", abortHandler);
        await teardownIsolatedSession("early_abort");
        cleanupTempSession();
        this._endLifecycleTrace(traceContext, { status: "aborted" });
        traceContext = null;
        return { sessionPath: null, replyText: "", error: "aborted", sessionFiles, toolErrors };
      }

      try {
        this._recordLifecyclePhase(traceContext, "model.stream.start", {
          summary: "model stream started",
        });
        if (!executionControl.snapshot()) executionControl.begin();
        await executionControl.run(() => session.prompt(prompt));
      } finally {
        opts.signal?.removeEventListener("abort", abortHandler);
        await teardownIsolatedSession("finally");
      }
      this._recordLifecyclePhase(traceContext, "state.updated", {
        summary: "session state updated",
      });
      this._recordLifecyclePhase(traceContext, "render.emitted", {
        summary: "terminal render emitted",
      });
      this._endLifecycleTrace(traceContext, { status: "completed" });
      traceContext = null;

      const sessionPath = session.sessionManager?.getSessionFile?.() || null;
      const finalReplyText = stripClosedInternalNarrationBlocks(replyText || finalAssistantText);
      const executionRun = executionControl.snapshot();
      const completionError = isExecutionPaused(executionRun) ? 'run_paused' : isolatedCompletionError(finalStopReason, finalErrorMessage);

      if (!opts.persist && !isResumedSession && sessionPath) {
        try { fs.unlinkSync(sessionPath); } catch {
          // Ignore isolated session cleanup failures.
        }
        return {
          sessionPath: null,
          replyText: finalReplyText,
          error: completionError,
          stopReason: finalStopReason,
          sessionFiles,
          toolErrors,
          executionRun,
        };
      }

      return {
        sessionPath,
        replyText: finalReplyText,
        error: completionError,
        stopReason: finalStopReason,
        sessionFiles,
        toolErrors,
        executionRun,
      };
    } catch (err) {
      log.error(`isolated execution failed: ${err.message}`);
      this._endLifecycleTrace(traceContext, {
        status: err?.message?.includes("aborted") ? "aborted" : "failed",
        error: err,
      });
      if (!opts.persist && tempSessionMgr) {
        cleanupTempSession();
      }
      return { sessionPath: opts.persist ? childSessionPath : null, replyText: "", error: err.message, executionRun: executionControl?.snapshot() || null };
    } finally {
      if (childSessionPath && bm.isRunning(childSessionPath)) {
        try { await bm.closeBrowserForSession(childSessionPath); } catch (err) {
          log.warn(`executeIsolated browser cleanup failed for ${path.basename(childSessionPath)}: ${err.message}`);
        }
      }
      this._headlessOps.delete(opId);
      if (this._headlessOps.size === 0) bm.setHeadless(false);
      const browserNowRunning = bm.hasAnyRunning;
      if (browserNowRunning !== wasBrowserRunning) {
        this._d.emitEvent({ type: "browser_bg_status", running: browserNowRunning }, null);
      }
    }
  }

  /** Create per-session settings such as compaction + max_completion_tokens. */
  _createSettings(model) {
    return createDefaultSettings(model);
  }
}
