/**
 * WebSocket 聊天路由
 *
  *
 * 支持-session 并发：所-session 事件平等广播，前端按 sessionPath 路由
 */
import { Hono } from "hono";
import { redactLogText } from "../../lib/log-redactor.ts";
import { randomUUID } from "node:crypto";
import { MoodParser, ThinkTagParser, CardParser } from "../../core/events.ts";
import { extractBlocks, resolveMediaGenerationBlocks } from "../block-extractors.ts";
import { buildAutomationSuggestionBlock } from "../suggestion-blocks.ts";
import {
  createSessionStreamEventWsMessage,
  createStreamResumeWsMessage,
  validateClientWsMessage,
  wsSend,
  wsParse,
  wsSendSerialized,
} from "../ws-protocol.ts";
import { debugLog } from "../../lib/debug-log.ts";
import { t } from "../../lib/i18n.ts";
import { getLastAssistantUsage } from "../../lib/pi-sdk/index.ts";
import { logLlmUsage } from "../../lib/llm/usage-observer.ts";
import { BrowserManager } from "../../lib/browser/browser-manager.ts";
import { toAppEventWsMessage } from "../app-events.ts";
import { toResourceEventWsMessage } from "../resource-events-ws.ts";
import {
  createSessionStreamState,
  beginSessionStream,
  finishSessionStream,
  appendSessionStreamEvent,
  resumeSessionStream,
} from "../session-stream-store.ts";
import { AppError } from "../../shared/errors.ts";
import { errorBus } from "../../shared/error-bus.ts";
import { createRequestContext } from "../http/boundary.ts";
import { buildModelErrorDiagnostic } from "../model-error-diagnostics.ts";
import { buildDeferredResultInterludeBlock, resolveDeferredReceiverName } from "../deferred-result-interlude.ts";
import { DEFERRED_RESULT_MESSAGE_TYPE } from "../../lib/deferred-result-notification.ts";
import {
  TURN_INPUT_CONSUMPTION_EVENT_TYPE,
  TURN_INPUT_PRESENTATION_EVENT_TYPE,
  buildTurnInputConsumptionRecord,
  buildTurnInputPresentationEvent,
} from "../../lib/turn-input-presentation.ts";
import { isAllowedChatImageMime, isChatImageBase64WithinLimit } from "../../shared/image-mime.ts";
import { isAllowedChatVideoMime, isChatVideoBase64WithinLimit } from "../../shared/video-mime.ts";
import path from "path";
import {
  createWsClientRecord,
  subscribeWsClientToSession,
  wsClientCanReceiveEvent,
  wsClientCanSendMessage,
} from "../ws-scope.ts";

/** tool_start 事件只广播这-arg 字段，避免传输完整文件内容（同步维护：chat-render-shim.ts extractToolDetail-*/
const TOOL_ARG_SUMMARY_KEYS = ["file_path", "path", "command", "pattern", "url", "query", "key", "value", "action", "type", "schedule", "prompt", "label"];
const MAX_QUEUED_PROMPTS_PER_SESSION = 20;

export function summarizeToolStartArgs(toolName: any, rawArgs: any, startedAt = Date.now()) {
  if (!rawArgs || typeof rawArgs !== "object") return undefined;
  const args = {};
  for (const k of TOOL_ARG_SUMMARY_KEYS) {
    if (rawArgs[k] !== undefined) args[k] = rawArgs[k];
  }
  return Object.keys(args).length ? args : undefined;
}

function cleanSkillNames(skills) {
  if (!Array.isArray(skills) || skills.length === 0) return [];
  return [...new Set(skills
    .filter((skill) => typeof skill === "string")
    .map((skill) => skill.trim())
    .filter(Boolean))];
}

function skillMarkdownPath(skill) {
  if (!skill || typeof skill !== "object") return "";
  if (typeof skill.filePath === "string" && skill.filePath) return skill.filePath;
  if (typeof skill.baseDir === "string" && skill.baseDir) return path.join(skill.baseDir, "SKILL.md");
  return "";
}

export function resolveSelectedSkillRecords(engine, skills, sessionPath) {
  const clean = cleanSkillNames(skills);
  if (clean.length === 0 || !engine) return [];

  const agentId = engine.agentIdFromSessionPath?.(sessionPath) || engine.currentAgentId || null;
  let runtimeSkills = [];
  if (agentId) {
    try {
      runtimeSkills = engine.getRuntimeSkills?.(agentId) || [];
    } catch {
      try {
        runtimeSkills = engine.getAllSkills?.(agentId) || [];
      } catch {
        runtimeSkills = [];
      }
    }
  }

  const byName = new Map();
  for (const skill of runtimeSkills) {
    if (typeof skill?.name !== "string" || !skill.name) continue;
    byName.set(skill.name, skill);
    byName.set(skill.name.toLowerCase(), skill);
  }

  return clean.map((name) => {
    const matched = byName.get(name) || byName.get(name.toLowerCase()) || null;
    return {
      name,
      description: typeof matched?.description === "string" ? matched.description : "",
      filePath: skillMarkdownPath(matched),
      source: typeof matched?.source === "string" ? matched.source : "",
      enabled: matched?.enabled !== false,
    };
  });
}

export function buildSkillInvocationNote(skills, records = null) {
  const clean = cleanSkillNames(skills);
  if (clean.length === 0) return "";

  const resolvedRecords = Array.isArray(records) && records.length > 0
    ? records
    : clean.map((name) => ({ name, description: "", filePath: "", source: "", enabled: true }));
  const availableLines = resolvedRecords.map((skill) => [
    `- name: ${skill.name}`,
    `  skill_md_path: ${skill.filePath || "(unavailable)"}`,
    skill.description ? `  description: ${skill.description}` : null,
    skill.source ? `  source: ${skill.source}` : null,
  ].filter(Boolean).join("\n"));
  const selectedLines = resolvedRecords.map((skill) => {
    if (skill.filePath) return `- ${skill.name}: read ${skill.filePath}`;
    return `- ${skill.name}: unavailable; do not infer its rules from the name`;
  });
  return [
    "<available_skills>",
    ...availableLines,
    "</available_skills>",
    "<selected-skills>",
    "Use the following selected skill(s) for this request:",
    ...selectedLines,
    "Before applying each selected skill with a skill_md_path, read that exact SKILL.md path with the read tool and follow its workflow.",
    "If a selected skill has no skill_md_path, state that the skill is unavailable instead of guessing from its name.",
    "After using the selected skill(s), return a final visible answer to the user.",
    "Do not finish with only thinking, reasoning_content, or a <think> block.",
    "</selected-skills>",
  ].join("\n");
}

/**
  * */
function extractText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(b => b.type === "text" && b.text)
    .map(b => b.text)
    .join("");
}

function mediaKindFromDeferredEvent(event) {
  const metaType = event?.meta?.type || "";
  return event?.meta?.mediaKind
    || (metaType === "video-generation" ? "video" : null)
    || (metaType === "image-generation" ? "image" : null)
    || (metaType === "audio-generation" ? "audio" : null);
}

function deferredResultMediaBlocks(event) {
  if (!event?.taskId) return [];
  const mediaKind = mediaKindFromDeferredEvent(event);
  if (!mediaKind) return [];
  const status = event.status === "failed" || event.status === "aborted" ? event.status : "success";
  return resolveMediaGenerationBlocks([], new Map(), [{
    taskId: event.taskId,
    type: event?.meta?.type || `${mediaKind}-generation`,
    status,
    result: event.result,
    reason: event.reason || null,
  }]);
}

function sessionIdFromPath(sessionPath) {
  return path.basename(sessionPath || "").replace(/\.(jsonl|json)$/i, "");
}

function resolveSessionNotificationIdentity(engine, sessionPath) {
  const session = engine.getSessionByPath?.(sessionPath) || null;
  const sessionAgent = session?.agent || null;
  const sessionAgentId = typeof session?.agentId === "string" && session.agentId
    ? session.agentId
    : typeof sessionAgent?.id === "string" && sessionAgent.id
      ? sessionAgent.id
      : null;
  const agentId = sessionAgentId || engine.agentIdFromSessionPath?.(sessionPath) || engine.currentAgentId || null;
  const agent = sessionAgent || (agentId ? engine.getAgent?.(agentId) : null);
  const agentName = typeof session?.agentName === "string" && session.agentName.trim()
    ? session.agentName.trim()
    : typeof agent?.agentName === "string" && agent.agentName.trim()
      ? agent.agentName.trim()
      : typeof agent?.name === "string" && agent.name.trim()
        ? agent.name.trim()
        : "助手";
  return { agentId, agentName };
}

export function toNotificationWsMessage(event: any, sessionPath: any = null) {
  const desktopFocusPolicy = event.desktopFocusPolicy === "when_session_unfocused"
    ? "when_session_unfocused"
    : event.desktopFocusPolicy === "when_unfocused"
      ? "when_unfocused"
      : "always";
  return {
    type: "notification",
    title: event.title,
    body: event.body,
    agentId: event.agentId ?? null,
    desktopFocusPolicy,
    sessionPath: event.sessionPath ?? sessionPath ?? null,
  };
}

function maybeDeliverTurnCompletionNotification(engine: any, sessionPath: any, { wasAborted, wasSuccessful, streamId }: any = {}) {
  if (!sessionPath || wasAborted || !wasSuccessful) return;
  try {
    const prefs = engine.getNotificationPreferences?.();
    if (prefs?.turnCompletion !== "when_unfocused" && prefs?.turnCompletion !== "when_session_unfocused") return;
    if (typeof engine.deliverNotification !== "function") return;

    const { agentId, agentName } = resolveSessionNotificationIdentity(engine, sessionPath);
    const idempotencyKey = streamId ? `turn-completion:${sessionPath}:${streamId}` : null;
    const body = t("notification.turnCompletionBody") === "notification.turnCompletionBody"
      ? "This turn is complete"
      : t("notification.turnCompletionBody");
    const delivery = engine.deliverNotification({
      title: agentName,
      body,
      channels: ["desktop"],
      desktopFocusPolicy: prefs.turnCompletion === "when_session_unfocused"
        ? "when_session_unfocused"
        : "when_unfocused",
      sessionPath,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    }, { agentId });
    delivery?.catch?.((err) => {
      debugLog()?.warn?.("ws", `turn completion notification failed: ${err.message}`);
    });
  } catch (err) {
    debugLog()?.warn?.("ws", `turn completion notification skipped: ${err.message}`);
  }
}

export function toAgentActivityWsMessage(event, sessionPath) {
  if (!event || event.type !== "agent_activity") return null;
  return {
    type: "agent_activity",
    entry: event.entry,
    sessionPath: sessionPath ?? event.entry?.sessionPath ?? null,
  };
}

export function toCompactionLifecycleWsMessage(event: any, sessionPath: any, getSessionByPath: any) {
  if (!sessionPath) return null;
  if (event?.type === "compaction_start" || event?.type === "auto_compaction_start") {
    return {
      type: "compaction_start",
      sessionPath,
      reason: event.reason ?? null,
    };
  }
  if (event?.type !== "compaction_end" && event?.type !== "auto_compaction_end") return null;

  const usage = getSessionByPath?.(sessionPath)?.getContextUsage?.();
  return {
    type: "compaction_end",
    sessionPath,
    reason: event.reason ?? null,
    aborted: event.aborted ?? false,
    willRetry: event.willRetry ?? false,
    tokens: usage?.tokens ?? null,
    contextWindow: usage?.contextWindow ?? null,
    percent: usage?.percent ?? null,
  };
}

export const DEFAULT_DISCONNECT_ABORT_GRACE_MS = 5 * 60_000;
export const DEFAULT_TURN_STALL_ABORT_MS = 20 * 60_000;

export function resolveDisconnectAbortGraceMs(
  value = process.env.CODIA_WS_DISCONNECT_ABORT_GRACE_MS,
) {
  if (value === undefined || value === null || value === "") return DEFAULT_DISCONNECT_ABORT_GRACE_MS;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_DISCONNECT_ABORT_GRACE_MS;
  return Math.floor(parsed);
}

export function resolveTurnStallAbortMs(
  value = process.env.CODIA_TURN_STALL_ABORT_MS,
) {
  if (value === undefined || value === null || value === "") return DEFAULT_TURN_STALL_ABORT_MS;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_TURN_STALL_ABORT_MS;
  return Math.floor(parsed);
}

export function createChatRoute(engine, hub, { upgradeWebSocket, runtimeDiagnostics = null }) {
  const restRoute = new Hono<any>();
  const wsRoute = new Hono<any>();

  let activeWsClients = 0;
  let disconnectAbortTimer = null;
  const disconnectAbortGraceMs = resolveDisconnectAbortGraceMs();
  const turnStallAbortMs = resolveTurnStallAbortMs();
  const sessionState = new Map(); // sessionPath -> shared stream state

  function cancelDisconnectAbort() {
    if (disconnectAbortTimer) {
      clearTimeout(disconnectAbortTimer);
      disconnectAbortTimer = null;
    }
  }

  function scheduleDisconnectAbort() {
    if (activeWsClients > 0) return;
    debugLog()?.log("ws", "no clients; streaming sessions continue for resume");
    if (disconnectAbortTimer || disconnectAbortGraceMs === 0) return;

    disconnectAbortTimer = setTimeout(() => {
      disconnectAbortTimer = null;
      if (activeWsClients > 0) return;
      for (const [, ss] of sessionState) ss.isAborted = true;
      debugLog()?.log("ws", `no clients for ${disconnectAbortGraceMs}ms, aborting all streaming`);
      engine.abortAllStreaming?.().catch?.(() => {});
    }, disconnectAbortGraceMs);
    disconnectAbortTimer.unref?.();
  }

  const MAX_SESSION_STATES = 100;

  async function requireSessionPath(msg, ws) {
    if (msg.sessionPath || msg.path) return msg.sessionPath || msg.path;
    const sessionId = typeof msg.sessionId === "string" ? msg.sessionId.trim() : "";
    if (sessionId) {
      const sessions = typeof engine.listSessions === "function" ? await engine.listSessions() : [];
      const match = sessions.find(s => sessionIdFromPath(s.path) === sessionId);
      if (match?.path) return match.path;
      wsSend(ws, { type: "error", message: "session not found", sessionId });
      return null;
    }
    wsSend(ws, { type: "error", message: "sessionPath or sessionId is required" });
    return null;
  }

  function getState(sessionPath) {
    if (!sessionPath) return null;
    if (!sessionState.has(sessionPath)) {
 // 超过上限时，循环淘汰非流式的最久未访问 entry
      while (sessionState.size >= MAX_SESSION_STATES) {
        let oldest = null;
        let oldestTime = Infinity;
        for (const [sp, ss] of sessionState) {
          if (!ss.isStreaming && sp !== sessionPath && ss.lastAccessed < oldestTime) {
            oldest = sp;
            oldestTime = ss.lastAccessed;
          }
        }
        if (oldest) sessionState.delete(oldest);
        else break; // All entries are streaming; nothing can be evicted.
      }
      sessionState.set(sessionPath, {
        thinkTagParser: new ThinkTagParser(),
        moodParser: new MoodParser(),
        cardParser: new CardParser(),
        _cardHints: [],
        _cardEmitted: false,
        pendingDeferredContentEvents: [],
        pendingTurnInputConsumptions: [],
        flushedTurnInputConsumptionKeys: new Set(),
        pendingPromptQueue: [],
        drainingPromptQueue: false,
        pendingTurnCompletionNotification: null,
        turnStallTimer: null,
        lastStreamActivityAt: 0,
        isThinking: false,
        hasOutput: false,
        hasToolCall: false,
        hasThinking: false,
        thinkingFallback: "",
        hasError: false,
        isAborted: false,
        turnEnded: false,
        pendingTurnEnd: false,
        titleRequested: false,
        titlePreview: "",
        lastAccessed: Date.now(),
        ...createSessionStreamState(),
      });
    }
    const ss = sessionState.get(sessionPath);
    ss.lastAccessed = Date.now();
    return ss;
  }

  const clients = new Map();

  function createInitialWsClientRecord(requestContext, { assumeLocalOwner = false } = {}) {
    return createWsClientRecord({
      principal: assumeLocalOwner
        ? {
            kind: "local_user",
            userId: requestContext.userId,
            studioId: requestContext.studioId,
            serverId: requestContext.serverId,
            serverNodeId: requestContext.serverNodeId,
            connectionKind: "local",
            credentialKind: "loopback_token",
            trustState: "local",
          }
        : requestContext.authPrincipal,
      subscriptions: requestContext.studioId
        ? [{ kind: "studio", studioId: requestContext.studioId }]
        : [],
    } as any);
  }

  function ensureWsClientRecord(ws, requestContext, options = {}) {
    const existing = clients.get(ws);
    if (existing) return existing;
    const client = createInitialWsClientRecord(requestContext, options);
    clients.set(ws, client);
    return client;
  }

  function hardenStudio(msg) {
    if (!msg || typeof msg !== "object") return msg;
    if (msg.studioId) return msg;
    if (!msg.sessionPath) return msg;
    const studioId = engine.getRuntimeContext?.()?.studioId;
    if (!studioId) return msg;
    return { ...msg, studioId };
  }

  function broadcast(msg) {
    const hardenedMsg = hardenStudio(msg);
    let serialized = null;
    for (const [clientWs, client] of clients) {
      if (clientWs.readyState !== 1) continue;
      if (wsClientCanReceiveEvent(client, hardenedMsg)) {
        if (serialized === null) serialized = JSON.stringify(hardenedMsg);
        wsSendSerialized(clientWs, serialized);
      }
    }
  }

 // 浏览器缩略图 30s 定时刷新（browser 活跃时）
  let _browserThumbTimer = null;
  function startBrowserThumbPoll() {
    if (_browserThumbTimer) return;
    _browserThumbTimer = setInterval(async () => {
      const browser = BrowserManager.instance();
      if (!browser.hasAnyRunning) { stopBrowserThumbPoll(); return; }
      await Promise.all(browser.runningSessions.map(async (sp) => {
        const thumbnail = await browser.thumbnail(sp);
        if (thumbnail) {
          broadcast({ type: "browser_status", running: true, url: browser.currentUrl(sp), thumbnail, sessionPath: sp });
        }
      }));
    }, 30_000);
  }
  function stopBrowserThumbPoll() {
    if (_browserThumbTimer) { clearInterval(_browserThumbTimer); _browserThumbTimer = null; }
  }

  function emitStreamEvent(sessionPath, ss, event) {
    const run = engine.getExecutionRun?.(sessionPath);
    if (run) event = { ...event, runId: run.runId, runRevision: run.revision };
    const entry = appendSessionStreamEvent(ss, event);
 // Phase 4: 始终广播所有事件，前端按 sessionPath 路由到对应 panel
    broadcast(createSessionStreamEventWsMessage({
      sessionPath,
      sessionEvent: event,
      streamId: entry.streamId,
      seq: entry.seq,
    }));
    return entry;
  }

  function buildDeferredResultContentEvents(sessionPath, event) {
    const events = [];
    const mediaBlocks = deferredResultMediaBlocks(event);
    for (const block of mediaBlocks) {
      events.push({ type: "content_block", block });
    }
    if (mediaBlocks.length === 0) {
      const interlude = buildDeferredResultInterludeBlock(event, {
        receiverName: resolveDeferredReceiverName(engine, sessionPath),
      });
      if (interlude) events.push({ type: "content_block", block: interlude });
    }
    return events;
  }

  function emitDeferredContentEvents(sessionPath, ss, events) {
    for (const deferredEvent of events) {
      emitStreamEvent(sessionPath, ss, deferredEvent);
    }
  }

  function queueOrEmitDeferredContentEvents(sessionPath, ss, events, { delayUntilTurnEnd = ss?.isStreaming === true } = {}) {
    if (!ss || events.length === 0) return;
    if (delayUntilTurnEnd) {
      ss.pendingDeferredContentEvents.push(...events);
      return;
    }
    emitDeferredContentEvents(sessionPath, ss, events);
  }

  function flushPendingDeferredContentEvents(sessionPath, ss) {
    const pending = ss?.pendingDeferredContentEvents || [];
    if (!pending.length) return;
    ss.pendingDeferredContentEvents = [];
    emitDeferredContentEvents(sessionPath, ss, pending);
  }

  function beginStreamingTurnState(sessionPath, ss, { streamId = null, flushDeferred = false } = {}) {
    if (flushDeferred) flushPendingDeferredContentEvents(sessionPath, ss);
    ss.pendingTurnCompletionNotification = null;
    ss.lastStreamActivityAt = Date.now();
    ss.thinkTagParser.reset();
    ss.moodParser.reset();
    ss.cardParser.reset();
    ss.pendingPhaseTextByIndex?.clear?.();
    ss._cardHints = [];
    ss._cardEmitted = false;
    ss.isThinking = false;
    ss.hasOutput = false;
    ss.hasToolCall = false;
    ss.hasThinking = false;
    ss.thinkingFallback = "";
    ss.hasError = false;
    ss.isAborted = false;
    ss.turnEnded = false;
    ss.pendingTurnEnd = false;
    ss.titleRequested = false;
    ss.titlePreview = "";
    const statusStreamId = beginSessionStream(ss, streamId);
    scheduleTurnStallWatchdog(sessionPath, ss);
    return statusStreamId;
  }

  function textOrNull(value) {
    return typeof value === "string" && value.trim() ? value.trim() : null;
  }

  function turnInputConsumptionKey(item) {
    const entryId = item?.input?.entryId || null;
    if (entryId) return `entry:${entryId}`;
    const deliveryId = item?.deliveryId || item?.block?.deliveryId || null;
    if (deliveryId) return `delivery:${deliveryId}`;
    return item?.block?.id ? `block:${item.block.id}` : null;
  }

  function turnInputConsumptionAlreadyQueued(ss, item) {
    const key = turnInputConsumptionKey(item);
    if (!key) return false;
    if (ss.flushedTurnInputConsumptionKeys?.has?.(key)) return true;
    return (ss.pendingTurnInputConsumptions || []).some((queued) => (
      turnInputConsumptionKey(queued) === key
    ));
  }

  function buildPreReplyInterludeBlock(sessionPath, presentation) {
    if (presentation?.kind !== "pre_reply_interlude" || !presentation.taskId) return null;
    const task = engine.deferredResults?.query?.(presentation.taskId) || null;
    const taskStatus = task?.status === "failed" || task?.status === "aborted"
      ? task.status
      : presentation.status;
    const status = taskStatus === "failed" || taskStatus === "aborted" ? taskStatus : "success";
    const meta = {
      ...(task?.meta || {}),
      type: presentation.resultType || task?.meta?.type || "background-task",
    };
    const result = Object.prototype.hasOwnProperty.call(presentation, "result")
      ? presentation.result
      : task?.result;
    const reason = presentation.reason || task?.reason || null;
    return buildDeferredResultInterludeBlock({
      taskId: presentation.taskId,
      deliveryId: presentation.deliveryId || null,
      status,
      result,
      reason,
      meta,
    }, {
      receiverName: resolveDeferredReceiverName(engine, sessionPath),
    });
  }

  function isUiOnlyMediaTurnInput(presentation) {
    const resultType = presentation?.resultType || "";
    return presentation?.status === "success" && (
      resultType === "image-generation" ||
      resultType === "video-generation"
    );
  }

  function buildTurnInputConsumptionItem(sessionPath, message) {
    if (message?.role !== "custom") return null;
    if (message.display !== false) return null;
    if (message.customType !== DEFERRED_RESULT_MESSAGE_TYPE) return null;
    const event = buildTurnInputPresentationEvent(message, { deliveryMode: "consumed" });
    const presentation = event?.presentation;
    if (!presentation || isUiOnlyMediaTurnInput(presentation)) return null;
    const details = message.details && typeof message.details === "object" ? message.details : null;
    const entryId = textOrNull(message.id);
    const deliveryId =
      textOrNull(presentation.deliveryId) ||
      textOrNull(details?.deliveryId) ||
      (entryId ? `turn-input:${entryId}` : `turn-input:${randomUUID()}`);
    const normalizedPresentation = {
      ...presentation,
      deliveryId,
      deliveryMode: "consumed",
    };
    const block = buildPreReplyInterludeBlock(sessionPath, normalizedPresentation);
    if (!block) return null;
    return {
      kind: normalizedPresentation.kind,
      deliveryId,
      presentation: normalizedPresentation,
      input: {
        ...(entryId ? { entryId } : {}),
        customType: message.customType,
        deliveryId,
        taskId: normalizedPresentation.taskId,
        status: normalizedPresentation.status,
        resultType: normalizedPresentation.resultType,
        ...(textOrNull(message.timestamp) ? { timestamp: textOrNull(message.timestamp) } : {}),
      },
      block,
    };
  }

  function queueConsumedTurnInput(sessionPath, ss, message) {
    const item = buildTurnInputConsumptionItem(sessionPath, message);
    if (!item || turnInputConsumptionAlreadyQueued(ss, item)) return;
    ss.pendingTurnInputConsumptions = [...(ss.pendingTurnInputConsumptions || []), item];
  }

  function emitTurnInputConsumption(sessionPath, ss, item) {
    const block = item?.block;
    if (!block) return;
    emitStreamEvent(sessionPath, ss, { type: "content_block", block });
  }

  function persistTurnInputConsumption(sessionPath, item, assistantMessage = null) {
    if (!sessionPath || typeof engine.recordCustomEntry !== "function") return;
    const record = buildTurnInputConsumptionRecord({
      input: item?.input,
      assistant: assistantMessage && typeof assistantMessage === "object"
        ? {
            ...(textOrNull(assistantMessage.id) ? { entryId: textOrNull(assistantMessage.id) } : {}),
            ...(textOrNull(assistantMessage.parentId) ? { parentId: textOrNull(assistantMessage.parentId) } : {}),
            ...(textOrNull(assistantMessage.timestamp) ? { timestamp: textOrNull(assistantMessage.timestamp) } : {}),
          }
        : null,
      presentation: item?.presentation,
      block: item?.block,
    });
    if (!record) return;
    try {
      engine.recordCustomEntry(sessionPath, TURN_INPUT_CONSUMPTION_EVENT_TYPE, record);
    } catch (err) {
      debugLog()?.warn?.("ws", `turn input consumption persistence failed: ${err.message}`);
    }
  }

  function takePendingTurnInputConsumptionsForAssistant(ss, assistantMessage = null) {
    const pending = ss.pendingTurnInputConsumptions || [];
    if (!pending.length) return { items: [], remaining: [] };
    const parentId = textOrNull(assistantMessage?.parentId);
    if (!parentId) return { items: pending, remaining: [] };
    const matchIndex = pending.findIndex((item) => item?.input?.entryId === parentId);
    if (matchIndex < 0) return { items: [], remaining: pending };
    return {
      items: pending.slice(0, matchIndex + 1),
      remaining: pending.slice(matchIndex + 1),
    };
  }

  function flushPendingTurnInputConsumptions(sessionPath, ss, assistantMessage = null) {
    const { items, remaining } = takePendingTurnInputConsumptionsForAssistant(ss, assistantMessage);
    if (!items.length) return [];
    ss.pendingTurnInputConsumptions = remaining;
    if (!(ss.flushedTurnInputConsumptionKeys instanceof Set)) {
      ss.flushedTurnInputConsumptionKeys = new Set();
    }
    for (const item of items) {
      persistTurnInputConsumption(sessionPath, item, assistantMessage);
      emitTurnInputConsumption(sessionPath, ss, item);
      const key = turnInputConsumptionKey(item);
      if (key) ss.flushedTurnInputConsumptionKeys.add(key);
    }
    return items;
  }

  function clearTurnStallWatchdog(ss) {
    if (!ss?.turnStallTimer) return;
    clearTimeout(ss.turnStallTimer);
    ss.turnStallTimer = null;
  }

  function isSessionRuntimeStreaming(sessionPath) {
    try {
      return engine.isSessionStreaming?.(sessionPath) === true;
    } catch {
      return false;
    }
  }

  function scheduleTurnStallWatchdog(sessionPath, ss) {
    if (!sessionPath || !ss || turnStallAbortMs === 0) return;
    clearTurnStallWatchdog(ss);
    const lastActivity = ss.lastStreamActivityAt || Date.now();
    const delay = Math.max(0, turnStallAbortMs - (Date.now() - lastActivity));
    ss.turnStallTimer = setTimeout(() => {
      ss.turnStallTimer = null;
      const idleFor = Date.now() - (ss.lastStreamActivityAt || 0);
      if (idleFor < turnStallAbortMs) {
        scheduleTurnStallWatchdog(sessionPath, ss);
        return;
      }
      if (!isSessionRuntimeStreaming(sessionPath)) return;
      ss.isAborted = true;
      Promise.resolve(hub.abort?.(sessionPath)).then((aborted) => {
        if (aborted === false) return engine.abortSessionByPath?.(sessionPath);
      }).catch((err) => {
        debugLog()?.warn?.("ws", `turn stall abort failed for ${path.basename(sessionPath)}: ${err.message}`);
      });
    }, delay);
    ss.turnStallTimer.unref?.();
  }

  function markTurnStreamActivity(sessionPath, ss) {
    if (!sessionPath || !ss || !isSessionRuntimeStreaming(sessionPath)) return;
    ss.lastStreamActivityAt = Date.now();
    scheduleTurnStallWatchdog(sessionPath, ss);
  }

  function deliverOrDeferTurnCompletionNotification(sessionPath, ss, details) {
    if (!ss) {
      maybeDeliverTurnCompletionNotification(engine, sessionPath, details);
      return;
    }
    if (isSessionRuntimeStreaming(sessionPath)) {
      ss.pendingTurnCompletionNotification = details;
      return;
    }
    ss.pendingTurnCompletionNotification = null;
    maybeDeliverTurnCompletionNotification(engine, sessionPath, details);
  }

  function flushPendingTurnCompletionNotification(sessionPath, ss) {
    const pending = ss?.pendingTurnCompletionNotification;
    if (!pending || isSessionRuntimeStreaming(sessionPath)) return;
    ss.pendingTurnCompletionNotification = null;
    maybeDeliverTurnCompletionNotification(engine, sessionPath, {
      ...pending,
      wasAborted: pending.wasAborted || ss.isAborted === true,
    });
  }

  function recordSessionError(sessionPath: any, message: any, options: any = {}) {
    if (!runtimeDiagnostics) return null;
    const userMessage = options.userMessage || "Model call failed. Diagnostics were saved.";
    const sessionModel = options.model || engine.getSessionByPath?.(sessionPath)?.model;
    const diagnostic = buildModelErrorDiagnostic(options.error ?? message, sessionModel);
    const diagnosticId = runtimeDiagnostics.recordDiagnostic({
      traceId: options.traceId,
      sessionPath,
      severity: "error",
      category: options.category || "model",
      userMessage,
      technicalMessage: diagnostic.message,
      suggestion: options.suggestion || "Check provider credentials, network status, or tool permissions, then retry.",
      model: diagnostic.model,
      errorClassification: diagnostic.details.classification,
      tool: options.tool,
      sanitizedDetails: options.details || diagnostic.details,
    });
    runtimeDiagnostics.recordRuntimeRecord({
      severity: "error",
      category: options.category || "model",
      title: userMessage,
      detail: diagnostic.message,
      traceId: options.traceId,
      diagnosticId,
      sessionPath,
      model: diagnostic.model,
      errorClassification: diagnostic.details.classification,
      tool: options.tool,
    });
    return diagnosticId;
  }

  function sendSessionError(sessionPath, message, { terminal = true, replayable = false, category = "model", traceId = null, error = null } = {}) {
    const diagnostic = buildModelErrorDiagnostic(error ?? message, engine.getSessionByPath?.(sessionPath)?.model);
    const diagnosticId = recordSessionError(sessionPath, diagnostic.message, { category, traceId, error: error ?? message });
    const payload = { type: "error", message: diagnostic.message, sessionPath, terminal, diagnosticId };
    const ss = replayable && sessionPath ? sessionState.get(sessionPath) : null;
    if (ss) {
      emitStreamEvent(sessionPath, ss, payload);
    } else {
      broadcast(payload);
    }
  }

  function queuePromptForSession(sessionPath, prompt) {
    const ss = getState(sessionPath);
    if (!ss) return { ok: false, reason: "missing_session" };
    if (!Array.isArray(ss.pendingPromptQueue)) ss.pendingPromptQueue = [];
    if (ss.pendingPromptQueue.length >= MAX_QUEUED_PROMPTS_PER_SESSION) {
      return { ok: false, reason: "queue_full", queuedCount: ss.pendingPromptQueue.length };
    }
    const queued = { ...prompt, deadline: prompt.deadline || Date.now() + 15 * 60_000 };
    ss.pendingPromptQueue.push(queued);
    const expiry = setTimeout(() => {
      const current = sessionState.get(sessionPath);
      if (!current?.pendingPromptQueue?.includes(queued)) return;
      current.pendingPromptQueue = current.pendingPromptQueue.filter(item => item !== queued);
      sendSessionError(sessionPath, `排队已超过 15 分钟，请重新提交：${String(queued.text || '').slice(0, 120)}`, { terminal: false });
    }, Math.max(1, queued.deadline - Date.now()));
    expiry.unref?.();
    return { ok: true, queuedCount: ss.pendingPromptQueue.length };
  }

  function notifyPromptQueued(ws, sessionPath, queuedCount) {
    wsSend(ws, {
      type: "turn_queued",
      sessionPath,
      queuedCount,
    });
  }

  function schedulePromptQueueDrain(sessionPath) {
    const ss = sessionState.get(sessionPath);
    if (!ss || ss.drainingPromptQueue) return;
    if (["pausing", "paused", "needs_attention"].includes(engine.getExecutionRun?.(sessionPath)?.status)) return;
    if (ss.isStreaming || engine.isSessionStreaming?.(sessionPath)) return;
    if (!Array.isArray(ss.pendingPromptQueue) || ss.pendingPromptQueue.length === 0) return;

    ss.drainingPromptQueue = true;
    setTimeout(async () => {
      const current = sessionState.get(sessionPath);
      if (!current) return;
      let retryDelayMs = 0;
      try {
        if (["pausing", "paused", "needs_attention"].includes(engine.getExecutionRun?.(sessionPath)?.status)) return;
        if (current.isStreaming || engine.isSessionStreaming?.(sessionPath)) return;
        const next = current.pendingPromptQueue.shift();
        if (!next) return;
        if (Date.now() >= next.deadline) {
          sendSessionError(sessionPath, `排队已过期，请重新提交：${String(next.text || '').slice(0, 120)}`, { terminal: false });
          return;
        }
        try {
          await hub.send(next.text, next.options);
        } catch (err) {
          const rawMessage = err?.message || String(err);
          if (rawMessage === "session_busy") {
            try {
              await hub.send(next.text, {
                ...(next.options || {}),
                streamingBehavior: "followUp",
              });
            } catch (followUpErr) {
              current.pendingPromptQueue.unshift(next);
              if ((followUpErr?.message || String(followUpErr)) === "session_busy") {
                retryDelayMs = 350;
                return;
              }
              const followUpMessage = followUpErr?.message || String(followUpErr);
              if (!followUpMessage.includes("aborted")) {
                sendSessionError(sessionPath, followUpMessage, { terminal: true, replayable: false });
              }
            }
            return;
          }
          if (!rawMessage.includes("aborted")) {
            sendSessionError(sessionPath, rawMessage, { terminal: true, replayable: false });
          }
        }
      } finally {
        const latest = sessionState.get(sessionPath);
        if (latest) {
          latest.drainingPromptQueue = false;
          if (retryDelayMs > 0) {
            setTimeout(() => schedulePromptQueueDrain(sessionPath), retryDelayMs);
          } else if (!latest.isStreaming && !engine.isSessionStreaming?.(sessionPath) && latest.pendingPromptQueue?.length > 0) {
            schedulePromptQueueDrain(sessionPath);
          }
        }
      }
    }, 0);
  }

  function maybeGenerateFirstTurnTitle(sessionPath, ss) {
    if (!sessionPath || !ss || ss.titleRequested) return;

    const session = engine.getSessionByPath?.(sessionPath);
    const messages = Array.isArray(session?.messages) ? session.messages : [];
    const userMsgCount = messages.filter(m => m.role === "user").length;
    if (userMsgCount !== 1) return;

    const assistantMsg = messages.find(m => m.role === "assistant");
    const assistantText = (ss.titlePreview || extractText(assistantMsg?.content)).trim();
    if (!assistantText) return;

    ss.titleRequested = true;
    generateSessionTitle(engine, broadcast, {
      sessionPath,
      assistantTextHint: assistantText,
    }).then((ok) => {
      if (!ok) ss.titleRequested = false;
    }).catch((err) => {
      ss.titleRequested = false;
      console.error("[chat] generateSessionTitle error:", err.message);
    });
  }

  function appendThinkingFallback(ss, delta) {
    const text = typeof delta === "string" ? delta : "";
    if (!text) return;
    ss.thinkingFallback = `${ss.thinkingFallback || ""}${text}`;
  }

  // Subscribe once; stream events are stored once, then broadcast per client scope.
  hub.subscribe((event, sessionPath) => {
    // Non-session-scoped events: handle before session resolution
    const appEventMessage = toAppEventWsMessage(event);
    if (appEventMessage) {
      broadcast(appEventMessage);
      return;
    }
    const resourceEventMessage = toResourceEventWsMessage(event, sessionPath);
    if (resourceEventMessage) {
      broadcast(resourceEventMessage);
      return;
    }
    if (event.type === "plugin_ui_changed") {
      broadcast({ type: "plugin_ui_changed" });
      return;
    }
    if (event.type === "session_created") {
      broadcast({
        type: "session_created",
        sessionPath,
        session: event.session || null,
      });
      return;
    }
    const compactionMessage = toCompactionLifecycleWsMessage(
      event,
      sessionPath,
      (sp) => engine.getSessionByPath?.(sp),
    );
    if (compactionMessage) {
      broadcast(compactionMessage);
      return;
    }

    const ss = sessionPath ? getState(sessionPath) : null;
    if (ss && event.type !== "session_status") {
      markTurnStreamActivity(sessionPath, ss);
    }

    // Helper: feed CardParser, emit card events or pass text through as text_delta
    const feedCardPipeline = (text) => {
      ss.cardParser.feed(text, (cEvt) => {
        switch (cEvt.type) {
          case "text":
            if ((cEvt.data || "").trim()) ss.hasOutput = true;
            ss.titlePreview += cEvt.data || "";
            emitStreamEvent(sessionPath, ss, { type: "text_delta", delta: cEvt.data });
            maybeGenerateFirstTurnTitle(sessionPath, ss);
            break;
          case "card_start":
            ss._cardEmitted = true;
            emitStreamEvent(sessionPath, ss, { type: "card_start", attrs: cEvt.attrs });
            break;
          case "card_text":
            if ((cEvt.data || "").trim()) ss.hasOutput = true;
            emitStreamEvent(sessionPath, ss, { type: "card_text", delta: cEvt.data });
            break;
          case "card_end":
            emitStreamEvent(sessionPath, ss, { type: "card_end" });
            break;
        }
      });
    };

    if (event.type === "message_update") {
      if (!ss) return;
      const sub = event.assistantMessageEvent?.type;

      if (sub === "text_delta") {
        flushPendingTurnInputConsumptions(sessionPath, ss, event.message);
        if (ss.isThinking) {
          ss.isThinking = false;
          emitStreamEvent(sessionPath, ss, { type: "thinking_end" });
        }

        const delta = event.assistantMessageEvent.delta;
 //
        ss.thinkTagParser.feed(delta, (tEvt) => {
          switch (tEvt.type) {
            case "think_start":
              ss.hasThinking = true;
              emitStreamEvent(sessionPath, ss, { type: "thinking_start" });
              break;
            case "think_text":
              ss.hasThinking = true;
              appendThinkingFallback(ss, tEvt.data);
              emitStreamEvent(sessionPath, ss, { type: "thinking_delta", delta: tEvt.data });
              break;
            case "think_end":
              ss.hasThinking = true;
              emitStreamEvent(sessionPath, ss, { type: "thinking_end" });
              break;
            case "text":
              // Non-think content continues through MoodParser -> CardParser.
              ss.moodParser.feed(tEvt.data, (evt) => {
                switch (evt.type) {
                  case "text":
                    feedCardPipeline(evt.data);
                    break;
                  case "mood_start":
                    emitStreamEvent(sessionPath, ss, { type: "mood_start" });
                    break;
                  case "mood_text":
                    emitStreamEvent(sessionPath, ss, { type: "mood_text", delta: evt.data });
                    break;
                  case "mood_end":
                    emitStreamEvent(sessionPath, ss, { type: "mood_end" });
                    break;
                }
              });
              break;
          }
        });
      } else if (sub === "thinking_delta") {
        flushPendingTurnInputConsumptions(sessionPath, ss, event.message);
        ss.hasThinking = true;
        appendThinkingFallback(ss, event.assistantMessageEvent.delta || "");
        if (!ss.isThinking) {
          ss.isThinking = true;
          emitStreamEvent(sessionPath, ss, { type: "thinking_start" });
        }
        emitStreamEvent(sessionPath, ss, {
          type: "thinking_delta",
          delta: event.assistantMessageEvent.delta || "",
        });
      } else if (sub === "toolcall_start") {
        // Keep thinking open until tool execution begins.
      } else if (sub === "error") {
        ss.hasError = true;
        sendSessionError(sessionPath, event.assistantMessageEvent.error || "Unknown error", { replayable: true });
      }
    } else if (event.type === "execution_run") {
      broadcast({ type: "execution_run", run: event.run, sessionPath });
    } else if (event.type === "tool_execution_start") {
      if (!ss) return;
      flushPendingTurnInputConsumptions(sessionPath, ss, event.message);
      ss.hasToolCall = true;
      if (ss.isThinking) {
        ss.isThinking = false;
        emitStreamEvent(sessionPath, ss, { type: "thinking_end" });
      }
      // Only keep fields needed by extractToolDetail; avoid broadcasting full file contents.
      const args = summarizeToolStartArgs(event.toolName || "", event.args);
      emitStreamEvent(sessionPath, ss, {
        type: "tool_start",
        id: event.toolCallId || undefined,
        parentToolCallId: event.parentToolCallId || undefined,
        name: event.toolName || "",
        args,
      });
    } else if (event.type === "tool_execution_update") {
      if (ss) emitStreamEvent(sessionPath, ss, {
        type: "tool_progress", id: event.toolCallId, parentToolCallId: event.parentToolCallId,
        name: event.toolName, progress: toolProgressSummary(event.partialResult),
      });
    } else if (event.type === "tool_execution_end") {
      if (!ss) return;
      emitStreamEvent(sessionPath, ss, {
        type: "tool_end",
        id: event.toolCallId || undefined,
        parentToolCallId: event.parentToolCallId || undefined,
        name: event.toolName || "",
        success: !event.isError,
        durationMs: Number.isFinite(event.durationMs) ? event.durationMs : undefined,
        details: event.result?.details,
      });

      // Unified content_block emission for all tool results
      const blocks = extractBlocks(event.toolName, event.result?.details, event.result);
      for (const block of blocks) {
        emitStreamEvent(sessionPath, ss, { type: "content_block", block });
      }

      if (event.toolName === "browser") {
        const d = event.result?.details || {};
        const statusMsg: any = {
          type: "browser_status",
          running: d.running ?? false,
          url: d.url || null,
        };
        if (d.thumbnail) {
          statusMsg.thumbnail = d.thumbnail;
          statusMsg.thumbnailCapturedAt = d.thumbnailCapturedAt || Date.now();
          statusMsg.thumbnailUrl = d.thumbnailUrl || statusMsg.url;
        }
        emitStreamEvent(sessionPath, ss, statusMsg);
        if (statusMsg.running) startBrowserThumbPoll();
        else if (!BrowserManager.instance().hasAnyRunning) stopBrowserThumbPoll();
      }

      if (["write", "edit", "bash"].includes(event.toolName)) {
        broadcast({ type: "desk_changed", sessionPath });
      }
    } else if (event.type === "jian_update") {
      broadcast({ type: "jian_update", content: event.content });
    } else if (event.type === "devlog") {
      broadcast({ type: "devlog", text: event.text, level: event.level });
    } else if (event.type === "browser_status") {
      const statusMsg: any = {
        type: "browser_status",
        running: !!event.running,
        url: event.url || null,
        sessionPath,
      };
      if (event.thumbnail) {
        statusMsg.thumbnail = event.thumbnail;
        statusMsg.thumbnailCapturedAt = event.thumbnailCapturedAt || Date.now();
        statusMsg.thumbnailUrl = event.thumbnailUrl || statusMsg.url;
      }
      if (event.error) statusMsg.error = event.error;
      broadcast(statusMsg);
      if (statusMsg.running) startBrowserThumbPoll();
      else if (!BrowserManager.instance().hasAnyRunning) stopBrowserThumbPoll();
    } else if (event.type === "browser_bg_status") {
      broadcast({ type: "browser_bg_status", running: event.running, url: event.url, sessionPath });
    } else if (event.type === "computer_overlay") {
      if (!ss) return;
      emitStreamEvent(sessionPath, ss, event);
    } else if (event.type === "session_confirmation" && event.request) {
      if (!ss) return;
      emitStreamEvent(sessionPath, ss, {
        type: "content_block",
        block: event.request,
      });
    } else if (event.type === "cron_confirmation" && event.confirmId) {
      // Blocking cron confirmation emitted by the engine.
      if (!ss) return;
      emitStreamEvent(sessionPath, ss, {
        type: "content_block",
        block: buildAutomationSuggestionBlock({
          confirmId: event.confirmId,
          jobData: event.jobData || {},
          operation: event.operation === "update" ? "update" : "create",
          status: "pending",
        }),
      });
    } else if (event.type === "settings_confirmation") {
      if (!ss) return;
      emitStreamEvent(sessionPath, ss, {
        type: "content_block",
        block: {
          type: "settings_confirm", confirmId: event.confirmId,
          settingKey: event.settingKey, cardType: event.cardType,
          currentValue: event.currentValue, proposedValue: event.proposedValue,
          options: event.options, optionLabels: event.optionLabels || null,
          label: event.label, description: event.description,
          frontend: event.frontend, status: "pending",
        },
      });
    } else if (event.type === "confirmation_resolved") {
      broadcast({
        type: "confirmation_resolved",
        confirmId: event.confirmId,
        action: event.action,
        value: event.value,
      });
    } else if (event.type === "apply_frontend_setting") {
      broadcast({
        type: "apply_frontend_setting",
        key: event.key,
        value: event.value,
      });
    } else if (event.type === "block_update") {
      broadcast({
        type: "block_update",
        taskId: event.taskId,
        patch: event.patch,
        sessionPath,
      });
    } else if (event.type === TURN_INPUT_PRESENTATION_EVENT_TYPE) {
      // Delivery notifications are advisory; the visible timeline is tied to
      // the hidden custom_message once the SDK consumes it for a turn.
    } else if (event.type === "turn_start") {
      if (!ss) return;
      if (!ss.isStreaming) {
        const statusStreamId = beginStreamingTurnState(sessionPath, ss);
        broadcast({
          type: "status",
          isStreaming: true,
          sessionPath,
          streamId: statusStreamId,
        });
      }
    } else if (event.type === "activity_update") {
      broadcast({ type: "activity_update", activity: event.activity });
    } else if (event.type === "agent_activity") {
      const agentActivityMsg = toAgentActivityWsMessage(event, sessionPath);
      if (agentActivityMsg) broadcast(agentActivityMsg);
    } else if (event.type === "bridge_message") {
      broadcast({ type: "bridge_message", message: event.message });
    } else if (event.type === "bridge_status") {
      broadcast({ type: "bridge_status", platform: event.platform, status: event.status, error: event.error, agentId: event.agentId || null });
    } else if (event.type === "session_branch_reset") {
      const payload = {
        type: "session_branch_reset",
        messageId: event.messageId || null,
        clientMessageId: event.clientMessageId || null,
      };
      if (ss) emitStreamEvent(sessionPath, ss, payload);
      else broadcast({ ...payload, sessionPath });
    } else if (event.type === "agent_review_status") {
      emitStreamEvent(sessionPath, ss, { type: 'agent_review_status', review: event.review });
    } else if (event.type === "session_user_message") {
      broadcast({ type: "session_user_message", sessionPath, message: event.message });
    } else if (event.type === "session_status") {
      // SDK completion can precede prompt cleanup (or an enclosing agent review).
      // Keep the client busy until the runtime actually releases its turn lock.
      if (!event.isStreaming && isSessionRuntimeStreaming(sessionPath)) return;
      if (ss) {
        if (event.isStreaming) {
          beginStreamingTurnState(sessionPath, ss, { flushDeferred: true });
        } else if (ss.isStreaming) {
          const hadStreamActivity = ss.pendingTurnEnd || ss.hasOutput || ss.hasToolCall || ss.hasThinking || ss.isThinking || ss._cardEmitted;
          if (hadStreamActivity) {
            finalizeSessionTurn({ broadcastStatus: false });
          } else {
            clearTurnStallWatchdog(ss);
            finishSessionStream(ss);
            ss.thinkTagParser.reset();
            ss.moodParser.reset();
            ss.cardParser.reset();
          }
        } else {
          clearTurnStallWatchdog(ss);
        }
      }
      broadcast({ type: "status", isStreaming: !!event.isStreaming, sessionPath });
      if (ss && !event.isStreaming) {
        flushPendingDeferredContentEvents(sessionPath, ss);
        flushPendingTurnCompletionNotification(sessionPath, ss);
        schedulePromptQueueDrain(sessionPath);
      }
    } else if (event.type === "bridge_rc_attached") {
      broadcast({
        type: "bridge_rc_attached",
        sessionKey: event.sessionKey,
        sessionPath,
        title: event.title,
        platform: event.platform || null,
      });
    } else if (event.type === "bridge_rc_detached") {
      broadcast({
        type: "bridge_rc_detached",
        sessionKey: event.sessionKey,
        sessionPath,
      });
    } else if (event.type === "session_metadata_updated") {
      broadcast({
        type: "session_metadata_updated",
        sessionPath,
        metadata: event.metadata && typeof event.metadata === "object" ? event.metadata : {},
      });
    } else if (event.type === "sessions_changed") {
      broadcast({ type: "sessions_changed", sessionPath });
    } else if (event.type === "plan_mode") {
      broadcast({
        type: "plan_mode",
        enabled: event.enabled,
        mode: event.mode,
        permissionMode: event.permissionMode,
        accessMode: event.accessMode,
        sessionPath,
      });
    } else if (event.type === "permission_mode") {
      broadcast({ type: "permission_mode", mode: event.mode, readOnly: event.readOnly, sessionPath });
    } else if (event.type === "access_mode") {
      broadcast({
        type: "access_mode",
        mode: event.mode,
        permissionMode: event.permissionMode,
        readOnly: event.readOnly,
        sessionPath,
      });
    } else if (event.type === "notification") {
      broadcast(toNotificationWsMessage(event, sessionPath));
    } else if (event.type === "channel_new_message") {
      broadcast({
        type: "channel_new_message",
        channelName: event.channelName,
        sender: event.sender,
        message: event.message || null,
      });
    } else if (event.type === "dm_new_message") {
      broadcast({ type: "dm_new_message", from: event.from, to: event.to });
    } else if (event.type === "conversation_agent_activity") {
      broadcast({ type: "conversation_agent_activity", activity: event.activity });
    } else if (event.type === "message_end") {
      if (event.message?.role === "custom" && event.message?.display === false && ss) {
        queueConsumedTurnInput(sessionPath, ss, event.message);
      }
      if (event.message?.role === "custom" && event.message?.display !== false) {
        const blocks = extractBlocks(event.message.customType, event.message.details, event.message);
        if (blocks.length > 0) {
          const targetState = ss || (sessionPath ? getState(sessionPath) : null);
          for (const block of blocks) {
            if (targetState) emitStreamEvent(sessionPath, targetState, { type: "content_block", block });
            else broadcast({ type: "content_block", block, sessionPath });
          }
        }
      }
      if (event.message?.stopReason === "error") {
        if (ss) ss.hasError = true;
        broadcast({ type: "error", message: event.message.errorMessage || "Unknown error", sessionPath });
      }
    } else if (event.type === "turn_end") {
      if (isSessionRuntimeStreaming(sessionPath)) {
        if (ss) ss.pendingTurnEnd = true;
      } else {
        finalizeSessionTurn();
      }
    } else if (event.type === "auto_compaction_start") {
      broadcast({ type: "compaction_start", sessionPath });
    } else if (event.type === "auto_compaction_end") {
      const s = engine.getSessionByPath(sessionPath);
      const usage = s?.getContextUsage?.();
      broadcast({
        type: "compaction_end",
        sessionPath,
        tokens: usage?.tokens ?? null,
        contextWindow: usage?.contextWindow ?? null,
        percent: usage?.percent ?? null,
      });
    } else if (event.type === "deferred_result") {
      if (!ss) return;
      const delayVisibleBlocks = ss.isStreaming === true && ss.turnEnded === false && ss.lastStreamActivityAt > 0;
      emitStreamEvent(sessionPath, ss, {
        type: "deferred_result",
        taskId: event.taskId,
        status: event.status,
        result: event.result,
        reason: event.reason,
        meta: event.meta,
      });
      queueOrEmitDeferredContentEvents(
        sessionPath,
        ss,
        buildDeferredResultContentEvents(sessionPath, event),
        { delayUntilTurnEnd: delayVisibleBlocks },
      );
    }

    function finalizeSessionTurn({ broadcastStatus = true } = {}) {
      if (!ss) return false;
      if (ss.turnEnded) return true;
      ss.pendingTurnEnd = false;
      ss.turnEnded = true;

      if (ss.isThinking) {
        ss.isThinking = false;
        emitStreamEvent(sessionPath, ss, { type: "thinking_end" });
      }

      const feedMoodPipeline = (text) => {
        ss.moodParser.feed(text, (evt) => {
          if (evt.type === "text") {
            feedCardPipeline(evt.data);
          } else if (evt.type === "mood_start") {
            emitStreamEvent(sessionPath, ss, { type: "mood_start" });
          } else if (evt.type === "mood_text") {
            emitStreamEvent(sessionPath, ss, { type: "mood_text", delta: evt.data });
          } else if (evt.type === "mood_end") {
            emitStreamEvent(sessionPath, ss, { type: "mood_end" });
          }
        });
      };

      ss.thinkTagParser.flush((tEvt) => {
        if (tEvt.type === "think_text") {
          ss.hasThinking = true;
          appendThinkingFallback(ss, tEvt.data);
          emitStreamEvent(sessionPath, ss, { type: "thinking_delta", delta: tEvt.data });
        } else if (tEvt.type === "think_end") {
          ss.hasThinking = true;
          emitStreamEvent(sessionPath, ss, { type: "thinking_end" });
        } else if (tEvt.type === "text") {
          feedMoodPipeline(tEvt.data);
        }
      });
      ss.moodParser.flush((evt) => {
        if (evt.type === "text") {
          feedCardPipeline(evt.data);
        } else if (evt.type === "mood_text") {
          emitStreamEvent(sessionPath, ss, { type: "mood_text", delta: evt.data });
        }
      });
      ss.cardParser.flush((cEvt) => {
        if (cEvt.type === "text") {
          if ((cEvt.data || "").trim()) ss.hasOutput = true;
          emitStreamEvent(sessionPath, ss, { type: "text_delta", delta: cEvt.data });
        } else if (cEvt.type === "card_text") {
          if ((cEvt.data || "").trim()) ss.hasOutput = true;
          emitStreamEvent(sessionPath, ss, { type: "card_text", delta: cEvt.data });
        } else if (cEvt.type === "card_start") {
          ss._cardEmitted = true;
          emitStreamEvent(sessionPath, ss, { type: "card_start", attrs: cEvt.attrs });
        } else if (cEvt.type === "card_end") {
          emitStreamEvent(sessionPath, ss, { type: "card_end" });
        }
      });

      const thinkingFallback = (ss.thinkingFallback || "").trim();
      if (!ss.hasOutput && !ss.hasToolCall && !ss._cardEmitted && !ss.hasError && !ss.isAborted && ss.hasThinking && thinkingFallback) {
        ss.hasOutput = true;
        ss.titlePreview += thinkingFallback;
        emitStreamEvent(sessionPath, ss, { type: "text_delta", delta: thinkingFallback });
        maybeGenerateFirstTurnTitle(sessionPath, ss);
      }

      if (!ss.hasOutput && !ss.hasToolCall && !ss._cardEmitted && !ss.hasError && !ss.isAborted) {
        ss.hasError = true;
        emitStreamEvent(sessionPath, ss, {
          type: "error",
          message: t(ss.hasThinking ? "error.modelThinkingOnly" : "error.modelNoResponse"),
          terminal: true,
        });
      }

      const turnWasAborted = ss.isAborted === true;
      const turnWasSuccessful = !turnWasAborted && !ss.hasError && (ss.hasOutput || ss.hasToolCall || ss.hasThinking || ss._cardEmitted);
      const turnStreamId = ss.streamId || null;

      try {
        const sess = engine.getSessionByPath?.(sessionPath);
        if (sess) {
          const usage = getLastAssistantUsage(sess.entries ?? []);
          if (usage) {
            const model = sess.model;
            logLlmUsage({
              source: "chat",
              api: model?.api ?? null,
              modelId: model?.id ?? null,
              provider: model?.provider ?? null,
              usage,
              costRates: model?.cost,
            } as any);
            hub.eventBus.emit({
              type: "token_usage",
              usage,
              modelId: model?.id ?? null,
              modelProvider: model?.provider ?? null,
            }, sessionPath);
          }
        }
      } catch (_) { /* usage reporting must not block stream finalization */ }

      emitStreamEvent(sessionPath, ss, { type: "turn_end" });
      finishSessionStream(ss);
      if (!isSessionRuntimeStreaming(sessionPath)) {
        clearTurnStallWatchdog(ss);
      }
      deliverOrDeferTurnCompletionNotification(sessionPath, ss, {
        wasAborted: turnWasAborted,
        wasSuccessful: turnWasSuccessful,
        streamId: turnStreamId,
      });
      flushPendingDeferredContentEvents(sessionPath, ss);
      if (broadcastStatus) {
        broadcast({ type: "status", isStreaming: false, sessionPath });
      }
      ss.hasOutput = false;
      ss.hasToolCall = false;
      ss.hasThinking = false;
      ss.thinkingFallback = "";
      ss.hasError = false;
      ss.isAborted = false;
      ss.pendingTurnInputConsumptions = [];
      ss.thinkTagParser.reset();
      ss.moodParser.reset();
      ss.cardParser.reset();
      ss._cardHints = [];
      ss._cardEmitted = false;

      debugLog()?.log("ws", `turn done (${sessionPath?.split("/").pop()})`);
      maybeGenerateFirstTurnTitle(sessionPath, ss);
      schedulePromptQueueDrain(sessionPath);
      return true;
    }
  });

 //

  restRoute.post("/task/:taskId/abort", async (c) => {
    const taskId = c.req.param("taskId");
    const registry = engine.taskRegistry;
    if (!registry) return c.json({ error: "registry unavailable" }, 500);
    const result = registry.abort(taskId);
    if (result === "not_found") return c.json({ error: "task not found" }, 404);
    if (result === "no_handler") return c.json({ error: "task type does not support abort" }, 400);
    return c.json({ ok: true, status: result });
  });

 //

  wsRoute.get("/ws",
    upgradeWebSocket((c) => {
      let closed = false;
      const requestContext = createRequestContext(c, engine);
      const isAdapterWithoutHttpRequest = !c?.req;

      return {
        onOpen(_event, ws) {
          cancelDisconnectAbort();
          activeWsClients++;
          clients.set(ws, createInitialWsClientRecord(requestContext, {
            assumeLocalOwner: isAdapterWithoutHttpRequest,
          }));
          debugLog()?.log("ws", "client connected");
        },

        onMessage(event, ws) {
          // Hono @hono/node-ws delivers event.data as a string for text frames
          const msg = wsParse(event.data);
          if (!msg) {
            wsSend(ws, { type: "error", message: "invalid JSON message" });
            return;
          }
          const validation = validateClientWsMessage(msg);
          if (!validation.ok) {
            wsSend(ws, { type: "error", message: validation.error, sessionPath: msg.sessionPath });
            return;
          }
          let client = ensureWsClientRecord(ws, requestContext, {
            assumeLocalOwner: isAdapterWithoutHttpRequest,
          });
          if (!wsClientCanSendMessage(client, msg)) {
            wsSend(ws, { type: "error", message: "insufficient_scope", sessionPath: msg.sessionPath });
            return;
          }
          if (msg.sessionPath && requestContext.studioId) {
            client = subscribeWsClientToSession(client, {
              studioId: requestContext.studioId,
              sessionPath: msg.sessionPath,
            });
            clients.set(ws, client);
          }

          // Wrap the async handler with error handling (replaces wrapWsHandler)
          (async () => {
            if (msg.type === "abort") {
              const abortPath = await requireSessionPath(msg, ws); if (!abortPath) return;
              const abortSs = getState(abortPath);
              if (abortSs) {
                abortSs.isAborted = true;
                abortSs.pendingPromptQueue = [];
              }
              if (engine.isSessionStreaming(abortPath)) {
                try { await hub.abort(abortPath); } catch {}
              }
              return;
            }

            if (msg.type === "steer" && msg.text) {
              debugLog()?.log("ws", `steer (${msg.text.length} chars)`);
              const steerPath = await requireSessionPath(msg, ws); if (!steerPath) return;
              if (engine.steerSession(steerPath, msg.text)) {
                wsSend(ws, { type: "steered" });
                return;
              }
 // agent 已停止，降级为正-prompt（下面的 prompt 分支会处理）
              debugLog()?.log("ws", `steer missed, falling back to prompt`);
              msg.type = "prompt";
            }

            // Replay buffered stream events when the client switches back to a session.
            if (msg.type === "resume_stream") {
              const currentPath = await requireSessionPath(msg, ws); if (!currentPath) return;
              const ss = sessionState.get(currentPath);
              const runtimeIsStreaming = typeof engine.isSessionStreaming === "function"
                ? !!engine.isSessionStreaming(currentPath)
                : !!ss?.isStreaming;
              if (ss) {
                const resumed = resumeSessionStream(ss, {
                  streamId: msg.streamId,
                  sinceSeq: msg.sinceSeq,
                });
                wsSend(ws, createStreamResumeWsMessage({
                  sessionPath: currentPath,
                  streamId: resumed.streamId,
                  sinceSeq: resumed.sinceSeq,
                  nextSeq: resumed.nextSeq,
                  reset: resumed.reset,
                  truncated: resumed.truncated,
                  isStreaming: resumed.isStreaming,
                  runtimeIsStreaming,
                  events: resumed.events,
                }));
              } else {
                wsSend(ws, createStreamResumeWsMessage({
                  sessionPath: currentPath,
                  streamId: null,
                  sinceSeq: Number.isFinite(msg.sinceSeq) ? Math.max(0, Math.floor(msg.sinceSeq)) : 0,
                  nextSeq: 1,
                  reset: false,
                  truncated: false,
                  isStreaming: false,
                  runtimeIsStreaming,
                  events: [],
                }));
              }
              return;
            }

            if (msg.type === "context_usage") {
              const usagePath = await requireSessionPath(msg, ws); if (!usagePath) return;
              const usageSession = engine.getSessionByPath(usagePath);
              const usage = usageSession?.getContextUsage?.();
              wsSend(ws, {
                type: "context_usage",
                sessionPath: usagePath,
                tokens: usage?.tokens ?? null,
                contextWindow: usage?.contextWindow ?? null,
                percent: usage?.percent ?? null,
              });
              return;
            }

            if (msg.type === "slash" && typeof msg.text === "string") {
              const sp = await requireSessionPath(msg, ws); if (!sp) return;
              const dispatcher = engine.slashDispatcher;
              if (!dispatcher) {
                wsSend(ws, { type: "error", message: "slash system not ready", sessionPath: sp });
                return;
              }
              const session = engine.getSessionByPath(sp);
              const agentId = session?.agentId || msg.agentId;
              if (!agentId) {
                wsSend(ws, { type: "error", message: "agentId required", sessionPath: sp });
                return;
              }
              const sendReply = async (text) => {
                wsSend(ws, { type: "slash_result", sessionPath: sp, text });
              };
              const res = await dispatcher.tryDispatch(msg.text.trim(), {
                sessionRef: { kind: "desktop", agentId, sessionPath: sp },
                source: "desktop",
                senderId: "desktop",
                isOwner: true,
                reply: sendReply,
              });
              if (!res.handled) {
                wsSend(ws, { type: "slash_result", sessionPath: sp, text: `[Unknown command] ${msg.text}` });
              }
              return;
            }

            if (msg.type === "compact") {
              const compactPath = await requireSessionPath(msg, ws); if (!compactPath) return;
              const session = engine.getSessionByPath(compactPath);
              if (!session) {
                wsSend(ws, { type: "error", message: t("error.noActiveSession"), sessionPath: compactPath });
                return;
              }
              if (session.isCompacting) {
                wsSend(ws, { type: "error", message: t("error.compacting"), sessionPath: compactPath });
                return;
              }
              if (engine.isSessionStreaming(compactPath)) {
                wsSend(ws, { type: "error", message: t("error.waitForReply"), sessionPath: compactPath });
                return;
              }
              broadcast({ type: "compaction_start", sessionPath: compactPath });
              try {
                let result = null;
                if (typeof engine.compactDesktopSession === "function") {
                  result = await engine.compactDesktopSession(compactPath);
                } else {
                  await session.compact();
                }
                const usage = session.getContextUsage?.();
                broadcast({
                  type: "compaction_end",
                  sessionPath: compactPath,
                  tokens: result?.tokensAfter ?? usage?.tokens ?? null,
                  contextWindow: result?.contextWindow ?? usage?.contextWindow ?? null,
                  percent: usage?.percent ?? null,
                });
              } catch (err) {
                const errMsg = err.message || "";
                if (errMsg.includes("Already compacted") || errMsg.includes("Nothing to compact")) {
                  broadcast({ type: "compaction_end", sessionPath: compactPath });
                } else {
                  broadcast({ type: "compaction_end", sessionPath: compactPath });
                  wsSend(ws, { type: "error", message: t("error.compactFailed", { msg: errMsg }), sessionPath: compactPath });
                }
              }
              return;
            }

            if (msg.type === "prompt" && (msg.text || msg.images?.length || msg.videos?.length || msg.audios?.length)) {
              // Image validation: up to 10 images, size and MIME enforced by shared helpers.
              if (msg.images?.length) {
                const MAX_IMAGES = 10;
                if (msg.images.length > MAX_IMAGES) {
                  wsSend(ws, { type: "error", message: t("error.maxImages", { max: MAX_IMAGES }), sessionPath: msg.sessionPath });
                  return;
                }
                for (const img of msg.images) {
                  if (!img?.mimeType || !isAllowedChatImageMime(img.mimeType)) {
                    wsSend(ws, { type: "error", message: t("error.unsupportedImageFormat", { mime: img?.mimeType || "unknown" }), sessionPath: msg.sessionPath });
                    return;
                  }
                  if (img.data && !isChatImageBase64WithinLimit(img.data)) {
                    wsSend(ws, { type: "error", message: t("error.imageTooLarge"), sessionPath: msg.sessionPath });
                    return;
                  }
                }
              }
 //
              if (msg.videos?.length) {
                const MAX_VIDEOS = 3;
                if (msg.videos.length > MAX_VIDEOS) {
                  wsSend(ws, { type: "error", message: t("error.maxVideos", { max: MAX_VIDEOS }), sessionPath: msg.sessionPath });
                  return;
                }
                for (const video of msg.videos) {
                  if (!video?.mimeType || !isAllowedChatVideoMime(video.mimeType)) {
                    wsSend(ws, { type: "error", message: t("error.unsupportedVideoFormat", { mime: video?.mimeType || "unknown" }), sessionPath: msg.sessionPath });
                    return;
                  }
                  if (video.data && !isChatVideoBase64WithinLimit(video.data)) {
                    wsSend(ws, { type: "error", message: t("error.videoTooLarge"), sessionPath: msg.sessionPath });
                    return;
                  }
                }
              }
              let promptText = msg.text || "";
              // Phase 2: 客户端可指定 sessionPath，否则使用焦点 session.
              const promptSessionPath = await requireSessionPath(msg, ws); if (!promptSessionPath) return;
              // Skill invocation tags
              const skillNote = buildSkillInvocationNote(
                msg.skills,
                resolveSelectedSkillRecords(engine, msg.skills, promptSessionPath),
              );
              if (skillNote) {
                promptText = `${skillNote}\n${promptText}`;
              }
              if (!promptText.trim()) {
                if (msg.images?.length) promptText = t("error.viewImage");
                else if (msg.videos?.length) promptText = t("error.viewVideo");
              }
              debugLog()?.log("ws", `user message (${promptText.length} chars, ${msg.images?.length || 0} images, ${msg.videos?.length || 0} videos)`);
              if (engine.isSessionStreaming(promptSessionPath)) {
                const queued = queuePromptForSession(promptSessionPath, {
                  text: promptText,
                  options: {
                    sessionPath: promptSessionPath,
                    images: msg.images,
                    videos: msg.videos,
                    audios: msg.audios,
                    uiContext: msg.uiContext ?? null,
                    displayMessage: msg.displayMessage,
                    sessionFileRefs: msg.sessionFileRefs,
                  },
                });
                if (queued.ok) {
                  notifyPromptQueued(ws, promptSessionPath, queued.queuedCount);
                } else {
                  wsSend(ws, {
                    type: "error",
                    message: queued.reason === "queue_full" ? "Prompt queue is full" : t("error.stillStreaming", { name: engine.agentName }),
                    sessionPath: promptSessionPath,
                    terminal: false,
                  });
                }
                return;
              }
              // Reject prompt while model switch is in progress
              if (engine.isSessionSwitching?.(promptSessionPath)) {
                wsSend(ws, { type: "error", message: "正在切换模型，请稍候", sessionPath: promptSessionPath });
                return;
              }
              try {
                await hub.send(promptText, {
                  sessionPath: promptSessionPath,
                  images: msg.images,
                  videos: msg.videos,
                  audios: msg.audios,
                  uiContext: msg.uiContext ?? null,
                  displayMessage: msg.displayMessage,
                  sessionFileRefs: msg.sessionFileRefs,
                });
              } catch (err) {
                const rawMessage = err?.message || String(err);
                const isBusy = rawMessage === "session_busy";
                if (isBusy) {
                  const queued = queuePromptForSession(promptSessionPath, {
                    text: promptText,
                    options: {
                      sessionPath: promptSessionPath,
                      images: msg.images,
                      videos: msg.videos,
                      audios: msg.audios,
                      uiContext: msg.uiContext ?? null,
                      displayMessage: msg.displayMessage,
                      sessionFileRefs: msg.sessionFileRefs,
                    },
                  });
                  if (queued.ok) {
                    notifyPromptQueued(ws, promptSessionPath, queued.queuedCount);
                    return;
                  }
                }
                if (!isBusy) {
                  broadcast({ type: "status", isStreaming: false, sessionPath: promptSessionPath });
                }
                if (!rawMessage.includes("aborted")) {
                  const errMessage = isBusy
                    ? t("error.stillStreaming", { name: engine.agentName })
                    : rawMessage;
                  sendSessionError(promptSessionPath, errMessage, {
                    terminal: !isBusy,
                    replayable: !isBusy,
                    error: err,
                  });
                }
              }
            }
          })().catch((err) => {
            const appErr = AppError.wrap(err);
            errorBus.report(appErr, { context: { wsMessageType: msg.type } });
            if (!appErr.message?.includes('aborted')) {
              wsSend(ws, { type: 'error', message: appErr.message || 'Unknown error', error: appErr.toJSON(), sessionPath: msg.sessionPath });
            }
          });
        },

        onError(event, _ws) {
          const err = event.error || event;
          console.error("[ws] error:", err.message || err);
          debugLog()?.error("ws", err.message || String(err));
        },

        onClose(_event, ws) {
          if (closed) return;
          closed = true;
          activeWsClients = Math.max(0, activeWsClients - 1);
          clients.delete(ws);
          debugLog()?.log("ws", "client disconnected");
          scheduleDisconnectAbort();
          // Drop idle non-streaming state when no clients remain.
          if (activeWsClients === 0) {
            for (const [sp, ss] of sessionState) {
              if (!ss.isStreaming) sessionState.delete(sp);
            }
          }
        },
      };
    })
  );

  return { restRoute, wsRoute };
}

/**
 * 后台生成 session 标题：从第一轮对话提取摘- * 只在 session 还没有自定义标题时执- */
async function generateSessionTitle(engine: any, notify: any, opts: any = {}) {
  try {
    const sessionPath = opts.sessionPath;
    if (!sessionPath) return false;

    // Avoid regenerating an existing title.
    const sessions = await engine.listSessions();
    const current = sessions.find(s => s.path === sessionPath);
    if (current?.title) return true;

    const session = engine.getSessionByPath(sessionPath);
    const messages = Array.isArray(session?.messages) ? session.messages : [];
    const userMsg = messages.find(m => m.role === "user");
    const assistantMsg = messages.find(m => m.role === "assistant");
    if (!userMsg && !opts.userTextHint) return false;

    const userText = (opts.userTextHint || extractText(userMsg?.content)).trim();
    const assistantText = (opts.assistantTextHint || extractText(assistantMsg?.content)).trim();
    if (!userText || !assistantText) return false;

    // summarizeTitle owns the timeout through its internal AbortSignal.
    let title = await engine.summarizeTitle(userText, assistantText, { timeoutMs: 15_000, sessionPath });

    // If title generation fails, use the first user message as a fallback title.
    if (!title) {
      const fallback = userText.replace(/\n/g, " ").trim().slice(0, 30);
      if (!fallback) return;
      title = fallback;
      console.log("[chat] session title API failed, using fallback:", title);
    }

    // Persist the resolved title.
    await engine.saveSessionTitle(sessionPath, title);

    // Notify clients to refresh the title.
    notify({ type: "session_title", title, path: sessionPath });
    return true;
  } catch (err) {
    console.error("[chat] failed to generate session title:", err.message);
    return false;
  }
}

function toolProgressSummary(result: any): string {
  const detail = result?.details?.progress ?? result?.details?.message;
  if (typeof detail === "string") return redactLogText(detail.slice(0, 2000));
  return redactLogText((Array.isArray(result?.content) ? result.content : [])
    .filter(item => item?.type === "text" && typeof item.text === "string")
    .slice(0, 4).map(item => item.text.slice(0, 500)).join("\n"));
}
