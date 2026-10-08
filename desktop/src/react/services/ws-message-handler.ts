/**
 * WebSocket message dispatch backed by the Zustand store.
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- server WebSocket payloads are dynamic JSON. */

import { streamBufferManager } from '../hooks/use-stream-buffer';
import { dispatchStreamKey } from './stream-key-dispatcher';
import { useStore } from '../stores';
import { updateKeyed } from '../stores/create-keyed-slice';
import { loadSessions as loadSessionsAction } from '../stores/session-actions';
import { scheduleSessionsRefresh } from './session-refresh-scheduler';
import { handleArtifact } from '../stores/preview-actions';
import { loadDeskFiles, loadDeskTreeFiles } from '../stores/desk-actions';
import {
  PREVIEW_DOCUMENT_CHANGE_REFRESH_OPTIONS,
  markDeskTreeDirtyForResourceChange,
  refreshOpenPreviewDocumentsForResourceChange,
  workspaceSubdirsFromResourceChange,
  type ResourceChangeEvent,
} from '../utils/preview-document-refresh';
import {
  appendChannelMessage as appendChannelMessageAction,
  loadChannels as loadChannelsAction,
  openChannel as openChannelAction,
  upsertConversationAgentActivity as upsertConversationAgentActivityAction,
} from '../stores/channel-actions';
import { getWebSocket } from './websocket';
import { toStringArray } from '../stores/session-selectors';
import { sessionScopedKey, sessionScopedListIncludes, sessionScopedValue } from '../stores/session-slice';
import { handleAppEvent } from './app-event-actions';
import {
  replayStreamResume,
  isStreamResumeRebuilding,
  isStreamScopedMessage,
  updateSessionStreamMeta,
} from './stream-resume';
import { TODO_TOOL_NAMES, type TodoToolName } from '../utils/todo-constants';
import { applyTodoLifecycle, migrateLegacyTodos } from '../utils/todo-compat';
import { renderMarkdown } from '../utils/markdown';
import { parseSkillInvocationNote } from '../utils/skill-invocation-note';
import { bumpMessageLiveVersion } from '../stores/message-live-version';
import { getDesktopApi } from '../utils/desktop-api';
import type { Session } from '../types';
import type { SessionMessages } from '../stores/chat-types';

let requestContextUsage: (sessionPath: string) => void = (sessionPath: string) => {
  const ws = getWebSocket();
  if (ws?.readyState === WebSocket.OPEN) {
    const state = useStore.getState();
    const sessionId = typeof state.currentSessionId === 'string' && state.currentSessionPath === sessionPath
      ? state.currentSessionId
      : state.sessions?.find((session: Session) => session.path === sessionPath)?.sessionId || null;
    ws.send(JSON.stringify({ type: 'context_usage', sessionPath, ...(sessionId ? { sessionId } : {}) }));
  }
};

function refreshDeskTreeForResourceChange(event: ResourceChangeEvent): void {
  markDeskTreeDirtyForResourceChange(event);
  for (const subdir of workspaceSubdirsFromResourceChange(event)) {
    void loadDeskTreeFiles(subdir, { force: true });
  }
}

export function configureWsMessageHandler(options: {
  requestContextUsage?: (sessionPath: string) => void;
}): void {
  requestContextUsage = options.requestContextUsage || requestContextUsage;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function listFromArrayOrObject<T = any>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === 'object') return Object.values(value as Record<string, T>);
  return [];
}

function sessionIdentityFromMessage(msg: any): { sessionId: string | null; sessionPath: string | null } {
  const session = msg?.session && typeof msg.session === 'object' ? msg.session : null;
  return {
    sessionId: nonEmptyString(msg?.sessionId) || nonEmptyString(session?.sessionId),
    sessionPath: nonEmptyString(msg?.sessionPath) || nonEmptyString(msg?.path) || nonEmptyString(session?.path),
  };
}

function rememberSessionLocatorFromMessage(msg: any): void {
  const { sessionId, sessionPath } = sessionIdentityFromMessage(msg);
  if (!sessionId || !sessionPath) return;
  useStore.setState((state: any) => {
    const currentLocator = state.sessionLocatorsById?.[sessionId] || null;
    const patch: Record<string, any> = {};
    if (currentLocator?.path !== sessionPath) {
      patch.sessionLocatorsById = {
        ...(state.sessionLocatorsById || {}),
        [sessionId]: { path: sessionPath },
      };
    }
    if (state.currentSessionPath === sessionPath && state.currentSessionId !== sessionId) {
      patch.currentSessionId = sessionId;
    }
    return Object.keys(patch).length ? patch : {};
  });
}

function isFocusedSessionMessage(msg: any): boolean {
  const { sessionId, sessionPath } = sessionIdentityFromMessage(msg);
  if (!sessionId && !sessionPath) return true;
  const state = useStore.getState();
  return (!!sessionPath && state.currentSessionPath === sessionPath)
    || (!!sessionId && state.currentSessionId === sessionId);
}


// Chat stream events handled by StreamBufferManager.

const REACT_CHAT_EVENTS = new Set([
  'text_delta', 'thinking_start', 'thinking_delta', 'thinking_end',
  'mood_start', 'mood_text', 'mood_end',
  'tool_start', 'tool_end', 'turn_end',
  'content_block', 'plugin_card',
  'media_generation_start', 'media_generation_end', 'deferred_result',
  'compaction_start', 'compaction_end',
]);

// Session visibility and streaming state.

function ensureCurrentSessionVisible(): void {
  const state = useStore.getState();
  const sessionPath = state.currentSessionPath;
  if (!sessionPath || state.pendingNewSession) return;
  if (state.sessions.some((s: any) => s.path === sessionPath)) return;

  useStore.setState({
    sessions: [{
      path: sessionPath,
      title: null,
      firstMessage: '',
      modified: new Date().toISOString(),
      messageCount: 0,
      agentId: state.currentAgentId || null,
      agentName: state.agentName || null,
      cwd: null,
      _optimistic: true,
    }, ...state.sessions],
  });
}

function upsertCreatedSession(msg: any): void {
  const incoming = msg.session && typeof msg.session === 'object' ? msg.session : {};
  const sessionPath = typeof incoming.path === 'string' && incoming.path.trim()
    ? incoming.path
    : typeof msg.sessionPath === 'string' && msg.sessionPath.trim()
      ? msg.sessionPath
      : null;
  if (!sessionPath) return;
  const sessionId = typeof incoming.sessionId === 'string' && incoming.sessionId.trim()
    ? incoming.sessionId.trim()
    : typeof msg.sessionId === 'string' && msg.sessionId.trim()
      ? msg.sessionId.trim()
      : null;

  const state = useStore.getState();
  const existing: any = state.sessions.find((s: any) => s.path === sessionPath) || {};
  const now = new Date().toISOString();
  const next = {
    ...existing,
    path: sessionPath,
    sessionId: sessionId || existing.sessionId || null,
    title: typeof incoming.title === 'string' ? incoming.title : existing.title ?? null,
    firstMessage: typeof incoming.firstMessage === 'string' ? incoming.firstMessage : existing.firstMessage ?? '',
    modified: typeof incoming.modified === 'string' ? incoming.modified : existing.modified ?? now,
    messageCount: Number.isFinite(incoming.messageCount) ? incoming.messageCount : existing.messageCount ?? 0,
    agentId: typeof incoming.agentId === 'string' ? incoming.agentId : existing.agentId ?? state.currentAgentId ?? null,
    agentName: typeof incoming.agentName === 'string' ? incoming.agentName : existing.agentName ?? state.agentName ?? null,
    cwd: typeof incoming.cwd === 'string' ? incoming.cwd : existing.cwd ?? null,
    pinnedAt: incoming.pinnedAt ?? existing.pinnedAt ?? null,
    hasSummary: incoming.hasSummary ?? existing.hasSummary,
    rcAttachment: incoming.rcAttachment ?? existing.rcAttachment ?? null,
    _optimistic: false,
  };

  useStore.setState({
    sessions: [next, ...state.sessions.filter((s: any) => s.path !== sessionPath)]
      .sort((a: any, b: any) => new Date(b.modified || 0).getTime() - new Date(a.modified || 0).getTime()),
    ...(sessionId ? {
      sessionLocatorsById: {
        ...(state.sessionLocatorsById || {}),
        [sessionId]: { path: sessionPath },
      },
    } : {}),
  });
}

function hasOptimisticCurrentSession(): boolean {
  const state = useStore.getState();
  const sessionPath = state.currentSessionPath;
  if (!sessionPath) return false;
  return !!state.sessions.find((s: any) => s.path === sessionPath && s._optimistic);
}

function applyTodoToolEnd(msg: any): void {
  if (msg.type !== 'tool_end' || !TODO_TOOL_NAMES.includes(msg.name as TodoToolName)) return;
  const sp = msg.sessionPath;
  if (!sp) {
    console.warn('[ws] tool_end(todo) missing sessionPath, skipping');
    return;
  }
  const todos = applyTodoLifecycle(migrateLegacyTodos(msg.details as { todos?: unknown[] } | null));
  useStore.getState().setSessionTodosForPath(sp, todos);
  // bump 版本：若 loadMessages 正在 fetch 旧快照，回来时会发现
  // 版本号变了，主动跳过 hydrate 写入，避免覆盖本次 live 状态。
  useStore.getState().bumpTodosLiveVersion(sp);
}

function isKnownChatSession(sessionPath: string, state = useStore.getState()): boolean {
  return !!sessionScopedValue(state, state.chatSessions, sessionPath)
    || state.sessions.some((s: any) => s.path === sessionPath);
}

function normalizeMessageTimestamp(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return Date.now();
}

function normalizeMessageTimestampIso(value: unknown): string {
  return new Date(normalizeMessageTimestamp(value)).toISOString();
}

function sameUserMessage(existing: any, incoming: any): boolean {
  if (!existing || existing.type !== 'message' || existing.data?.role !== 'user') return false;
  const existingId = existing.data.id;
  const incomingId = incoming.data.id;
  if (existingId && incomingId && existingId === incomingId) return true;
  const existingEntryId = existing.data.sourceEntryId;
  const incomingEntryId = incoming.data.sourceEntryId;
  return !!existingEntryId && !!incomingEntryId && existingEntryId === incomingEntryId;
}

function appendSessionUserMessage(
  sessionPath: string,
  item: any,
  beforeAssistantMessageId: string | null = null,
): boolean {
  const store = useStore.getState();
  if (!sessionScopedValue<SessionMessages>(store, store.chatSessions, sessionPath)) {
    store.initSession(sessionPath, [], false);
  }

  if (!beforeAssistantMessageId) {
    const currentState = useStore.getState();
    const current = sessionScopedValue<SessionMessages>(currentState, currentState.chatSessions, sessionPath);
    if (current?.items?.some((existing: any) => sameUserMessage(existing, item))) return false;
    useStore.getState().appendItem(sessionPath, item);
    return true;
  }

  let inserted = false;
  useStore.setState((state: any) => {
    const session = sessionScopedValue<SessionMessages>(state, state.chatSessions, sessionPath);
    if (!session) return {};
    if (session.items.some((existing: any) => sameUserMessage(existing, item))) return {};

    const targetIdx = session.items.findIndex((existing: any) =>
      existing.type === 'message' &&
      existing.data?.role === 'assistant' &&
      existing.data?.id === beforeAssistantMessageId,
    );
    const items = [...session.items];
    items.splice(targetIdx >= 0 ? targetIdx : items.length, 0, item);
    inserted = true;

    const sessionKey = sessionScopedKey(state, sessionPath) || sessionPath;
    const chatSessions = {
      ...state.chatSessions,
      [sessionKey]: { ...session, items },
    };
    if (sessionKey !== sessionPath) delete chatSessions[sessionPath];
    return { chatSessions };
  });
  return inserted;
}

function updateSessionListPreviewFromUserMessage(sessionPath: string, message: any): void {
  const text = typeof message?.text === 'string' ? message.text.trim() : '';
  const modified = normalizeMessageTimestampIso(message?.timestamp);
  const currentState = useStore.getState();
  const existing = currentState.sessions.find((session: Session) => session.path === sessionPath) || null;
  const baseSession: Session = existing || {
    path: sessionPath,
    title: null,
    firstMessage: '',
    modified,
    messageCount: 0,
    agentId: currentState.currentAgentId ?? null,
    agentName: currentState.agentName ?? null,
    cwd: null,
  };
  const nextSession: Session = {
    ...baseSession,
    path: sessionPath,
    firstMessage: existing?.firstMessage || text.slice(0, 100),
    modified,
    messageCount: Math.max(Number(existing?.messageCount) || 0, 0) + 1,
    agentId: existing?.agentId ?? currentState.currentAgentId ?? null,
    agentName: existing?.agentName ?? currentState.agentName ?? null,
    _optimistic: false,
  };
  useStore.setState({
    sessions: [nextSession, ...currentState.sessions.filter((session: Session) => session.path !== sessionPath)]
      .sort((a: Session, b: Session) => new Date(b.modified || 0).getTime() - new Date(a.modified || 0).getTime()),
  });
}

export function applyStreamingStatus(
  isStreaming: boolean,
  sessionPath: string | null,
  identity: { streamId?: string | null; turnId?: string | null } = {},
  options: { force?: boolean } = {},
): boolean {
  const beforeState = useStore.getState();
  const wasStreaming = !!sessionPath
    && sessionScopedListIncludes(beforeState, beforeState.streamingSessions, sessionPath);
  if (sessionPath) {
    if (isStreaming) {
      const addStreamingSession = useStore.getState().addStreamingSession;
      if (typeof addStreamingSession === 'function') {
        addStreamingSession(sessionPath, identity);
      } else {
        useStore.setState(s => ({
          streamingSessions: toStringArray(s.streamingSessions).includes(sessionPath)
            ? toStringArray(s.streamingSessions)
            : [...toStringArray(s.streamingSessions), sessionPath],
        }));
      }
      useStore.getState().clearInlineError(sessionPath);
    } else {
      let applied = true;
      const state = useStore.getState();
      if (options.force && typeof state.forceRemoveStreamingSession === 'function') {
        applied = state.forceRemoveStreamingSession(sessionPath);
      } else if (typeof state.removeStreamingSession === 'function') {
        applied = state.removeStreamingSession(sessionPath, identity);
      } else {
        useStore.setState(s => ({
          streamingSessions: toStringArray(s.streamingSessions).filter((p: string) => p !== sessionPath),
        }));
      }
      if (!applied) return false;
    }
  }

  if (!isStreaming && wasStreaming) {
    const state = useStore.getState();
    const focused = state.currentSessionPath;
    if (sessionPath && sessionPath === focused && !state.pendingNewSession) {
      state.requestInputFocus?.();
    } else if (sessionPath && sessionPath !== focused) {
      state.markSessionOutputUnread?.(sessionPath);
    }
  }

  const focused = useStore.getState().currentSessionPath;
  if (sessionPath && sessionPath !== focused) return false;
  // streamingSessions is the source of truth for streaming state.
  if (isStreaming) {
    ensureCurrentSessionVisible();
  } else if (hasOptimisticCurrentSession()) {
    scheduleSessionsRefresh('optimistic_session_settled');
  }
  return true;
}

function applyInputSessionConfirmationBlock(msg: any): void {
  if (msg.type !== 'content_block') return;
  const block = msg.block;
  if (block?.type !== 'session_confirmation' || block.surface !== 'input') return;
  const sessionPath = typeof msg.sessionPath === 'string' ? msg.sessionPath.trim() : '';
  if (!sessionPath) {
    console.warn('[ws] input session_confirmation missing sessionPath, skipping pending cache');
    return;
  }
  useStore.getState().setPendingSessionConfirmation?.(
    sessionPath,
    block.status === 'pending' ? block : null,
  );
}

//

export function handleServerMessage(msg: any): void {
  rememberSessionLocatorFromMessage(msg);
  const state = useStore.getState();

  const rebuildingFor = isStreamResumeRebuilding();

  if (rebuildingFor && msg.type === 'status' && state.currentSessionPath === rebuildingFor) {
    return;
  }

  if (
    rebuildingFor &&
    isStreamScopedMessage(msg) &&
    msg.sessionPath === rebuildingFor &&
    !msg.__fromReplay &&
    msg.type !== 'stream_resume'
  ) {
    return;
  }

  if (msg.type !== 'stream_resume' && isStreamScopedMessage(msg)) {
    if (!updateSessionStreamMeta(msg)) return;
  }

  applyInputSessionConfirmationBlock(msg);

 // 活跃 block 事件路由：非当前 session 的聊天事件分发到 stream-key-dispatcher
  if (REACT_CHAT_EVENTS.has(msg.type) && msg.sessionPath && msg.sessionPath !== state.currentSessionPath) {
    if (msg.type === 'turn_end') {
      applyStreamingStatus(false, msg.sessionPath, {
        streamId: msg.streamId ?? null,
        turnId: msg.turnId ?? null,
      });
    }
    if (isKnownChatSession(msg.sessionPath, state)) {
      streamBufferManager.handle(msg);
    }
    dispatchStreamKey(msg.sessionPath, msg);
    applyTodoToolEnd(msg);
    if (msg.type === 'tool_end') {
      applyToolEndSessionFile(msg);
    }
    return;
  }

 //
  if (REACT_CHAT_EVENTS.has(msg.type)) {
    streamBufferManager.handle(msg);
    // turn_end still needs shared cleanup such as session refresh.
    if (msg.type === 'turn_end') {
      const turnSessionPath = msg.sessionPath || useStore.getState().currentSessionPath || null;
      applyStreamingStatus(false, turnSessionPath, {
        streamId: msg.streamId ?? null,
        turnId: msg.turnId ?? null,
      });
      scheduleSessionsRefresh('turn_end');
      if (turnSessionPath) {
        requestContextUsage(turnSessionPath);
      } else {
        console.warn('[ws] turn_end missing sessionPath, skipping context_usage request');
      }
    }
    // Update todo state after supported tool completions.
    applyTodoToolEnd(msg);
    if (msg.type === 'tool_end') {
      applyToolEndSessionFile(msg);
    }
 //
    if (msg.type === 'compaction_end') {
      const sp = msg.sessionPath;
      if (sp) useStore.getState().removeCompactingSession(sp);
      // Write to the keyed store and compatibility state.
      if (sp) {
        if (msg.tokens != null && msg.contextWindow != null) {
          updateKeyed('contextBySession', sp,
            { tokens: msg.tokens ?? null, window: msg.contextWindow ?? null, percent: msg.percent ?? null },
            (_s, d) => ({ contextTokens: d.tokens, contextWindow: d.window, contextPercent: d.percent }),
          );
        } else {
          // SDK returns null right after compaction (no post-compaction response yet)
          // Reset to null so the ring shows empty/estimating instead of stale pre-compaction values
          const state = useStore.getState();
          const currentWindow = sessionScopedValue(state, state.contextBySession, sp)?.window ?? null;
          updateKeyed('contextBySession', sp,
            { tokens: null, window: currentWindow, percent: null },
            (_s, _d) => ({ contextTokens: null, contextPercent: null }),
          );
        }
      }
    }
    if (msg.type === 'compaction_start') {
      const sp = msg.sessionPath;
      if (sp) useStore.getState().addCompactingSession(sp);
    }
 //
    if (msg.type === 'content_block' && msg.block?.type === 'artifact' && state.currentTab === 'chat') {
      handleArtifact({ ...msg.block, sessionPath: msg.sessionPath });
    }
    return;
  }

 // 非聊天渲染事件走传统 switch
  switch (msg.type) {
    case 'resource.changed': {
      markDeskTreeDirtyForResourceChange(msg);
      void refreshOpenPreviewDocumentsForResourceChange(
        msg,
        PREVIEW_DOCUMENT_CHANGE_REFRESH_OPTIONS,
      );
      break;
    }

    case 'resource.deleted':
    case 'resource.renamed': {
      markDeskTreeDirtyForResourceChange(msg);
      void refreshOpenPreviewDocumentsForResourceChange(
        msg,
        PREVIEW_DOCUMENT_CHANGE_REFRESH_OPTIONS,
      );
      break;
    }

    case 'session_branch_reset': {
      const sp = msg.sessionPath;
      const targetId = msg.clientMessageId || msg.messageId;
      if (!sp || !targetId) {
        console.warn('[ws] session_branch_reset missing sessionPath or message id');
        break;
      }
      const truncated = useStore.getState().truncateSessionFromMessage(sp, targetId);
      bumpMessageLiveVersion(sp);
      if (!truncated) {
        console.warn('[ws] session_branch_reset target message not found:', sp, targetId);
      }
      break;
    }

    case 'stream_resume':
      replayStreamResume(msg);
      break;

    case 'session_title':
      if (msg.title) {
        useStore.setState({
          sessions: state.sessions.map((s: any) =>
            s.path === msg.path ? { ...s, title: msg.title } : s,
          ),
        });
      }
      break;

    case 'session_created':
      upsertCreatedSession(msg);
      scheduleSessionsRefresh('session_created');
      break;

    case 'desk_changed':
      loadDeskFiles();
      break;

    case 'browser_status': {
      const bsp = msg.sessionPath;
      if (!bsp) { console.warn('[ws] event missing sessionPath:', msg.type); break; }
      const bRunning = !!msg.running;
      const bUrl = msg.url || null;
      const prevThumbnail = state.browserBySession[bsp]?.thumbnail ?? null;
      const bThumbnail = bRunning ? (msg.thumbnail || prevThumbnail) : null;
      updateKeyed('browserBySession', bsp,
        { running: bRunning, url: bUrl, thumbnail: bThumbnail },
      );
 //
      if (window.platform?.updateBrowserViewer) {
        window.platform.updateBrowserViewer({
          running: bRunning,
          url: bUrl,
          thumbnail: bThumbnail,
        });
      }
      break;
    }

    case 'browser_bg_status': {
      const bgSp = msg.sessionPath;
      if (!bgSp) { console.warn('[ws] event missing sessionPath:', msg.type); break; }
      const prev = useStore.getState().browserBySession[bgSp] || { running: false, url: null, thumbnail: null };
      updateKeyed('browserBySession', bgSp,
        { ...prev, running: !!msg.running },
      );
      break;
    }

    case 'computer_overlay': {
      const sp = msg.sessionPath;
      if (!sp) { console.warn('[ws] event missing sessionPath:', msg.type); break; }
      if (msg.phase === 'clear') {
        useStore.getState().clearComputerOverlayForSession(sp);
      } else {
        useStore.getState().setComputerOverlayForSession(sp, {
          phase: msg.phase || 'running',
          action: msg.action || 'computer',
          agentId: msg.agentId ?? null,
          leaseId: msg.leaseId ?? null,
          snapshotId: msg.snapshotId ?? null,
          target: msg.target ?? null,
          inputMode: msg.inputMode === 'foreground-input' ? 'foreground-input' : 'background',
          visualSurface: msg.visualSurface === 'provider' ? 'provider' : 'renderer',
          requiresForeground: msg.requiresForeground === true,
          interruptKey: msg.interruptKey ?? null,
          errorCode: msg.errorCode ?? null,
          ts: msg.ts || Date.now(),
        });
      }
      break;
    }

    case 'block_update': {
      const { taskId, patch, sessionPath: sp } = msg;
      if (!taskId || !patch) break;
      if (!sp) { console.warn('[ws] event missing sessionPath:', msg.type); break; }
      useStore.getState().patchBlockByTaskId(sp, taskId, patch);
      break;
    }

    case 'activity_update':
      if (msg.activity) {
        useStore.setState({ activities: [msg.activity, ...state.activities.slice(0, 499)] });
      }
      break;

    case 'agent_activity':
      if (msg.entry?.id) {
        useStore.getState().upsertAgentActivity(msg.entry);
      }
      break;

    case 'notification':
      getDesktopApi()?.showNotification?.(msg.title, msg.body, msg.agentId || null, {
        desktopFocusPolicy: msg.desktopFocusPolicy || 'always',
        sessionPath: msg.sessionPath || null,
      });
      break;

    case 'bridge_status':
      useStore.getState().triggerBridgeReload();
      break;

    case 'plugin_ui_changed':
      import('../stores/plugin-ui-actions').then(m => m.refreshPluginUI());
      break;

    case 'app_event':
      if (msg.event?.type) {
        handleAppEvent(msg.event.type, msg.event.payload || {}, { source: msg.event.source || 'server' });
      }
      break;

    case 'bridge_message':
      if (msg.message) {
        useStore.getState().addBridgeMessage(msg.message);
      }
      break;

    case 'agent_review_status': {
      if (!msg.sessionPath || !msg.review?.requestId) break;
      const state = useStore.getState();
      const session = sessionScopedValue(state, state.chatSessions, msg.sessionPath);
      const item = session?.items.find(item => item.type === 'message' && item.data.agentReview?.requestId === msg.review.requestId);
      if (item?.type === 'message') {
        useStore.setState(current => {
          const key = sessionScopedKey(current, msg.sessionPath) || msg.sessionPath;
          const latest = sessionScopedValue(current, current.chatSessions, msg.sessionPath);
          if (!latest) return {};
          return { chatSessions: { ...current.chatSessions, [key]: { ...latest, items: latest.items.map(entry =>
            entry.type === 'message' && entry.data.agentReview?.requestId === msg.review.requestId
              ? { ...entry, data: { ...entry.data, agentReview: msg.review } } : entry) } } };
        });
      }
      bumpMessageLiveVersion(msg.sessionPath);
      break;
    }
    case 'session_user_message': {
      const sp = msg.sessionPath;
      if (!sp || !msg.message) break;
      const isSessionActivelyStreaming = sessionScopedListIncludes(
        useStore.getState(),
        useStore.getState().streamingSessions,
        sp,
      );
      const activeAssistantMessageId = isSessionActivelyStreaming
        ? streamBufferManager.getActiveMessageId?.(sp) || null
        : null;
      if (!activeAssistantMessageId) {
        streamBufferManager.beginUserTurn(sp);
      }
      const { text, skills: envelopeSkills } = parseSkillInvocationNote(msg.message.text);
      const appended = appendSessionUserMessage(sp, {
        type: 'message',
        data: {
          id: msg.message.id || `user-${Date.now()}`,
          sourceEntryId: msg.message.sourceEntryId,
          role: 'user',
          text,
          textHtml: text ? renderMarkdown(text) : undefined,
          timestamp: normalizeMessageTimestamp(msg.message.timestamp),
          attachments: msg.message.attachments,
          quotedText: msg.message.quotedText,
          skills: msg.message.skills?.length ? msg.message.skills : (envelopeSkills.length ? envelopeSkills : undefined),
          workspaceTool: msg.message.workspaceTool,
          quickAction: msg.message.quickAction,
          agentMentions: msg.message.agentMentions,
          sessionRefs: msg.message.sessionRefs,
          agentReview: msg.message.agentReview,
          reviewSourceSessionId: msg.message.reviewSourceSessionId,
          deskContext: msg.message.deskContext ?? undefined,
        },
      }, activeAssistantMessageId);
      if (appended) {
        updateSessionListPreviewFromUserMessage(sp, { ...msg.message, text });
      }
      bumpMessageLiveVersion(sp);
      if (sp === useStore.getState().currentSessionPath) {
        useStore.setState({ welcomeVisible: false });
      }
      break;
    }

    case 'bridge_rc_attached': {
      const sp = msg.sessionPath;
      if (sp && msg.sessionKey) {
        useStore.setState((s) => ({
          sessions: s.sessions.map((session) => session.path === sp
            ? {
              ...session,
              rcAttachment: {
                sessionKey: msg.sessionKey,
                platform: msg.platform || 'bridge',
                title: msg.title || null,
              },
            }
            : session),
        }));
      }
      break;
    }

    case 'bridge_rc_detached': {
      const sp = msg.sessionPath;
      if (sp) {
        useStore.setState((s) => ({
          sessions: s.sessions.map((session) => session.path === sp
            ? { ...session, rcAttachment: null }
            : session),
        }));
      }
      break;
    }

    case 'sessions_changed':
      Promise.resolve(loadSessionsAction()).catch(err => console.warn('[ws] loadSessions failed:', err));
      break;

    case 'session_metadata_updated': {
      const sp = msg.sessionPath;
      const sid = typeof msg.sessionId === 'string' && msg.sessionId.trim() ? msg.sessionId.trim() : null;
      const metadata = msg.metadata && typeof msg.metadata === 'object' ? msg.metadata : {};
      if (!sp) { console.warn('[ws] event missing sessionPath:', msg.type); break; }
      const hasPinnedAt = Object.prototype.hasOwnProperty.call(metadata, 'pinnedAt');
      const hasProjectId = Object.prototype.hasOwnProperty.call(metadata, 'projectId');
      if (hasPinnedAt || hasProjectId) {
        useStore.setState((s) => ({
          sessions: s.sessions.map((session) => {
            if (session.path !== sp && (!sid || session.sessionId !== sid)) return session;
            return {
              ...session,
              ...(hasPinnedAt
                ? { pinnedAt: typeof metadata.pinnedAt === 'string' ? metadata.pinnedAt : null }
                : {}),
              ...(hasProjectId
                ? { projectId: typeof metadata.projectId === 'string' && metadata.projectId.trim() ? metadata.projectId.trim() : null }
                : {}),
            };
          }),
        }));
      }
      if (sp === useStore.getState().currentSessionPath && typeof metadata.thinkingLevel === 'string') {
        useStore.getState().setThinkingLevel?.(metadata.thinkingLevel);
      }
      break;
    }

    case 'plan_mode': {
      if (isFocusedSessionMessage(msg)) {
        window.dispatchEvent(new CustomEvent('gsap-plan-mode', {
          detail: { enabled: !!msg.enabled, mode: msg.enabled ? 'read_only' : 'operate' },
        }));
      }
      break;
    }

    case 'permission_mode': {
      if (isFocusedSessionMessage(msg)) {
        window.dispatchEvent(new CustomEvent('gsap-plan-mode', {
          detail: { enabled: msg.mode === 'read_only', mode: msg.mode },
        }));
      }
      break;
    }

    case 'access_mode': {
      if (isFocusedSessionMessage(msg)) {
        window.dispatchEvent(new CustomEvent('gsap-plan-mode', {
          detail: {
            enabled: msg.readOnly === true,
            mode: msg.permissionMode || msg.mode,
          },
        }));
      }
      break;
    }

    case 'channel_new_message': {
      const store = useStore.getState();
      const isViewing = store.currentTab === 'channels' && store.currentChannel === msg.channelName && document.visibilityState === 'visible';
      if (msg.channelName && msg.message) {
        appendChannelMessageAction(msg.channelName, msg.message);
      } else if (msg.channelName && isViewing) {
        openChannelAction(msg.channelName);
      } else if (msg.channelName) {
        loadChannelsAction();
      }
      break;
    }

    case 'dm_new_message': {
      const currentAgentId = state.currentAgentId;
      const peerId = currentAgentId && msg.from === currentAgentId && msg.to
        ? msg.to
        : msg.from;
      const dmId = `dm:${peerId}`;
      const store2 = useStore.getState();
      const isViewingDM = store2.currentTab === 'channels' && store2.currentChannel === dmId && document.visibilityState === 'visible';
      if (isViewingDM) {
        openChannelAction(dmId, true);
      } else {
        loadChannelsAction();
      }
      break;
    }

    case 'conversation_agent_activity':
      if (msg.activity) {
        upsertConversationAgentActivityAction(msg.activity);
      }
      break;

    case 'context_usage': {
      const sp = msg.sessionPath;
      if (!sp) { console.warn('[ws] event missing sessionPath:', msg.type); break; }
      if (msg.tokens != null && msg.contextWindow != null) {
        updateKeyed('contextBySession', sp,
          { tokens: msg.tokens ?? null, window: msg.contextWindow ?? null, percent: msg.percent ?? null },
          (_s, d) => ({ contextTokens: d.tokens, contextWindow: d.window, contextPercent: d.percent }),
        );
      }
      break;
    }

    case 'error': {
      const sp = msg.sessionPath;
      if (!sp) { console.warn('[ws] event missing sessionPath:', msg.type); break; }
      if (isKnownChatSession(sp, useStore.getState())) {
        streamBufferManager.handle(msg);
      }
      if (msg.terminal !== false) {
        applyStreamingStatus(false, sp, {
          streamId: msg.streamId ?? null,
          turnId: msg.turnId ?? null,
        }, {
          force: !msg.streamId && !msg.turnId,
        });
      }
      useStore.getState().setInlineError(sp, msg.message);
      break;
    }

    case 'confirmation_resolved': {
      // Keep every matching confirmation card in sync across loaded sessions.
      // cron_confirm uses approved/rejected; settings_confirm uses confirmed/rejected.
      const nextStatusFor = (blockType: string): string => {
        if (msg.action === 'confirmed') return blockType === 'cron_confirm' || blockType === 'suggestion_card' ? 'approved' : 'confirmed';
        if (msg.action === 'timeout') return 'timeout';
        return 'rejected';
      };
      let changedPaths: string[] = [];
      useStore.setState((s: any) => {
        const chatSessions = s.chatSessions || {};
        let changed = false;
        const nextSessions: Record<string, any> = {};

        for (const [sp, session] of Object.entries(chatSessions) as Array<[string, any]>) {
          let sessionChanged = false;
          const items = listFromArrayOrObject<any>(session?.items).map((item: any) => {
            if (item.type !== 'message' || !item.data?.blocks) return item;
            let messageChanged = false;
            const blocks = listFromArrayOrObject<any>(item.data.blocks).map((b: any) => {
              const matchesType = b.type === 'settings_confirm'
                || b.type === 'cron_confirm'
                || b.type === 'suggestion_card'
                || b.type === 'session_confirmation';
              if (!matchesType || b.confirmId !== msg.confirmId) return b;
              messageChanged = true;
              return { ...b, status: nextStatusFor(b.type) };
            });
            if (!messageChanged) return item;
            sessionChanged = true;
            return { ...item, data: { ...item.data, blocks } };
          });
          if (!sessionChanged) {
            nextSessions[sp] = session;
            continue;
          }
          changed = true;
          changedPaths.push(sp);
          nextSessions[sp] = { ...session, items };
        }

        return changed ? { chatSessions: nextSessions } : {};
      });
      changedPaths = Array.from(new Set(changedPaths));
      useStore.getState().resolvePendingSessionConfirmation?.(msg.confirmId);
      for (const sp of changedPaths) {
        bumpMessageLiveVersion(sp);
      }
      break;
    }

    case 'apply_frontend_setting': {
      if (msg.key === 'theme') {
        window.applyTheme?.(msg.value);
        window.platform?.settingsChanged?.('theme-changed', { theme: msg.value });
      }
      break;
    }

    case 'status': {
      const sp = msg.sessionPath || useStore.getState().currentSessionPath || null;
      const sid = typeof msg.sessionId === 'string' && msg.sessionId.trim() ? msg.sessionId.trim() : null;
      const applied = applyStreamingStatus(msg.isStreaming, sp, {
        streamId: msg.streamId ?? null,
        turnId: msg.turnId ?? null,
      });
      if (sp && applied) {
        if (msg.isStreaming) {
          if (sid) streamBufferManager.beginTurn?.(sp, sid);
          else streamBufferManager.beginTurn?.(sp);
        } else if (sid) {
          streamBufferManager.finishTurn?.(sp, sid);
        } else {
          streamBufferManager.finishTurn?.(sp);
        }
      }
      break;
    }
  }
}

function applyToolEndSessionFile(msg: any): void {
  const sp = msg.sessionPath;
  const sessionFile = msg.details?.sessionFile;
  if (!sp || !sessionFile) return;
  useStore.getState().upsertSessionRegistryFile?.(sp, sessionFile);
}
