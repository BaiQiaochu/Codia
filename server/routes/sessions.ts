import { projectComposerHistory } from '../../core/composer-presentation.ts';
import { hasAgentReviewRequest } from '../../core/agent-review-turns.ts';
/**
 * Session 管理 REST 路由
 */
import fs from "fs/promises";
import path from "path";
import { Hono } from "hono";
import { routeError, strictJson } from "../hono-helpers.ts";
import { t } from "../../lib/i18n.ts";
import { extractBlocks, resolveMediaGenerationBlocks } from "../block-extractors.ts";

function normalizeLegacyPluginPresentation(presentation: any, engine: any) {
  if (!presentation || typeof presentation !== 'object' || Array.isArray(presentation)) return presentation;
  if (Array.isArray(presentation.plugins) && presentation.plugins.length > 0) return presentation;
  if (typeof presentation.text !== 'string' || !presentation.text.includes('$')) return presentation;

  const installed = (engine?.pluginManager?.listPlugins?.() || [])
    .filter((plugin: any) => plugin && !plugin.hidden && typeof plugin.id === 'string' && plugin.id.trim())
    .sort((a: any, b: any) => b.id.length - a.id.length);
  if (installed.length === 0) return presentation;

  let text = presentation.text;
  const plugins: Array<{ id: string; name: string }> = [];
  for (const plugin of installed) {
    const escapedId = plugin.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const token = new RegExp(`(^|\\s)\\$${escapedId}(?=\\s|$)`, 'g');
    if (!token.test(text)) continue;
    token.lastIndex = 0;
    text = text.replace(token, '$1');
    plugins.push({ id: plugin.id, name: String(plugin.name || plugin.id) });
  }
  if (plugins.length === 0) return presentation;
  return { ...presentation, text: text.replace(/[ \t]{2,}/g, ' ').trim(), plugins };
}
import { BrowserManager } from "../../lib/browser/browser-manager.ts";
import { replayLatestUserTurn } from "../../core/session-turn-actions.ts";
import {
  materializeExecutorIdentity,
  normalizeExecutorMetadata,
  readSubagentSessionMetaSync,
} from "../../lib/subagent-executor-metadata.ts";
import { sessionIdFromFilename } from "../../lib/session-jsonl.ts";
import {
  extractTextContent,
  filterUnreferencedInlineImages,
  loadSessionHistoryMessages,
  loadLatestAssistantSummaryFromSessionFile,
  isValidSessionPath,
  isActiveSessionPath,
  isArchivedDesktopSessionPath,
} from "../../core/message-utils.ts";
import {
  loadLatestTodosFromSessionFile,
  loadLatestTodoSnapshotFromSessionFile,
} from "../../lib/tools/todo-compat.ts";
import { SessionManager } from "../../lib/pi-sdk/index.ts";
import { TODO_STATE_CUSTOM_TYPE } from "../../lib/tools/todo-constants.ts";
import { mergeWorkspaceHistory } from "../../shared/workspace-history.ts";
import { sanitizeFilename } from "../../shared/filename-sanitizer.ts";
import { getModelThinkingLevels, modelSupportsXhigh, resolveModelDefaultThinkingLevel } from "../../core/session-thinking-level.ts";
import { sessionFileRevision } from "../../core/session-list-projection-cache.ts";
import {
  modelSupportsAudioInput,
  modelSupportsDirectAudioInput,
  modelSupportsDirectVideoInput,
  modelSupportsVideoInput,
  resolveModelAudioInputTransport,
  resolveModelVideoInputTransport,
} from "../../shared/model-capabilities.ts";
import {
  deleteSessionFileSidecarSync,
  moveSessionFileSidecarSync,
  sessionFileSidecarPath,
} from "../../lib/session-files/session-file-registry.ts";
import { serializeSessionFile } from "../../lib/session-files/session-file-response.ts";
import { browserScreenshotPath } from "../../lib/session-files/browser-screenshot-file.ts";
import { createModuleLogger } from "../../lib/debug-log.ts";
import { searchSessions } from "../../lib/search/session-search.ts";
import { SessionSearchTokenizerUnavailableError } from "../../lib/search/session-search-tokenizer.ts";
import {
  DEFERRED_RESULT_MESSAGE_TYPE,
  DEFERRED_RESULT_RECORD_TYPE,
  parseDeferredResultNotification,
  parseDeferredResultRecord,
} from "../../lib/deferred-result-notification.ts";
import {
  TURN_INPUT_CONSUMPTION_EVENT_TYPE,
  TURN_INPUT_PRESENTATION_EVENT_TYPE,
  parseTurnInputConsumptionRecord,
  parseTurnInputPresentationRecord,
} from "../../lib/turn-input-presentation.ts";
import { buildDeferredResultInterludeBlock, resolveDeferredReceiverName } from "../deferred-result-interlude.ts";
import { MountAwareFileError, MountAwareFileService } from "../../core/mount-aware-file-service.ts";
import { normalizePluginChatSurfaceBlocks } from "../plugin-chat-surface.ts";

const log = createModuleLogger("sessions");
const SESSION_SEARCH_QUERY_MAX_LENGTH = 512;

type RouteError = Error & {
  code?: string;
  status?: number;
};

function isFreshCompactBusyError(err: unknown): boolean {
  const message = String((err as { message?: unknown })?.message || err || "").toLowerCase();
  return message.includes("session is streaming")
    || message.includes("already compacting")
    || message.includes("session is busy")
    || message.includes("session_busy")
    || message.includes("reloadsessionruntime: session is busy");
}

function rcPlatformFromSessionKey(sessionKey) {
  const match = /^([a-z]+)_/i.exec(sessionKey || "");
  return match ? match[1] : "bridge";
}

function sessionIdFromPath(sessionPath) {
  return path.basename(sessionPath || "").replace(/\.(jsonl|json)$/i, "");
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readSessionFileRevision(sessionPath) {
  if (!sessionPath) return null;
  try {
    return sessionFileRevision(await fs.stat(sessionPath));
  } catch {
    return null;
  }
}

function sessionFolderScopeResponse(scope) {
  return {
    ok: true,
    sessionPath: scope?.sessionPath || null,
    cwd: scope?.cwd || null,
    workspaceFolders: Array.isArray(scope?.workspaceFolders) ? scope.workspaceFolders : [],
    authorizedFolders: Array.isArray(scope?.authorizedFolders) ? scope.authorizedFolders : [],
    sandboxFolders: Array.isArray(scope?.sandboxFolders) ? scope.sandboxFolders : [],
  };
}

function normalizeAuthorizedFolderPath(rawFolder) {
  if (typeof rawFolder !== "string" || !rawFolder.trim()) {
    throw new Error("folder is required");
  }
  return path.resolve(rawFolder.trim());
}

async function validateAuthorizedFolder(rawFolder) {
  const folder = normalizeAuthorizedFolderPath(rawFolder);
  let stat;
  try {
    stat = await fs.stat(folder);
  } catch {
    throw new Error("folder does not exist");
  }
  if (!stat.isDirectory()) {
    throw new Error("folder must be a directory");
  }
  return folder;
}

function completeTodoItems(todos) {
  return (Array.isArray(todos) ? todos : []).map((todo) => ({
    ...todo,
    status: "completed",
  }));
}

function getWritableSessionManager(engine, sessionPath) {
  const liveSession = engine.getSessionByPath?.(sessionPath);
  if (liveSession?.sessionManager) return liveSession.sessionManager;
  return SessionManager.open(sessionPath, path.dirname(sessionPath));
}

function makeRouteError(message, code, status): RouteError {
  const err = new Error(message) as RouteError;
  err.code = code;
  err.status = status;
  return err;
}

function resolveSessionWorkspaceSelection(engine, body) {
  const mountId = typeof body?.workspaceMountId === "string" && body.workspaceMountId.trim()
    ? body.workspaceMountId.trim()
    : null;
  if (!mountId) {
    return {
      cwd: typeof body?.cwd === "string" && body.cwd.trim() ? body.cwd : null,
      mount: null,
    };
  }
  if (typeof body?.cwd === "string" && body.cwd.trim()) {
    throw makeRouteError("cwd and workspaceMountId cannot be combined", "ambiguous_workspace", 400);
  }
  try {
    const files = new MountAwareFileService({
      codiaHome: engine.codiaHome || engine.codiaHome || engine.homeDir,
      defaultRoot: engine.defaultDeskCwd || engine.homeCwd || engine.deskCwd,
      studioId: engine.getRuntimeContext?.()?.studioId || null,
    });
    const root = files.resolveRoot(mountId);
    return {
      cwd: files.resolveDirectory(mountId, ""),
      mount: {
        mountId: root.mountId || root.id || mountId,
        label: root.label || null,
      },
    };
  } catch (err) {
    if (err instanceof MountAwareFileError) {
      const fileErr = err as RouteError;
      throw makeRouteError(fileErr.message, fileErr.code, fileErr.status);
    }
    throw err;
  }
}

function sessionWorkspaceMountFields(engine, sessionPath, fallback = null) {
  const mount = engine.getSessionWorkspaceMount?.(sessionPath) || fallback || null;
  if (!mount?.mountId) return {};
  return {
    workspaceMountId: mount.mountId,
    workspaceLabel: mount.label || null,
  };
}

function isDisplayableHistoryMessage(message) {
  if (!message || typeof message !== "object") return false;
  if (message.role === "user") {
    const { text, images } = extractTextContent(message.content);
    return !!text || filterUnreferencedInlineImages(text, images).length > 0;
  }
  if (message.role === "assistant") {
    const { text, toolUses } = extractTextContent(message.content, { stripThink: true });
    return !!text || toolUses.length > 0;
  }
  return false;
}

function nextImmediateDisplayableAssistantIndex(sourceMessages, sourceIndex, displayIdxAtSource) {
  let displayIdx = displayIdxAtSource;
  for (let i = sourceIndex + 1; i < sourceMessages.length; i += 1) {
    const message = sourceMessages[i];
    if (!isDisplayableHistoryMessage(message)) continue;
    const currentIndex = displayIdx;
    displayIdx += 1;
    if (message.role === "user") return null;
    if (message.role === "assistant") return currentIndex;
  }
  return null;
}

function deferredRecordData(message) {
  if (message?.role !== "custom" || message.customType !== DEFERRED_RESULT_RECORD_TYPE) return null;
  const data = message.data && typeof message.data === "object" && !Array.isArray(message.data)
    ? message.data
    : message;
  if (!data.taskId || typeof data.taskId !== "string") return null;
  return data;
}

function parseHistoryDeferredResult(message) {
  if (message?.role !== "custom") return null;
  if (message.customType === DEFERRED_RESULT_RECORD_TYPE) {
    return parseDeferredResultRecord(deferredRecordData(message));
  }
  if (message.customType === DEFERRED_RESULT_MESSAGE_TYPE) {
    return parseDeferredResultNotification(message.content);
  }
  return null;
}

function historyDeferredDeliveryId(message, sourceIndex) {
  const details = message?.details && typeof message.details === "object" ? message.details : null;
  const fromDetails = typeof details?.deliveryId === "string" && details.deliveryId.trim()
    ? details.deliveryId.trim()
    : null;
  if (fromDetails) return fromDetails;
  return Number.isInteger(sourceIndex) ? `history:${sourceIndex}` : null;
}

const TODO_COMPLETE_MESSAGE =
  "[Codia Todo] The user marked the current todo list as completed and removed it from the session UI. Treat every item in that list as completed. Create a new todo list only if new work needs tracking.";

export function createSessionsRoute(engine: any, hub: any = null) {
  const route = new Hono<any>();
  const lifecycleLocks = new Map<string, Promise<void>>();

  function currentSessionPathForId(sessionId: string | null) {
    if (!sessionId) return null;
    const manifest = engine.getSessionManifest?.(sessionId) || null;
    const currentPath = manifest?.currentLocator?.path;
    return typeof currentPath === "string" && currentPath ? currentPath : null;
  }

  function resolveSessionCacheLocator(sessionPath) {
    if (!sessionPath) return { cacheKey: null, readPath: null, sessionId: null };
    const sessionId = engine.getSessionIdForPath?.(sessionPath) || null;
    const currentPath = sessionId ? currentSessionPathForId(sessionId) : null;
    return {
      cacheKey: sessionId || sessionPath,
      readPath: currentPath || sessionPath,
      sessionId,
    };
  }

  function sessionLifecycleRef(sessionPath) {
    if (!sessionPath) return sessionPath;
    try {
      const sessionId = engine.getSessionIdForPath?.(sessionPath);
      if (typeof sessionId === "string" && sessionId.trim()) {
        return { sessionId: sessionId.trim(), sessionPath };
      }
    } catch {
      // Fall back to the path for legacy sessions or failed manifest lookups.
    }
    return sessionPath;
  }

  async function resolveSessionPathRef(body: any = {}, { archived = false, preferSessionId = false }: any = {}) {
    const sessionId = typeof body?.sessionId === "string" ? body.sessionId.trim() : "";
    const resolveById = async () => {
      if (!sessionId) return null;
      const manifestPath = !archived ? currentSessionPathForId(sessionId) : null;
      if (manifestPath) return manifestPath;
      const listFn = archived ? engine.listArchivedSessions : engine.listSessions;
      const sessions = typeof listFn === "function" ? await listFn.call(engine) : [];
      return sessions.find(s => s?.sessionId === sessionId || sessionIdFromPath(s.path) === sessionId)?.path || null;
    };
    if (preferSessionId) {
      const resolved = await resolveById();
      if (resolved) return resolved;
    }
    if (body?.path || body?.sessionPath) return body.path || body.sessionPath;
    return await resolveById();
  }

  async function resolveListedSessionIdForPath(sessionPath: string, { archived = false }: any = {}) {
    const manifestSessionId = engine.getSessionIdForPath?.(sessionPath);
    if (typeof manifestSessionId === "string" && manifestSessionId.trim()) return manifestSessionId.trim();
    const listFn = archived ? engine.listArchivedSessions : engine.listSessions;
    const sessions = typeof listFn === "function" ? await listFn.call(engine) : [];
    const listed = sessions.find(s => s?.path === sessionPath);
    return listed?.sessionId || sessionIdFromPath(sessionPath);
  }

  async function stableSessionIdForResolvedPath(body: any, sessionPath: string, { archived = false }: any = {}) {
    const requestedSessionId = typeof body?.sessionId === "string" ? body.sessionId.trim() : "";
    if (requestedSessionId) {
      const manifestPath = !archived ? currentSessionPathForId(requestedSessionId) : null;
      if (manifestPath === sessionPath) return requestedSessionId;
      const listFn = archived ? engine.listArchivedSessions : engine.listSessions;
      const sessions = typeof listFn === "function" ? await listFn.call(engine) : [];
      const listed = sessions.find(s => s?.sessionId === requestedSessionId);
      if (listed?.path === sessionPath) return requestedSessionId;
    }
    return await resolveListedSessionIdForPath(sessionPath, { archived });
  }

  function resolveSubagentBlockSession(block, task = null, run = null) {
    const rawSessionId =
      block?.sessionId
      || task?.meta?.sessionId
      || run?.childSessionId
      || null;
    let sessionId = typeof rawSessionId === "string" && rawSessionId.trim() ? rawSessionId.trim() : null;
    let sessionPath =
      block?.streamKey
      || task?.meta?.sessionPath
      || run?.childSessionPath
      || null;
    if (typeof sessionPath !== "string" || !sessionPath.trim()) sessionPath = null;
    if (!sessionId && sessionPath) {
      sessionId = engine.getSessionIdForPath?.(sessionPath) || null;
    }
    if (sessionId) {
      sessionPath = currentSessionPathForId(sessionId) || sessionPath;
    }
    return { sessionId, sessionPath };
  }

 // session-meta.json sidecar -session 目录共享；同一-request 里遍历几十个 block
 // 时不必每-block 都重-readFileSync + JSON.parse。调用端构造一-Map -cache-
  function createSubagentMetaCache() {
    const map = new Map();
    return (sessionPath) => {
      if (!sessionPath) return null;
      const { cacheKey, readPath, sessionId } = resolveSessionCacheLocator(sessionPath);
      if (!cacheKey || !readPath) return null;
      if (map.has(cacheKey)) return map.get(cacheKey);
      const manifestMeta = normalizeExecutorMetadata(
        engine.getSessionExecutorMetadata?.({ sessionId, sessionPath: readPath }),
      );
      const meta = manifestMeta || readSubagentSessionMetaSync(readPath);
      map.set(cacheKey, meta);
      return meta;
    };
  }

  function applySubagentIdentity(block, task, readSessionMeta) {
    const sessionRef = resolveSubagentBlockSession(block, task);
    if (sessionRef.sessionId && !block.sessionId) block.sessionId = sessionRef.sessionId;
    if (sessionRef.sessionPath) block.streamKey = sessionRef.sessionPath;
    const sessionPath = sessionRef.sessionPath;
    const sessionMeta = readSessionMeta(sessionPath);
    const resolved =
      materializeExecutorIdentity(sessionMeta, engine.getAgent?.bind(engine))
      || materializeExecutorIdentity(task?.meta, engine.getAgent?.bind(engine))
      || materializeExecutorIdentity(block, engine.getAgent?.bind(engine));

    if (resolved) {
      block.agentId = resolved.agentId;
      block.agentName = resolved.agentName;
      return;
    }

    const inferredAgentId = sessionPath
      ? engine.agentIdFromSessionPath?.(sessionPath) || null
      : null;
    if (!inferredAgentId) return;

    const inferredAgent = engine.getAgent?.(inferredAgentId) || null;
    block.agentId = inferredAgentId;
    block.agentName = inferredAgent?.agentName || "Unknown agent";
  }

  function patchBlockExecutorMetadata(block, task, readSessionMeta) {
    const sessionRef = resolveSubagentBlockSession(block, task);
    if (sessionRef.sessionId && !block.sessionId) block.sessionId = sessionRef.sessionId;
    if (sessionRef.sessionPath) block.streamKey = sessionRef.sessionPath;
    const sessionPath = sessionRef.sessionPath;
    const sessionMeta = readSessionMeta(sessionPath);
    const sources = [sessionMeta, task?.meta, block];

    for (const source of sources) {
      if (!source) continue;
      if (source.executorAgentId && !block.executorAgentId) {
        block.executorAgentId = source.executorAgentId;
      }
      if (source.executorAgentNameSnapshot && !block.executorAgentNameSnapshot) {
        block.executorAgentNameSnapshot = source.executorAgentNameSnapshot;
      }
      if (source.executorMetaVersion && !block.executorMetaVersion) {
        block.executorMetaVersion = source.executorMetaVersion;
      }
    }
  }

  function patchBlockRequestedMetadata(block, task = null) {
    const sources = [task?.meta, block];

    for (const source of sources) {
      if (!source) continue;
      if (source.requestedAgentId && !block.requestedAgentId) {
        block.requestedAgentId = source.requestedAgentId;
      }
      if (source.requestedAgentNameSnapshot && !block.requestedAgentName) {
        block.requestedAgentName = source.requestedAgentNameSnapshot;
      }
    }
  }

  function taskFromSubagentRun(run) {
    if (!run) return null;
    return {
      status: run.status,
      result: run.summary || null,
      reason: run.reason || run.summary || null,
      meta: {
        sessionId: run.childSessionId || null,
        sessionPath: run.childSessionPath || null,
        requestedAgentId: run.requestedAgentId || null,
        requestedAgentNameSnapshot: run.requestedAgentNameSnapshot || null,
        executorAgentId: run.executorAgentId || null,
        executorAgentNameSnapshot: run.executorAgentNameSnapshot || null,
        executorMetaVersion: run.executorMetaVersion || null,
      },
    };
  }

  function mergeSubagentTaskMetadata(primary, fallback) {
    if (!primary) return fallback || null;
    if (!fallback) return primary;
    const primaryMeta = {};
    for (const [key, value] of Object.entries(primary.meta || {})) {
      if (value != null) primaryMeta[key] = value;
    }
    return {
      status: primary.status || fallback.status,
      result: primary.result ?? fallback.result,
      reason: primary.reason ?? fallback.reason,
      meta: {
        ...(fallback.meta || {}),
        ...primaryMeta,
      },
    };
  }

  function createSubagentSummaryCache() {
    const map = new Map();
    return async (sessionPath) => {
      if (!sessionPath) return null;
      const { cacheKey, readPath } = resolveSessionCacheLocator(sessionPath);
      if (!cacheKey || !readPath) return null;
      if (!map.has(cacheKey)) {
        map.set(cacheKey, loadLatestAssistantSummaryFromSessionFile(readPath));
      }
      return await map.get(cacheKey);
    };
  }

  function getSessionSummaryRecord(sessionPath, agentIdHint = null) {
    if (!sessionPath) return null;
    const agentId = agentIdHint || engine.agentIdFromSessionPath?.(sessionPath) || null;
    if (!agentId) return null;
    const agent = engine.getAgent?.(agentId) || null;
    const summaryManager = agent?.summaryManager || null;
    if (!summaryManager || typeof summaryManager.getSummary !== "function") return null;
    const sessionId = engine.getSessionIdForPath?.(sessionPath)
      || sessionIdFromFilename(path.basename(sessionPath))
      || sessionIdFromPath(sessionPath);
    const record = summaryManager.getSummary(sessionId);
    return record?.summary?.trim() ? record : null;
  }

  function serializeSessionSummaryRecord(record) {
    return {
      hasSummary: !!record,
      summary: record?.summary || null,
      createdAt: record?.created_at || null,
      updatedAt: record?.updated_at || null,
    };
  }

  function invalidateRcTarget(sessionPath) {
    const rcState = engine.rcState;
    if (!rcState?.invalidateDesktopSession) return;

    const { detachedAttachments } = rcState.invalidateDesktopSession(sessionPath);
    for (const attachment of detachedAttachments) {
      try {
        engine.emitEvent?.({
          type: "bridge_rc_detached",
          sessionKey: attachment.sessionKey,
          sessionPath: attachment.desktopSessionPath,
        }, attachment.desktopSessionPath);
      } catch {}
    }
  }

  function archivedPathForActiveSession(sessionPath) {
    return path.join(path.dirname(sessionPath), "archived", path.basename(sessionPath));
  }

  function activePathForArchivedSession(sessionPath) {
    return path.join(path.dirname(path.dirname(sessionPath)), path.basename(sessionPath));
  }

  function lifecycleLockKeyForPaths(paths) {
    for (const sessionPath of uniqueLifecyclePaths(paths)) {
      try {
        const sessionId = engine.getSessionIdForPath?.(sessionPath);
        if (typeof sessionId === "string" && sessionId.trim()) return `session:${sessionId.trim()}`;
      } catch {
        // Fall through to path-derived legacy keys.
      }
    }
    for (const sessionPath of uniqueLifecyclePaths(paths)) {
      const sessionPathText = typeof sessionPath === "string" ? sessionPath : "";
      const agentId = engine.agentIdFromSessionPath?.(sessionPathText) || "unknown-agent";
      const basename = path.basename(sessionPathText);
      if (basename) return `legacy:${agentId}:${basename}`;
    }
    return "legacy:unknown-session";
  }

  async function withSessionLifecycleLock(paths, fn) {
    const key = lifecycleLockKeyForPaths(paths);
    while (lifecycleLocks.has(key)) {
      await lifecycleLocks.get(key)?.catch(() => {});
    }
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    lifecycleLocks.set(key, held);
    try {
      return await fn();
    } finally {
      if (lifecycleLocks.get(key) === held) lifecycleLocks.delete(key);
      release();
    }
  }

  async function moveSessionLifecycleOrThrow(input, { optional = false } = {}) {
    if (typeof engine.moveSessionLifecycle !== "function") {
      if (optional) return null;
      const error: any = new Error("Session manifest lifecycle transition is unavailable");
      error.code = "session_manifest_unavailable";
      error.status = 503;
      throw error;
    }
    const manifest = await engine.moveSessionLifecycle(input);
    if (!manifest?.sessionId) {
      const error: any = new Error("Session manifest lifecycle transition failed");
      error.code = "session_lifecycle_transition_failed";
      error.status = 500;
      throw error;
    }
    return manifest;
  }

  async function sessionFileHasMessages(sessionPath) {
    const raw = await fs.readFile(sessionPath, "utf-8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        return true;
      }
      if (entry?.type === "message" && entry.message) return true;
    }
    return false;
  }

  async function repairHeaderOnlyActiveRestoreTarget(destPath) {
    if (!(await pathExists(destPath))) return { repaired: false };
    if (await sessionFileHasMessages(destPath)) {
      const error: any = new Error("Active path already exists with messages");
      error.code = "active_session_conflict";
      error.status = 409;
      throw error;
    }
    await fs.unlink(destPath);
    deleteSessionFileSidecarSync(destPath);
    return { repaired: true };
  }

  function uniqueLifecyclePaths(paths) {
    return [...new Set((paths || []).filter((p) => typeof p === "string" && p.trim()))];
  }

  async function cleanupSessionLifecycle(sessionPaths, reason, options = {}) {
    const bm = BrowserManager.instance();
    for (const sessionPath of uniqueLifecyclePaths(sessionPaths)) {
      const sessionRef = sessionLifecycleRef(sessionPath);
      try {
        engine.taskRegistry?.abortByParentSession?.(sessionPath, reason);
      } catch (err) {
        console.warn(`[sessions/lifecycle] task cleanup failed for ${sessionPath}: ${err.message}`);
      }
      try {
        engine.subagentRuns?.abortByParentSession?.(sessionPath, reason);
      } catch (err) {
        console.warn(`[sessions/lifecycle] subagent run cleanup failed for ${sessionPath}: ${err.message}`);
      }
      try {
        engine.subagentThreads?.removeBySession?.(sessionPath);
      } catch (err) {
        console.warn(`[sessions/lifecycle] subagent thread cleanup failed for ${sessionPath}: ${err.message}`);
      }
      try {
        engine.activityHub?.clearBySession?.(sessionRef);
      } catch (err) {
        console.warn(`[sessions/lifecycle] activity hub cleanup failed for ${sessionPath}: ${err.message}`);
      }
      try {
        engine.deferredResults?.suppressBySession?.(sessionRef, reason);
      } catch (err) {
        console.warn(`[sessions/lifecycle] deferred cleanup failed for ${sessionPath}: ${err.message}`);
      }
      try {
        engine.confirmStore?.abortBySession?.(sessionRef);
      } catch (err) {
        console.warn(`[sessions/lifecycle] confirm cleanup failed for ${sessionPath}: ${err.message}`);
      }
      try {
        if (typeof engine.discardSessionRuntime === "function") {
          if (options && Object.keys(options).length > 0) {
            await engine.discardSessionRuntime(sessionPath, reason, options);
          } else {
            await engine.discardSessionRuntime(sessionPath, reason);
          }
        } else {
          await engine.abortSessionByPath?.(sessionPath);
        }
      } catch (err) {
        console.warn(`[sessions/lifecycle] session runtime cleanup failed for ${sessionPath}: ${err.message}`);
      }
      try {
        await bm.closeBrowserForSession(sessionPath);
      } catch (err) {
        console.warn(`[sessions/lifecycle] browser cleanup failed for ${sessionPath}: ${err.message}`);
      }
      try {
        engine.terminalSessions?.closeForSession?.(sessionPath);
      } catch (err) {
        console.warn(`[sessions/lifecycle] terminal cleanup failed for ${sessionPath}: ${err.message}`);
      }
      invalidateRcTarget(sessionPath);
    }
  }

 // 列出所-agent 的历-session
  route.get("/sessions", async (c) => {
    try {
      const sessions = await engine.listSessions();
      const attachments = engine.rcState?.listAttachments?.() || [];
      const rcAttachmentByPath = new Map(attachments.map((attachment) => [
        attachment.desktopSessionPath,
        {
          sessionKey: attachment.sessionKey,
          platform: rcPlatformFromSessionKey(attachment.sessionKey),
        },
      ]));
      return c.json(sessions.map(s => {
        const summaryRecord = getSessionSummaryRecord(s.path, s.agentId || null);
        return {
          id: sessionIdFromPath(s.path),
          sessionId: s.sessionId || sessionIdFromPath(s.path),
          path: s.path,
          title: s.title || null,
          firstMessage: (s.firstMessage || "").slice(0, 100),
          modified: s.modified?.toISOString() || null,
          revision: typeof s.revision === "string" ? s.revision : null,
          messageCount: s.messageCount || 0,
          cwd: s.cwd || null,
          agentId: s.agentId || null,
          agentName: s.agentName || null,
          projectId: s.projectId || null,
          modelId: s.modelId || null,
          modelProvider: s.modelProvider || null,
          pinnedAt: s.pinnedAt || null,
          workspaceMountId: s.workspaceMountId || null,
          workspaceLabel: s.workspaceLabel || null,
          hasSummary: !!summaryRecord,
          rcAttachment: rcAttachmentByPath.get(s.path)
            ? {
              ...(rcAttachmentByPath.get(s.path) as any),
              title: s.title || null,
            }
            : null,
        };
      }));
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  route.get("/sessions/search", async (c) => {
    try {
      const query = c.req.query("q") || "";
      const phase = c.req.query("phase") === "content" ? "content" : "title";
      const limit = c.req.query("limit");
      const trimmedQuery = query.trim();
      if (!trimmedQuery) return c.json({ query, phase, results: [] });
      if ([...trimmedQuery].length > SESSION_SEARCH_QUERY_MAX_LENGTH) {
        return c.json({
          error: "query_too_long",
          maxLength: SESSION_SEARCH_QUERY_MAX_LENGTH,
        }, 400);
      }

      const sessions = await engine.listSessions();
      const results = searchSessions(sessions, trimmedQuery, { phase, limit }).map((s) => ({
        sessionId: s.sessionId || sessionIdFromPath(s.path),
        path: s.path,
        title: s.title || null,
        firstMessage: (s.firstMessage || "").slice(0, 100),
        modified: s.modified?.toISOString?.() || s.modified || null,
        revision: typeof s.revision === "string" ? s.revision : null,
        messageCount: s.messageCount || 0,
        cwd: s.cwd || null,
        agentId: s.agentId || null,
        agentName: s.agentName || null,
        projectId: s.projectId || null,
        modelId: s.modelId || null,
        modelProvider: s.modelProvider || null,
        pinnedAt: s.pinnedAt || null,
        workspaceMountId: s.workspaceMountId || null,
        workspaceLabel: s.workspaceLabel || null,
        matchKind: s.matchKind,
        snippet: s.snippet || "",
        score: s.score,
      }));
      return c.json({ query, phase, results });
    } catch (err) {
      if (err instanceof SessionSearchTokenizerUnavailableError) {
        log.error("session search tokenizer unavailable", err.cause || err);
        return c.json({ error: err.message }, 503);
      }
      return c.json({ error: err.message }, 500);
    }
  });

  route.get("/sessions/summary", async (c) => {
    try {
      const sessionPath = c.req.query("path") || null;
      if (!sessionPath) {
        return c.json({ error: t("error.missingParam", { param: "path" }) }, 400);
      }
      if (!isValidSessionPath(sessionPath, engine.agentsDir) || !isActiveSessionPath(sessionPath, engine.agentsDir)) {
        return c.json({ error: "Invalid session path" }, 403);
      }
      return c.json(serializeSessionSummaryRecord(getSessionSummaryRecord(sessionPath)));
    } catch (err) {
      return routeError(c, err);
    }
  });

  // Pin / unpin a session.
  route.post("/sessions/pin", async (c) => {
    try {
      const body = await strictJson(c);
      const sessionPath = await resolveSessionPathRef(body);
      const { pinned } = body;
      if (!sessionPath) {
        return c.json({ error: t("error.missingParam", { param: "path" }) }, 400);
      }
      if (typeof pinned !== "boolean") {
        return c.json({ error: t("error.missingParam", { param: "pinned" }) }, 400);
      }
      if (!isValidSessionPath(sessionPath, engine.agentsDir)) {
        return c.json({ error: "Invalid session path" }, 403);
      }
      const pinnedAt = await engine.setSessionPinned(sessionPath, pinned);
      return c.json({ ok: true, pinnedAt });
    } catch (err) {
      return routeError(c, err);
    }
  });

 // 获取 session 的消息（支持 -path= 指定 session，否则读焦点 session-
  route.get("/sessions/messages", async (c) => {
    try {
      let queryPath = c.req.query("path") || c.req.query("sessionPath") || null;
      const querySessionId = c.req.query("sessionId") || null;
      if (!queryPath && querySessionId) {
        queryPath = await resolveSessionPathRef({ sessionId: querySessionId });
        if (!queryPath) {
          return c.json({ error: t("error.sessionNotFound") }, 404);
        }
      }
      if (queryPath && !isValidSessionPath(queryPath, engine.agentsDir)) {
        return c.json({ error: "Invalid session path" }, 403);
      }
      const resolvedSessionPathForRevision = queryPath || engine.currentSessionPath || null;
      const revision = await readSessionFileRevision(resolvedSessionPathForRevision);
      const sourceMessages = projectComposerHistory(await loadSessionHistoryMessages(engine, queryPath), id => hasAgentReviewRequest(engine, id));

      // 分页参数
      const beforeId = c.req.query("before") != null ? Number(c.req.query("before")) : null;
      const limit = Math.min(Number(c.req.query("limit")) || 50, 200);

 // 提取可显示的消息（user/assistant 文本 + 文件/artifact 工具结果- // 每条消息带稳-id（原-sourceMessages 索引-
      const allMessages = [];
      const blocks = [];
      const mediaGenerationResults = new Map();
      const standaloneMediaGenerationResults = [];
      const deferredInterludeDeliveryIds = new Set();
      const turnInputConsumptionDeliveryIds = new Set();
      const turnInputConsumptionEntryIds = new Set();
      const deferredStore = engine.deferredResults;
      const receiverName = resolveDeferredReceiverName(engine, queryPath || engine.currentSessionPath || null);
      let globalIdx = 0;

      for (const message of sourceMessages) {
        if (message?.role !== "custom" || message.customType !== TURN_INPUT_CONSUMPTION_EVENT_TYPE) continue;
        const parsed = parseTurnInputConsumptionRecord(message.data);
        const deliveryId = typeof parsed?.deliveryId === "string" && parsed.deliveryId.trim()
          ? parsed.deliveryId.trim()
          : null;
        const entryId = typeof parsed?.input?.entryId === "string" && parsed.input.entryId.trim()
          ? parsed.input.entryId.trim()
          : null;
        if (deliveryId) turnInputConsumptionDeliveryIds.add(deliveryId);
        if (entryId) turnInputConsumptionEntryIds.add(entryId);
      }

      const recordMediaGenerationResult = (parsed, afterIndex, sourceIndex = null) => {
        if (!parsed?.taskId) return;
        const type = typeof parsed.type === "string" ? parsed.type : "";
        if (type !== "image-generation" && type !== "video-generation") return;
        mediaGenerationResults.set(parsed.taskId, parsed);
        if (parsed.status === "success") {
          standaloneMediaGenerationResults.push({
            ...parsed,
            afterIndex,
            ...(Number.isInteger(sourceIndex) ? { sourceIndex } : {}),
          });
        }
      };

      const recordTurnInputConsumptionInterlude = (message, afterIndex, sourceIndex = null) => {
        if (!Number.isInteger(afterIndex) || afterIndex < 0) return;
        const parsed = parseTurnInputConsumptionRecord(message?.data);
        const block = parsed?.block;
        if (!block || block.type !== "interlude") return;
        const normalizedDeliveryId = typeof parsed.deliveryId === "string" && parsed.deliveryId.trim()
          ? parsed.deliveryId.trim()
          : null;
        if (normalizedDeliveryId && deferredInterludeDeliveryIds.has(normalizedDeliveryId)) return;
        blocks.push({
          ...block,
          ...(normalizedDeliveryId ? { deliveryId: normalizedDeliveryId } : {}),
          afterIndex,
          ...(Number.isInteger(sourceIndex) ? { sourceIndex } : {}),
        });
        if (normalizedDeliveryId) deferredInterludeDeliveryIds.add(normalizedDeliveryId);
      };

      const recordTurnInputPresentationInterlude = (message, afterIndex, sourceIndex = null) => {
        if (!Number.isInteger(afterIndex) || afterIndex < 0) return;
        const parsed = parseTurnInputPresentationRecord(message?.data);
        const block = parsed?.block;
        if (!block || block.type !== "interlude") return;
        const normalizedDeliveryId = typeof parsed.deliveryId === "string" && parsed.deliveryId.trim()
          ? parsed.deliveryId.trim()
          : null;
        if (normalizedDeliveryId && deferredInterludeDeliveryIds.has(normalizedDeliveryId)) return;
        blocks.push({
          ...block,
          ...(normalizedDeliveryId ? { deliveryId: normalizedDeliveryId } : {}),
          afterIndex,
          ...(Number.isInteger(sourceIndex) ? { sourceIndex } : {}),
        });
        if (normalizedDeliveryId) deferredInterludeDeliveryIds.add(normalizedDeliveryId);
      };

      const recordDeferredInterlude = (parsed, afterIndex, deliveryId = null, sourceIndex = null) => {
        if (!parsed?.taskId || !Number.isInteger(afterIndex) || afterIndex < 0) return;
        const normalizedDeliveryId = typeof deliveryId === "string" && deliveryId.trim() ? deliveryId.trim() : null;
        const sourceMessage = Number.isInteger(sourceIndex) ? sourceMessages[sourceIndex] : null;
        const sourceEntryId = typeof sourceMessage?.id === "string" && sourceMessage.id.trim()
          ? sourceMessage.id.trim()
          : null;
        if (normalizedDeliveryId && turnInputConsumptionDeliveryIds.has(normalizedDeliveryId)) return;
        if (sourceEntryId && turnInputConsumptionEntryIds.has(sourceEntryId)) return;
        if (normalizedDeliveryId && deferredInterludeDeliveryIds.has(normalizedDeliveryId)) return;
        const task = deferredStore?.query?.(parsed.taskId) || null;
        const meta = {
          ...(task?.meta || {}),
          type: parsed.type || task?.meta?.type || "background-task",
        };
        const event = {
          taskId: parsed.taskId,
          deliveryId: normalizedDeliveryId,
          status: parsed.status === "failed" || parsed.status === "aborted" ? parsed.status : "success",
          result: Object.prototype.hasOwnProperty.call(parsed, "result") ? parsed.result : task?.result,
          reason: parsed.reason || task?.reason || null,
          meta,
        };
        const block = buildDeferredResultInterludeBlock(event, { receiverName });
        if (!block) return;
        blocks.push({
          ...block,
          afterIndex,
          ...(Number.isInteger(sourceIndex) ? { sourceIndex } : {}),
        });
        if (normalizedDeliveryId) deferredInterludeDeliveryIds.add(normalizedDeliveryId);
      };

      for (let sourceIndex = 0; sourceIndex < sourceMessages.length; sourceIndex += 1) {
        const m = sourceMessages[sourceIndex];
        if (m.role === "user") {
          const presentation = normalizeLegacyPluginPresentation(m.presentation, engine);
          const extracted = extractTextContent(m.content);
          const text = typeof presentation?.text === 'string' ? presentation.text : extracted.text;
          const images = extracted.images;
          const visibleImages = filterUnreferencedInlineImages(text, images);
          if (text || visibleImages.length || presentation) {
            allMessages.push({
              id: String(globalIdx++),
              sourceIndex,
              ...(m.id ? { entryId: m.id } : {}),
              role: "user",
              ...(presentation ? Object.fromEntries(['attachments', 'skills', 'plugins', 'workspaceTool', 'quotedText', 'deskContext', 'quickAction', 'agentMentions', 'sessionRefs', 'agentReview', 'reviewSourceSessionId']
                .filter(key => presentation[key] !== undefined).map(key => [key, presentation[key]])) : {}),
              content: text,
              images: visibleImages.length ? visibleImages : undefined,
              ...(m.timestamp ? { timestamp: m.timestamp } : {}),
            });
          }
        } else if (m.role === "assistant") {
          const { text, thinking, toolUses } = extractTextContent(m.content, { stripThink: true });
          if (text || toolUses.length) {
            allMessages.push({
              id: String(globalIdx++),
              sourceIndex,
              ...(m.id ? { entryId: m.id } : {}),
              role: "assistant",
              content: text,
              thinking: thinking || undefined,
              toolCalls: toolUses.length ? toolUses : undefined,
              ...(m.timestamp ? { timestamp: m.timestamp } : {}),
            });
          }
        } else if (m.role === "toolResult") {
          const extracted = extractBlocks(m.toolName, m.details, m);
          for (const b of extracted) {
            blocks.push({ ...b, afterIndex: allMessages.length - 1, sourceIndex });
          }
        } else if (m.role === "custom") {
          const afterIndex = allMessages.length - 1;
          if (m.display !== false && afterIndex >= 0) {
            const extracted = extractBlocks(m.customType, m.details, m);
            for (const b of extracted) {
              blocks.push({ ...b, afterIndex, sourceIndex });
            }
          }
          const parsed = parseHistoryDeferredResult(m);
          recordMediaGenerationResult(parsed, afterIndex, sourceIndex);
          if (m.customType === TURN_INPUT_CONSUMPTION_EVENT_TYPE) {
            recordTurnInputConsumptionInterlude(m, afterIndex, sourceIndex);
          }
          if (m.customType === TURN_INPUT_PRESENTATION_EVENT_TYPE) {
            recordTurnInputPresentationInterlude(m, afterIndex, sourceIndex);
          }
          if (m.customType === DEFERRED_RESULT_MESSAGE_TYPE) {
            const nextAssistantIndex = nextImmediateDisplayableAssistantIndex(sourceMessages, sourceIndex, globalIdx);
            recordDeferredInterlude(
              parsed,
              nextAssistantIndex == null ? null : nextAssistantIndex - 1,
              historyDeferredDeliveryId(m, sourceIndex),
              sourceIndex,
            );
          } else if (m.customType === DEFERRED_RESULT_RECORD_TYPE) {
            recordDeferredInterlude(parsed, afterIndex, historyDeferredDeliveryId(m, sourceIndex), sourceIndex);
          }
        }
      }

 // 分页：before 参数指定游标，否则默认返回最-limit -
      let messages;
      let hasMore = false;
      let slicedBlocks = blocks;

      const total = allMessages.length;
 // all=1 强制全量返回（流式恢复等特殊场景-
      const forceAll = c.req.query("all") === "1";
      let pageStart = 0;
      let pageEnd = total;

      if (forceAll) {
        messages = allMessages;
      } else {
        pageEnd = (beforeId != null && beforeId > 0)
          ? Math.min(beforeId, total)
          : total;
        pageStart = Math.max(0, pageEnd - limit);
        messages = allMessages.slice(pageStart, pageEnd);
        hasMore = pageStart > 0;
 // 重映-afterIndex 到切片内偏移，过滤超出范围的
        slicedBlocks = blocks
          .filter(b => b.afterIndex >= pageStart && b.afterIndex < pageEnd)
          .map(b => ({ ...b, afterIndex: b.afterIndex - pageStart }));
      }

      const slicedStandaloneMediaResults = standaloneMediaGenerationResults
        .filter((result) => forceAll || (result.afterIndex >= pageStart && result.afterIndex < pageEnd))
        .map((result) => ({
          ...result,
          afterIndex: forceAll ? result.afterIndex : result.afterIndex - pageStart,
        }));

      if (mediaGenerationResults.size > 0 || slicedStandaloneMediaResults.length > 0) {
        slicedBlocks = resolveMediaGenerationBlocks(
          slicedBlocks,
          mediaGenerationResults,
          slicedStandaloneMediaResults,
        );
      }

 // 修正 subagent blocks 的状态：优先-deferred store 读终态，其次-session 文件推断
      slicedBlocks = normalizePluginChatSurfaceBlocks(slicedBlocks, engine);

      {
        const deferredStore = engine.deferredResults;
        const runStore = engine.subagentRuns;
        const readSessionMeta = createSubagentMetaCache();
        const readSessionSummary = createSubagentSummaryCache();
        for (const b of slicedBlocks) {
          if (b.type !== "subagent" || !b.taskId) continue;
          const task = deferredStore?.query?.(b.taskId) || null;
          const run = runStore?.query?.(b.taskId) || null;
          const runTask = taskFromSubagentRun(run);
          const metadataTask = mergeSubagentTaskMetadata(runTask, task);
          const durableSessionPath = run?.childSessionPath || null;
          const deferredSessionPath = task?.meta?.sessionPath || null;
          if (!b.streamKey && durableSessionPath) b.streamKey = durableSessionPath;
          if (!b.streamKey && deferredSessionPath) b.streamKey = deferredSessionPath;
          patchBlockRequestedMetadata(b, metadataTask);
          patchBlockExecutorMetadata(b, metadataTask, readSessionMeta);
          applySubagentIdentity(b, metadataTask, readSessionMeta);

          if (b.streamStatus !== "running") continue;

          const terminalTask = run && run.status !== "pending" ? runTask : task;
          if (terminalTask?.status === "aborted") {
            b.streamStatus = "aborted";
            b.summary = terminalTask.reason || "aborted";
            if (terminalTask.meta?.sessionPath) b.streamKey = terminalTask.meta.sessionPath;
            patchBlockRequestedMetadata(b, terminalTask);
            patchBlockExecutorMetadata(b, terminalTask, readSessionMeta);
            applySubagentIdentity(b, terminalTask, readSessionMeta);
            continue;
          }
          if (terminalTask?.status === "failed") {
            b.streamStatus = "failed";
            b.summary = terminalTask.reason || "failed";
            if (terminalTask.meta?.sessionPath) b.streamKey = terminalTask.meta.sessionPath;
            patchBlockRequestedMetadata(b, terminalTask);
            patchBlockExecutorMetadata(b, terminalTask, readSessionMeta);
            applySubagentIdentity(b, terminalTask, readSessionMeta);
            continue;
          }
          if (terminalTask?.status === "resolved") {
            b.streamStatus = "done";
            if (terminalTask.meta?.sessionPath) b.streamKey = terminalTask.meta.sessionPath;
            patchBlockRequestedMetadata(b, terminalTask);
            patchBlockExecutorMetadata(b, terminalTask, readSessionMeta);
            applySubagentIdentity(b, terminalTask, readSessionMeta);
            const sp = b.streamKey || terminalTask.meta?.sessionPath || null;
            const summary = await readSessionSummary(sp);
            b.summary = summary || (typeof terminalTask.result === "string" ? terminalTask.result.slice(0, 200) : b.summary);
            continue;
          }

          if (run?.status === "pending" && !task) {
            b.streamStatus = "failed";
            b.summary = "Historical subagent run state is unrecoverable.";
            continue;
          }

          if (!b.streamKey && !run && !task) {
            b.streamStatus = "failed";
            b.summary = "Historical subagent session link is unrecoverable.";
            continue;
          }

          if (task?.status === "pending" || (!task && b.streamKey)) continue;

 // 优先-deferred store 的持久化终态（aborted / failed-
          if (deferredStore) {
            if (task?.status === "aborted") {
              b.streamStatus = "aborted";
              b.summary = task.reason || "aborted";
              if (task.meta?.sessionPath) b.streamKey = task.meta.sessionPath;
              patchBlockRequestedMetadata(b, task);
              patchBlockExecutorMetadata(b, task, readSessionMeta);
              applySubagentIdentity(b, task, readSessionMeta);
              continue;
            }
            if (task?.status === "failed") {
              b.streamStatus = "failed";
              b.summary = task.reason || "failed";
              if (task.meta?.sessionPath) b.streamKey = task.meta.sessionPath;
              patchBlockRequestedMetadata(b, task);
              patchBlockExecutorMetadata(b, task, readSessionMeta);
              applySubagentIdentity(b, task, readSessionMeta);
              continue;
            }
          }

 // -session 文件推断 done 状态（异步读取，只需尾部几行-
          const sp = b.streamKey || null;
          if (!sp) continue;
          const summary = await readSessionSummary(sp);
          if (summary) {
            b.streamStatus = "done";
            b.summary = summary;
          }
        }
      }

 // 从历史中提取最-todo 状态：branch-aware，沿当前 leaf 回溯-root- // 只在当前分支路径上找最新合法快照。避免从抛弃的分支取到错误状态-
      const resolvedSessionPath = queryPath || engine.currentSessionPath || null;
      const todos = await loadLatestTodosFromSessionFile(queryPath);

      patchSessionFileLifecycleBlocks(slicedBlocks, engine, resolvedSessionPath);
      const sessionFiles = listSessionRegistryFiles(engine, resolvedSessionPath);

      if (beforeId == null && resolvedSessionPath) {
        engine.activityHub?.rebroadcastSession?.(resolvedSessionPath);
      }

      return c.json({
        messages,
        blocks: slicedBlocks,
        todos,
        hasMore,
        sessionFiles,
        revision,
        capabilityDrift: engine.getSessionCapabilityDriftNotice?.(resolvedSessionPath) || null,
      });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  route.post("/sessions/todos/complete", async (c) => {
    try {
      const body = await strictJson(c);
      const sessionPath = body?.path || body?.sessionPath;
      if (!sessionPath) {
        return c.json({ error: t("error.missingParam", { param: "path" }) }, 400);
      }
      if (!isValidSessionPath(sessionPath, engine.agentsDir) || !isActiveSessionPath(sessionPath, engine.agentsDir)) {
        return c.json({ error: "Invalid session path" }, 403);
      }
      if (!(await pathExists(sessionPath))) {
        return c.json({ error: t("error.sessionNotFound") }, 404);
      }
      if (engine.isSessionStreaming?.(sessionPath)) {
        return c.json({ error: "Cannot complete todos while session is streaming" }, 409);
      }

      const snapshot = await loadLatestTodoSnapshotFromSessionFile(sessionPath);
      const completedTodos = completeTodoItems(snapshot?.todos || []);
      if (!snapshot?.removed && completedTodos.length > 0) {
        const manager = getWritableSessionManager(engine, sessionPath);
        manager.appendCustomMessageEntry(
          TODO_STATE_CUSTOM_TYPE,
          TODO_COMPLETE_MESSAGE,
          false,
          {
            action: "complete_all",
            source: "user",
            removed: true,
            todos: completedTodos,
          },
        );
      }

      engine.emitEvent?.({ type: "todo_update", todos: [] }, sessionPath);
      return c.json({ ok: true, todos: [] });
    } catch (err) {
      return routeError(c, err);
    }
  });

  route.get("/sessions/authorized-folders", async (c) => {
    try {
      const sessionPath = c.req.query("path") || c.req.query("sessionPath") || null;
      if (!sessionPath) {
        return c.json({ error: t("error.missingParam", { param: "path" }) }, 400);
      }
      if (!isValidSessionPath(sessionPath, engine.agentsDir) || !isActiveSessionPath(sessionPath, engine.agentsDir)) {
        return c.json({ error: "Invalid session path" }, 403);
      }
      if (!(await pathExists(sessionPath))) {
        return c.json({ error: t("error.sessionNotFound") }, 404);
      }
      return c.json(sessionFolderScopeResponse(engine.getSessionFolderScope?.(sessionPath)));
    } catch (err) {
      return routeError(c, err);
    }
  });

  route.patch("/sessions/authorized-folders", async (c) => {
    try {
      const body = await strictJson(c);
      const sessionPath = body?.path || body?.sessionPath || null;
      if (!sessionPath) {
        return c.json({ error: t("error.missingParam", { param: "path" }) }, 400);
      }
      if (!isValidSessionPath(sessionPath, engine.agentsDir) || !isActiveSessionPath(sessionPath, engine.agentsDir)) {
        return c.json({ error: "Invalid session path" }, 403);
      }
      if (!(await pathExists(sessionPath))) {
        return c.json({ error: t("error.sessionNotFound") }, 404);
      }

      const action = typeof body?.action === "string" ? body.action.trim() : "set";
      let scope;
      if (action === "add") {
        const folder = await validateAuthorizedFolder(body?.folder);
        scope = await engine.addSessionAuthorizedFolder?.(sessionPath, folder);
      } else if (action === "remove") {
        const folder = normalizeAuthorizedFolderPath(body?.folder);
        scope = await engine.removeSessionAuthorizedFolder?.(sessionPath, folder);
      } else if (action === "set") {
        const folders = Array.isArray(body?.folders) ? body.folders : [];
        const normalizedFolders = [];
        for (const folder of folders) {
          normalizedFolders.push(await validateAuthorizedFolder(folder));
        }
        scope = await engine.setSessionAuthorizedFolders?.(sessionPath, normalizedFolders);
      } else {
        return c.json({ error: "Invalid action" }, 400);
      }

      return c.json(sessionFolderScopeResponse(scope || engine.getSessionFolderScope?.(sessionPath)));
    } catch (err) {
      const message = err?.message || String(err);
      if (/folder (is required|does not exist|must be a directory)/.test(message)) {
        return c.json({ error: message }, 400);
      }
      return routeError(c, err);
    }
  });

  route.post("/sessions/latest-user-message/replay", async (c) => {
    try {
      const body = await strictJson(c);
      const sessionPath = await resolveSessionPathRef(body);
      if (!sessionPath) {
        return c.json({ error: t("error.missingParam", { param: "path" }) }, 400);
      }
      if (!isValidSessionPath(sessionPath, engine.agentsDir) || !isActiveSessionPath(sessionPath, engine.agentsDir)) {
        return c.json({ error: "Invalid session path" }, 403);
      }
      if (!(await pathExists(sessionPath))) {
        return c.json({ error: t("error.sessionNotFound") }, 404);
      }
      if (engine.isSessionStreaming?.(sessionPath)) {
        return c.json({ error: "session_busy" }, 409);
      }

      const result = await replayLatestUserTurn(engine, {
        sessionPath,
        sourceEntryId: body.sourceEntryId || null,
        clientMessageId: body.clientMessageId || null,
        replacementText: typeof body.text === "string" ? body.text : undefined,
        displayMessage: body.displayMessage || null,
        uiContext: body.uiContext ?? null,
      });
      return c.json({ ok: true, ...result });
    } catch (err) {
      const status = err.message === "session_busy" ? 409 : 400;
      return c.json({ error: err.message }, status);
    }
  });

  async function handleSessionJsonExport(c) {
    try {
      let queryPath = c.req.query("path") || c.req.query("sessionPath") || null;
      const querySessionId = c.req.query("sessionId") || null;
      if (!queryPath && querySessionId) {
        queryPath = await resolveSessionPathRef({ sessionId: querySessionId });
        if (!queryPath) {
          return c.json({ error: t("error.sessionNotFound") }, 404);
        }
      }
      if (!queryPath) {
        return c.json({ error: t("error.missingParam", { param: "sessionId" }) }, 400);
      }
      if (!isValidSessionPath(queryPath, engine.agentsDir)) {
        return c.json({ error: "Invalid session path" }, 403);
      }

      const id = sessionIdFromPath(queryPath);
      const messages = await loadSessionHistoryMessages(engine, queryPath);
      const safeFilename = sanitizeFilename(`${id || "session"}.json`, { fallback: "session.json", replacement: "_" });
      if (c.req.query("download") === "1") {
        c.header("Content-Disposition", `attachment; filename="${safeFilename}"`);
      }
      return c.json({
        id,
        path: queryPath,
        format: "json",
        exportedAt: new Date().toISOString(),
        messages,
      });
    } catch (err) {
      return routeError(c, err);
    }
  }

  route.get("/sessions/export", handleSessionJsonExport);
  route.get("/sessions/export.json", handleSessionJsonExport);

 // 新建 session（可选指定工作目录和 agentId-
  route.post("/sessions/new", async (c) => {
    try {
      const body = await strictJson(c);
      const { memoryEnabled, agentId, currentSessionPath: oldSessionPath, thinkingLevel } = body;
      const workspaceSelection = resolveSessionWorkspaceSelection(engine, body);
      const cwd = workspaceSelection.cwd;
      const workspaceFolders = Array.isArray(body.workspaceFolders)
        ? body.workspaceFolders.filter(p => typeof p === "string" && p.trim())
        : [];
      const projectId = Object.prototype.hasOwnProperty.call(body, "projectId")
        ? (
            typeof engine.normalizeSessionProjectAssignmentId === "function"
              ? engine.normalizeSessionProjectAssignmentId(body.projectId)
              : (typeof body.projectId === "string" && body.projectId.trim() ? body.projectId.trim() : null)
          )
        : null;
      const memFlag = memoryEnabled !== false; // 默认 true
      console.log("[sessions] 新建 session", {
        hasCwd: !!cwd,
        memoryEnabled: memFlag,
        customAgent: !!agentId,
      });

 // 新建前挂起浏览器（保存当-session 的浏览器状态）
      const bm = BrowserManager.instance();
      if (oldSessionPath && bm.isRunning(oldSessionPath)) {
        await bm.suspendForSession(oldSessionPath);
      }

      const createOptions: Record<string, any> = {
        workspaceFolders,
        visibleInSessionList: body.visibleInSessionList === true,
      };
      if (thinkingLevel !== undefined && thinkingLevel !== null) {
        createOptions.thinkingLevel = thinkingLevel;
      }
      if (workspaceSelection.mount) {
        createOptions.workspaceMountId = workspaceSelection.mount.mountId;
        createOptions.workspaceLabel = workspaceSelection.mount.label || null;
      }

      let newSessionPath, newAgentId;
      if (agentId && agentId !== (body.currentAgentId || engine.currentAgentId)) {
        ({ sessionPath: newSessionPath, agentId: newAgentId } = await engine.createSessionForAgent(
          agentId,
          cwd || undefined,
          memFlag,
          undefined,
          createOptions,
        ));
      } else {
        ({ sessionPath: newSessionPath, agentId: newAgentId } = await engine.createSession(
          null,
          cwd || undefined,
          memFlag,
          undefined,
          createOptions,
        ));
      }
      engine.persistSessionMeta();
      if (projectId && typeof engine.setSessionProjectAssignment === "function") {
        await engine.setSessionProjectAssignment({ sessionPath: newSessionPath, projectId });
      }

      // 记住工作目录 + 更新历史
      if (cwd) {
        const history = mergeWorkspaceHistory(engine.config.cwd_history, [cwd]);
        await engine.updateConfig({ last_cwd: cwd, cwd_history: history });
      }

      console.log("[sessions] session 创建完成");
      const response = {
        ok: true,
        id: sessionIdFromPath(newSessionPath),
        path: newSessionPath,
        cwd: engine.cwd,
        workspaceFolders: engine.getSessionWorkspaceFolders?.(newSessionPath) || [],
        ...sessionWorkspaceMountFields(engine, newSessionPath, workspaceSelection.mount),
        agentId: newAgentId,
        agentName: engine.getAgent(newAgentId)?.agentName || engine.agentName,
        projectId,
        planMode: engine.planMode,
        permissionMode: engine.getSessionPermissionMode?.(newSessionPath) || engine.permissionMode,
        accessMode: engine.getSessionPermissionMode?.(newSessionPath) === "read_only" ? "read_only" : "operate",
        thinkingLevel: engine.getSessionThinkingLevel?.(newSessionPath) || engine.getThinkingLevel?.() || "auto",
        memoryModelUnavailableReason: engine.memoryModelUnavailableReason || null,
      };
      hub?.eventBus?.emit?.({
        type: "session_created",
        session: response,
      }, newSessionPath);
      return c.json(response);
    } catch (err) {
      return routeError(c, err);
    }
  });

 // 切换 session（支持跨 agent-
  route.post("/sessions/new-detached", async (c) => {
    try {
      if (typeof engine.createDetachedSession !== "function") {
        return c.json({ error: "detached session creation unavailable" }, 500);
      }

      const body = await strictJson(c);
      const { memoryEnabled, agentId, permissionMode, thinkingLevel } = body;
      const workspaceSelection = resolveSessionWorkspaceSelection(engine, body);
      const cwd = workspaceSelection.cwd;
      const workspaceFolders = Array.isArray(body.workspaceFolders)
        ? body.workspaceFolders.filter(p => typeof p === "string" && p.trim())
        : [];
      const memFlag = memoryEnabled !== false;

      const detachedOptions: Record<string, any> = {
        cwd: cwd || undefined,
        memoryEnabled: memFlag,
        agentId: typeof agentId === "string" && agentId.trim() ? agentId.trim() : null,
        workspaceFolders,
        visibleInSessionList: true,
        permissionMode: permissionMode || null,
      };
      if (thinkingLevel !== undefined && thinkingLevel !== null) {
        detachedOptions.thinkingLevel = thinkingLevel;
      }
      if (workspaceSelection.mount) {
        detachedOptions.workspaceMountId = workspaceSelection.mount.mountId;
        detachedOptions.workspaceLabel = workspaceSelection.mount.label || null;
      }

      const result = await engine.createDetachedSession(detachedOptions);
      const newSessionPath = result.sessionPath;
      const newAgentId = result.agentId;
      engine.persistSessionMeta?.();

      const resolvedPermissionMode = engine.getSessionPermissionMode?.(newSessionPath)
        || permissionMode
        || engine.permissionMode
        || "ask";
      const response = {
        ok: true,
        id: sessionIdFromPath(newSessionPath),
        path: newSessionPath,
        cwd: result.session?.sessionManager?.getCwd?.() || cwd || engine.cwd || null,
        workspaceFolders: engine.getSessionWorkspaceFolders?.(newSessionPath) || workspaceFolders,
        authorizedFolders: engine.getSessionAuthorizedFolders?.(newSessionPath) || [],
        agentId: newAgentId,
        agentName: engine.getAgent?.(newAgentId)?.agentName || newAgentId || engine.agentName,
        currentSessionPath: engine.currentSessionPath || null,
        planMode: resolvedPermissionMode === "read_only",
        permissionMode: resolvedPermissionMode,
        accessMode: resolvedPermissionMode === "read_only" ? "read_only" : "operate",
        thinkingLevel: engine.getSessionThinkingLevel?.(newSessionPath) || engine.getThinkingLevel?.() || "auto",
        memoryModelUnavailableReason: engine.memoryModelUnavailableReason || null,
        ...sessionWorkspaceMountFields(engine, newSessionPath, workspaceSelection.mount),
      };
      hub?.eventBus?.emit?.({
        type: "session_created",
        session: response,
      }, newSessionPath);
      return c.json(response);
    } catch (err) {
      return routeError(c, err);
    }
  });

  route.post("/sessions/continue-deleted-agent", async (c) => {
    try {
      if (typeof engine.continueDeletedAgentSession !== "function") {
        return c.json({ error: "deleted-agent continuation unavailable" }, 500);
      }
      const body = await strictJson(c);
      const sessionPath = await resolveSessionPathRef(body, { preferSessionId: true });
      if (!sessionPath) {
        return c.json({ error: t("error.missingParam", { param: "path" }) }, 400);
      }
      if (!isValidSessionPath(sessionPath, engine.agentsDir) || !isActiveSessionPath(sessionPath, engine.agentsDir)) {
        return c.json({ error: "Invalid session path" }, 403);
      }
      if (!(await pathExists(sessionPath))) {
        return c.json({ error: t("error.sessionNotFound") }, 404);
      }

      const result = await engine.continueDeletedAgentSession(sessionPath);
      const newSessionPath = result.sessionPath;
      const resolvedPermissionMode = engine.getSessionPermissionMode?.(newSessionPath)
        || result.permissionMode
        || engine.permissionMode
        || "ask";
      const response = {
        ok: true,
        id: sessionIdFromPath(newSessionPath),
        path: newSessionPath,
        cwd: result.cwd || engine.cwd || null,
        workspaceFolders: result.workspaceFolders || engine.getSessionWorkspaceFolders?.(newSessionPath) || [],
        authorizedFolders: result.authorizedFolders || engine.getSessionAuthorizedFolders?.(newSessionPath) || [],
        agentId: result.agentId || null,
        agentName: result.agentName || engine.getAgent?.(result.agentId)?.agentName || result.agentId || engine.agentName,
        projectId: null,
        planMode: resolvedPermissionMode === "read_only",
        permissionMode: resolvedPermissionMode,
        accessMode: resolvedPermissionMode === "read_only" ? "read_only" : "operate",
        thinkingLevel: engine.getSessionThinkingLevel?.(newSessionPath) || engine.getThinkingLevel?.() || "auto",
        memoryModelUnavailableReason: engine.memoryModelUnavailableReason || null,
        compacted: result.compacted === true,
        compactionError: result.compactionError || null,
        ...sessionWorkspaceMountFields(engine, newSessionPath),
      };
      hub?.eventBus?.emit?.({
        type: "session_created",
        session: response,
      }, newSessionPath);
      return c.json(response);
    } catch (err) {
      return routeError(c, err);
    }
  });

  route.post("/sessions/switch", async (c) => {
    try {
      const body = await strictJson(c);
      const sessionPath = await resolveSessionPathRef(body, { preferSessionId: true });
      const { currentSessionPath: oldSessionPath } = body;
      if (!sessionPath) {
        return c.json({ error: t("error.missingParam", { param: "path" }) }, 400);
      }
      const stableSessionId = await stableSessionIdForResolvedPath(body, sessionPath);
 // 必须-agents/{id}/sessions/ -sessions/archived/ 下的对话文件- // 拒绝 subagent-sessions/、activity/-ephemeral/ 等旁路目录——那些是
 // 运行态产物，不是用户可切换的对话焦点-
      if (!isActiveSessionPath(sessionPath, engine.agentsDir)) {
        return c.json({ error: "Invalid session path" }, 403);
      }
 // 切换前挂起浏览器（保存当-session 的浏览器状态）
      const bm = BrowserManager.instance();
      const suspendPath = oldSessionPath;
      if (suspendPath && bm.isRunning(suspendPath)) {
        await bm.suspendForSession(suspendPath);
      }

      await engine.switchSession(sessionPath);

      // 恢复目标 session 的浏览器（若有）
      const browserResume = typeof bm.resumeForSessionIfAvailable === "function"
        ? await bm.resumeForSessionIfAvailable(sessionPath)
        : (await bm.resumeForSession(sessionPath), {
            status: "resumed",
            canResume: false,
            reason: "legacy_resume",
            hostConnected: true,
            hasResumeState: true,
            running: bm.isRunning(sessionPath),
            url: bm.currentUrl(sessionPath) || null,
          });

      const session = engine.getSessionByPath(sessionPath);

 // -sessionPath 解析 agentId，避免依-engine 焦点指针的时-
      const switchedAgentId = engine.agentIdFromSessionPath(sessionPath) || engine.currentAgentId;
      const switchedAgent = engine.getAgent(switchedAgentId);

 // switchSession 已同步设置焦点到目标 session- // cwd/planMode/model -session 级状态，此时读焦点是安全的- // memoryEnabled 需要返-session 自身冻结下来的值，而不是当- // master && session 的临时组合态；否则现有 session 的缓存前缀身份
 // 会被全局 gate 混淆- // agentId/agentName 已从 sessionPath 解析，不依赖焦点-
      const activeModel = engine.activeSessionModel ?? engine.currentModel;
      const frozenSessionMemoryEnabled =
        switchedAgent?.isSessionMemoryEnabledFor?.(sessionPath) ?? engine.memoryEnabled;
      return c.json({
        ok: true,
        path: sessionPath,
        sessionId: stableSessionId,
        messageCount: session?.messages?.length || 0,
        memoryEnabled: frozenSessionMemoryEnabled,
        planMode: engine.planMode,
        permissionMode: engine.getSessionPermissionMode?.(sessionPath) || engine.permissionMode,
        accessMode: engine.getSessionPermissionMode?.(sessionPath) === "read_only" ? "read_only" : "operate",
        thinkingLevel: engine.getSessionThinkingLevel?.(sessionPath) || engine.getThinkingLevel?.() || "auto",
        memoryModelUnavailableReason: engine.memoryModelUnavailableReason || null,
        cwd: engine.cwd,
        workspaceFolders: engine.getSessionWorkspaceFolders?.(sessionPath) || [],
        ...sessionWorkspaceMountFields(engine, sessionPath),
        agentId: switchedAgentId,
        agentName: switchedAgent?.agentName || switchedAgentId,
        browserRunning: bm.isRunning(sessionPath),
        browserUrl: bm.currentUrl(sessionPath) || null,
        browserResume,
        isStreaming: engine.isSessionStreaming(sessionPath),
        currentModelId: activeModel?.id || null,
        currentModelProvider: activeModel?.provider || null,
        currentModelName: activeModel?.name || null,
        currentModelInput: Array.isArray(activeModel?.input) ? activeModel.input : null,
        currentModelReasoning: activeModel?.reasoning ?? null,
        currentModelXhigh: modelSupportsXhigh(activeModel),
        currentModelThinkingLevels: activeModel ? getModelThinkingLevels(activeModel) : null,
        currentModelDefaultThinkingLevel: activeModel ? resolveModelDefaultThinkingLevel(activeModel) : null,
        currentModelVideo: modelSupportsVideoInput(activeModel),
        currentModelVideoTransport: resolveModelVideoInputTransport(activeModel),
        currentModelVideoTransportSupported: modelSupportsDirectVideoInput(activeModel),
        currentModelAudio: modelSupportsAudioInput(activeModel),
        currentModelAudioTransport: resolveModelAudioInputTransport(activeModel),
        currentModelAudioTransportSupported: modelSupportsDirectAudioInput(activeModel),
        currentModelContextWindow: activeModel?.contextWindow ?? null,
        capabilityDrift: engine.getSessionCapabilityDriftNotice?.(sessionPath) || null,
      });
    } catch (err) {
      const errDetail = `${err.message}\n${err.stack || ""}`;
      console.error("[sessions/switch] error:", errDetail);
      try {
        if (engine.codiaHome) {
          await fs.appendFile(
            path.join(engine.codiaHome, "switch-error.log"),
            `${new Date().toISOString()}\n${errDetail}\n---\n`,
          );
        }
      } catch {}
      return routeError(c, err);
    }
  });

  // 获取所有有浏览器的 session
  route.post("/sessions/capability-drift/dismiss", async (c) => {
    try {
      const body = await strictJson(c);
      const sessionPath = await resolveSessionPathRef(body);
      const fingerprint = typeof body?.fingerprint === "string" ? body.fingerprint : "";
      if (!sessionPath) {
        return c.json({ error: t("error.missingParam", { param: "path" }) }, 400);
      }
      if (!isActiveSessionPath(sessionPath, engine.agentsDir)) {
        return c.json({ error: "Invalid session path" }, 403);
      }
      await engine.dismissSessionCapabilityDrift(sessionPath, fingerprint);
      return c.json({ ok: true });
    } catch (err) {
      return routeError(c, err);
    }
  });

  route.post("/sessions/fresh-compact", async (c) => {
    try {
      const body = await strictJson(c);
      const sessionPath = await resolveSessionPathRef(body);
      if (!sessionPath) {
        return c.json({ error: t("error.missingParam", { param: "path" }) }, 400);
      }
      if (!isActiveSessionPath(sessionPath, engine.agentsDir)) {
        return c.json({ error: "Invalid session path" }, 403);
      }
      if (typeof engine.freshCompactDesktopSession !== "function") {
        return c.json({ error: "fresh compact unavailable" }, 500);
      }
      const result = await engine.freshCompactDesktopSession(sessionPath);
      return c.json({
        ok: true,
        ...result,
        capabilityDrift: engine.getSessionCapabilityDriftNotice?.(sessionPath) || null,
      });
    } catch (err) {
      if (isFreshCompactBusyError(err)) {
        return routeError(c, err, 409);
      }
      return routeError(c, err);
    }
  });

  route.get("/browser/sessions", async (c) => {
    const bm = BrowserManager.instance();
    return c.json(bm.getBrowserSessions());
  });

  route.get("/browser/session-states", async (c) => {
    const bm = BrowserManager.instance();
    if (typeof bm.getBrowserSessionStates === "function") {
      return c.json(bm.getBrowserSessionStates());
    }
    const sessions = bm.getBrowserSessions();
    const states = Object.fromEntries(Object.entries(sessions).map(([sessionPath, url]) => [
      sessionPath,
      {
        url: typeof url === "string" ? url : null,
        running: typeof bm.isRunning === "function" ? bm.isRunning(sessionPath) : false,
        resumable: true,
        unavailableReason: null,
      },
    ]));
    return c.json(states);
  });

  // 关闭指定 session 的浏览器
  route.post("/browser/close-session", async (c) => {
    try {
      const body = await strictJson(c);
      const sessionPath = await resolveSessionPathRef(body);
      if (!sessionPath) return c.json({ error: "missing sessionPath" });
      const bm = BrowserManager.instance();
      await bm.closeBrowserForSession(sessionPath);
      return c.json({ ok: true });
    } catch (err) {
      return routeError(c, err);
    }
  });

 // 重命-session
  route.post("/sessions/rename", async (c) => {
    try {
      const body = await strictJson(c);
      const sessionPath = await resolveSessionPathRef(body);
      const { title } = body;
      if (!sessionPath) {
        return c.json({ error: t("error.missingParam", { param: "path" }) }, 400);
      }
      if (typeof title !== "string" || !title.trim()) {
        return c.json({ error: t("error.missingParam", { param: "title" }) }, 400);
      }
      if (!isValidSessionPath(sessionPath, engine.agentsDir)) {
        return c.json({ error: "Invalid session path" }, 403);
      }
      await engine.saveSessionTitle(sessionPath, title.trim());
      return c.json({ ok: true });
    } catch (err) {
      return routeError(c, err);
    }
  });

  // 清理过期归档 session
  route.post("/sessions/cleanup", async (c) => {
    try {
      const body = await strictJson(c);
      const { maxAgeDays = 90 } = body;
      const cutoff = Date.now() - maxAgeDays * 86400000;
      let deleted = 0;

 // 遍历所-agent -sessions/archived/ 目录
      const agentsDir = engine.agentsDir;
      const agents = await fs.readdir(agentsDir).catch(() => []);
      for (const agentId of agents) {
        const archiveDir = path.join(agentsDir, agentId, "sessions", "archived");
        let files;
        try { files = await fs.readdir(archiveDir); } catch { continue; }
        for (const f of files) {
          if (!f.endsWith(".jsonl")) continue;
          const fp = path.join(archiveDir, f);
          try {
            const stat = await fs.stat(fp);
            if (stat.mtime.getTime() < cutoff) {
              await fs.unlink(fp);
              deleteSessionFileSidecarSync(fp);
              deleted++;
              // 清理 titles.json 孤儿（key = 对应的活跃路径）
              const activeKey = activePathForArchivedSession(fp);
              await cleanupSessionLifecycle([activeKey, fp], "parent session deleted");
              try { await engine.clearSessionTitle(activeKey); } catch {}
            }
          } catch {}
        }
      }

      return c.json({ ok: true, deleted, maxAgeDays });
    } catch (err) {
      return routeError(c, err);
    }
  });

 // 列出所有已归档 session（聚合各 agent -archived/ 目录-
  route.get("/sessions/archived", async (c) => {
    try {
      const list = await engine.listArchivedSessions();
      return c.json(list.map(s => ({
        ...s,
        id: sessionIdFromPath(s.path),
      })));
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

 // 归档 session（支持跨 agent-
  route.post("/sessions/archive", async (c) => {
    try {
      const body = await strictJson(c);
      const sessionPath = await resolveSessionPathRef(body);
      if (!sessionPath) {
        return c.json({ error: t("error.missingParam", { param: "path" }) }, 400);
      }
 // 校验路径-agentsDir 范围-
      if (!isValidSessionPath(sessionPath, engine.agentsDir) || !isActiveSessionPath(sessionPath, engine.agentsDir)) {
        return c.json({ error: "Invalid session path" }, 403);
      }

 // -session 路径推导归档目录（同 agent -sessions/archived/-
      const destPath = archivedPathForActiveSession(sessionPath);
      return await withSessionLifecycleLock([sessionPath, destPath], async () => {
        // 确认文件存在
        try {
          await fs.access(sessionPath);
        } catch {
          return c.json({ error: t("error.sessionNotFound") }, 404);
        }

        const archiveDir = path.dirname(destPath);
        if (await pathExists(destPath)) {
          return c.json({ error: "Archived path already exists" }, 409);
        }
        if (await pathExists(sessionFileSidecarPath(destPath))) {
          return c.json({ error: "Stage file sidecar destination already exists" }, 409);
        }

        await cleanupSessionLifecycle([sessionPath, destPath], "parent session archived", { skipMemory: true });
        await engine.setSessionPinned(sessionPath, false);
        await engine.closeSession(sessionPath);
        await fs.mkdir(archiveDir, { recursive: true });
        const manifestMoved = await moveSessionLifecycleOrThrow({
          fromPath: sessionPath,
          toPath: destPath,
          lifecycle: "archived",
          reason: "session_archive",
        }, { optional: true });
        try {
          await fs.rename(sessionPath, destPath);
          moveSessionFileSidecarSync(sessionPath, destPath);
        } catch (err) {
          if (manifestMoved) {
            try {
              await moveSessionLifecycleOrThrow({
                fromPath: destPath,
                toPath: sessionPath,
                lifecycle: "active",
                reason: "session_archive_rollback",
              });
            } catch (rollbackErr) {
              log.error?.(`archive manifest rollback failed for ${sessionPath}: ${rollbackErr.message}`);
            }
          }
          throw err;
        }

        // -mtime 置为归档瞬间，使 cleanup -归档时间"而非"最后活动时-判断
        const nowSec = Date.now() / 1000;
        await fs.utimes(destPath, nowSec, nowSec);

        return c.json({ ok: true });
      });
    } catch (err) {
      return routeError(c, err);
    }
  });

 // 恢复归档 session -移回 sessions/
  route.post("/sessions/delete", async (c) => {
    try {
      const body = await strictJson(c);
      const sessionPath = await resolveSessionPathRef(body, { preferSessionId: true });
      if (!sessionPath) {
        return c.json({ error: t("error.missingParam", { param: "path" }) }, 400);
      }
      if (!isActiveSessionPath(sessionPath, engine.agentsDir)) {
        return c.json({ error: "Invalid session path" }, 403);
      }
      try {
        await fs.access(sessionPath);
      } catch {
        return c.json({ error: t("error.sessionNotFound") }, 404);
      }

      await engine.closeSession?.(sessionPath);
      await cleanupSessionLifecycle([sessionPath], "parent session deleted");
      try { await engine.setSessionPinned?.(sessionPath, false); } catch {}

      await fs.unlink(sessionPath);
      deleteSessionFileSidecarSync(sessionPath);
      try { await engine.clearSessionTitle?.(sessionPath); } catch {}

      return c.json({ ok: true });
    } catch (err) {
      return routeError(c, err);
    }
  });

  route.post("/sessions/restore", async (c) => {
    try {
      const body = await strictJson(c);
      const sessionPath = await resolveSessionPathRef(body, { archived: true });
      if (!sessionPath) {
        return c.json({ error: t("error.missingParam", { param: "path" }) }, 400);
      }
      if (!isArchivedDesktopSessionPath(sessionPath, engine.agentsDir)) {
        return c.json({ error: "Invalid session path" }, 403);
      }
 // 必须位于 /archived/ 目录下，防止把活-session 当归档路径调-
      const archDir = path.dirname(sessionPath);
      if (path.basename(archDir) !== "archived") {
        return c.json({ error: "Not an archived session path" }, 403);
      }
      try {
        await fs.access(sessionPath);
      } catch {
        return c.json({ error: t("error.sessionNotFound") }, 404);
      }

      const activeDir = path.dirname(archDir);
      const destPath = path.join(activeDir, path.basename(sessionPath));

      return await withSessionLifecycleLock([destPath, sessionPath], async () => {
        try {
          await fs.access(sessionPath);
        } catch {
          return c.json({ error: t("error.sessionNotFound") }, 404);
        }

        await cleanupSessionLifecycle([destPath, sessionPath], "parent session restored", { skipMemory: true });
        await repairHeaderOnlyActiveRestoreTarget(destPath);
        if (await pathExists(sessionFileSidecarPath(destPath))) {
          return c.json({ error: "Stage file sidecar destination already exists" }, 409);
        }

        await fs.rename(sessionPath, destPath);
        moveSessionFileSidecarSync(sessionPath, destPath);
        try {
          await moveSessionLifecycleOrThrow({
            fromPath: sessionPath,
            toPath: destPath,
            lifecycle: "active",
            reason: "session_restore",
          });
        } catch (err) {
          try {
            await fs.mkdir(archDir, { recursive: true });
            await fs.rename(destPath, sessionPath);
            moveSessionFileSidecarSync(destPath, sessionPath);
          } catch (rollbackErr) {
            log.error?.(`restore file rollback failed for ${destPath}: ${rollbackErr.message}`);
          }
          throw err;
        }
        return c.json({ ok: true, id: sessionIdFromPath(destPath), restoredPath: destPath });
      });
    } catch (err) {
      return routeError(c, err);
    }
  });

 // 永久删除一条归-session
  route.post("/sessions/archived/delete", async (c) => {
    try {
      const body = await strictJson(c);
      const sessionPath = await resolveSessionPathRef(body, { archived: true });
      if (!sessionPath) {
        return c.json({ error: t("error.missingParam", { param: "path" }) }, 400);
      }
      if (!isValidSessionPath(sessionPath, engine.agentsDir)) {
        return c.json({ error: "Invalid session path" }, 403);
      }
      const archDir = path.dirname(sessionPath);
      if (path.basename(archDir) !== "archived") {
        return c.json({ error: "Not an archived session path" }, 403);
      }
      try {
        await fs.unlink(sessionPath);
        deleteSessionFileSidecarSync(sessionPath);
      } catch (err) {
        if (err.code === "ENOENT") {
          return c.json({ error: t("error.sessionNotFound") }, 404);
        }
        throw err;
      }
      // 清理 titles.json 孤儿（key = 对应的活跃路径）
      const activeKey = activePathForArchivedSession(sessionPath);
      await cleanupSessionLifecycle([activeKey, sessionPath], "parent session deleted");
      try { await engine.clearSessionTitle(activeKey); } catch {}
      return c.json({ ok: true });
    } catch (err) {
      return routeError(c, err);
    }
  });

  return route;
}

function listSessionRegistryFiles(engine, sessionPath) {
  if (!sessionPath || typeof engine?.listSessionFiles !== "function") return [];
  return engine.listSessionFiles(sessionPath)
    .map(file => {
      if (typeof engine.serializeSessionFile === "function") return engine.serializeSessionFile(file);
      return serializeSessionFile(file, { runtimeContext: safeRuntimeContext(engine) });
    })
    .filter(Boolean);
}

function safeRuntimeContext(engine) {
  try {
    if (typeof engine?.getRuntimeContext === "function") return engine.getRuntimeContext();
  } catch {}
  return engine?.runtimeContext || null;
}

function patchSessionFileLifecycleBlocks(blocks, engine, sessionPath) {
  if (!sessionPath) return;
  for (const block of blocks || []) {
    if (!block) continue;
    if (!["file", "artifact", "skill", "screenshot"].includes(block.type)) continue;
    let file = null;
    if (block.fileId && typeof engine?.getSessionFile === "function") {
      file = engine.getSessionFile(block.fileId, { sessionPath });
    }
    if (!file && block.filePath && typeof engine?.getSessionFileByPath === "function") {
      file = engine.getSessionFileByPath(block.filePath, { sessionPath });
    }
    if (!file && block.type === "screenshot" && block.base64 && engine?.codiaHome && typeof engine?.getSessionFileByPath === "function") {
      try {
        const filePath = browserScreenshotPath(engine.codiaHome, sessionPath, {
          base64: block.base64,
          mimeType: block.mimeType,
        });
        file = engine.getSessionFileByPath(filePath, { sessionPath });
        if (file) block.type = "file";
      } catch {}
    }
    if (!file) continue;
    const patch = sessionFileLifecycleFields(file);
    Object.assign(block, patch);
    if (block.type === "skill" && block.installedFile) {
      block.installedFile = { ...block.installedFile, ...patch };
    }
  }
}

function sessionFileLifecycleFields(file) {
  const fileId = file.fileId || file.id || null;
  return {
    ...(fileId ? { fileId } : {}),
    ...(file.filePath ? { filePath: file.filePath } : {}),
    ...(file.label || file.displayName ? { label: file.label || file.displayName } : {}),
    ...(file.ext !== undefined ? { ext: file.ext } : {}),
    ...(file.mime ? { mime: file.mime } : {}),
    ...(file.kind ? { kind: file.kind } : {}),
    ...(file.storageKind ? { storageKind: file.storageKind } : {}),
    ...(file.status ? { status: file.status } : {}),
    ...(file.missingAt !== undefined ? { missingAt: file.missingAt } : {}),
  };
}
