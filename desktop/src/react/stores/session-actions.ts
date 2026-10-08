/**
  *
  * */

/* eslint-disable @typescript-eslint/no-explicit-any -- store partial patch + API 鍝嶅簲 JSON */

import { useStore } from './index';
import { sessionScopedKey, sessionScopedValue } from './session-slice';
import { gsapFetch, gsapUrl } from '../hooks/use-gsap-fetch';
import { buildItemsFromHistory } from '../utils/history-builder';
import { migrateLegacyTodos } from '../utils/todo-compat';
import { loadAvatars as loadAvatarsAction, clearChat as clearChatAction } from './agent-actions';
import { loadDeskFiles } from './desk-actions';
import { syncPreviewPanelForOwner } from './preview-actions';
import { loadModels } from '../utils/ui-helpers';
import { normalizeYuanKey } from '../utils/yuan';
import { toStringArray } from './session-selectors';
import { updateKeyed } from './create-keyed-slice';
import { snapshotStreamBuffer, type StreamBufferSnapshot } from './stream-invalidator';
import { renderMarkdown } from '../utils/markdown';
import { splitAssistantMeta } from '../utils/assistant-meta-parser';
import { parseBashInvokesFromContent } from '../utils/message-parser';
import type { ChatMessage, ContentBlock } from './chat-types';
import { readMessageLiveVersion } from './message-live-version';
import type { Session } from '../types';

//

let _switchVersion = 0;
let _switchAbortController: AbortController | null = null;

function invalidateSessionSwitches(): void {
  _switchVersion += 1;
  _switchAbortController?.abort();
  _switchAbortController = null;
  useStore.setState({ pendingSessionSwitchPath: null });
}

function isCurrentSwitch(version: number, path: string): boolean {
  const state = useStore.getState() as Record<string, any>;
  return version === _switchVersion && state.pendingSessionSwitchPath === path;
}

function isAbortError(err: unknown): boolean {
  return !!err && typeof err === 'object' && (
    (err as { name?: string }).name === 'AbortError' ||
    (err as { message?: string }).message === 'This operation was aborted'
  );
}

function isPendingNewSessionDraftView(): boolean {
  const state = useStore.getState() as Record<string, any>;
  return state.pendingNewSession === true
    && state.currentSessionPath === null
    && !state.pendingSessionSwitchPath;
}

function reconcileStreamingSessionsForPath(
  state: Record<string, any>,
  streamingSessions: string[] | undefined,
  path: string,
  isStreaming: boolean,
): string[] {
  const current = Array.isArray(streamingSessions) ? streamingSessions : [];
  const key = sessionScopedKey(state, path) || path;
  const withoutLegacy = current.filter((item) => item !== key && item !== path);
  if (isStreaming) {
    return [...withoutLegacy, key];
  }
  return withoutLegacy;
}

function normalizeSessionId(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeSessionPath(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

type SessionSwitchInput = string | Pick<Session, 'path' | 'id' | 'sessionId'> | { path?: unknown; sessionPath?: unknown; id?: unknown; sessionId?: unknown };

function normalizeSessionSwitchInput(input: SessionSwitchInput): { path: string | null; sessionId: string | null } {
  if (typeof input === 'string') return { path: normalizeSessionPath(input), sessionId: null };
  if (!input || typeof input !== 'object') return { path: null, sessionId: null };
  const record = input as Record<string, unknown>;
  return {
    path: normalizeSessionPath(record.path) || normalizeSessionPath(record.sessionPath),
    sessionId: normalizeSessionId(record.sessionId) || normalizeSessionId(record.id),
  };
}

function normalizeSessionListRows(data: unknown): Session[] {
  if (!Array.isArray(data)) return [];
  return data
    .filter((item): item is Record<string, any> => !!item && typeof item === 'object')
    .map((item) => {
      const sessionId = normalizeSessionId(item.sessionId) || normalizeSessionId(item.id);
      return sessionId ? { ...item, sessionId } as Session : item as Session;
    });
}

function sessionIdForPathFromState(state: Record<string, any>, path: string | null): string | null {
  if (!path) return null;
  if (normalizeSessionId(state.currentSessionId) && state.currentSessionPath === path) {
    return normalizeSessionId(state.currentSessionId);
  }
  const session = (state.sessions || []).find((item: any) => item?.path === path);
  const sessionId = normalizeSessionId(session?.sessionId);
  if (sessionId) return sessionId;
  for (const [id, locator] of Object.entries(state.sessionLocatorsById || {})) {
    if ((locator as { path?: unknown })?.path === path) return id;
  }
  return null;
}

function currentSessionIdentityPatch(state: Record<string, any>, path: string | null, sessionId: unknown): Record<string, any> {
  const normalizedSessionId = normalizeSessionId(sessionId) || sessionIdForPathFromState(state, path);
  return {
    currentSessionPath: path,
    currentSessionId: normalizedSessionId,
    ...(normalizedSessionId ? {
      sessionLocatorsById: {
        ...(state.sessionLocatorsById || {}),
        [normalizedSessionId]: { path },
      },
    } : {}),
  };
}

function sessionMessagesUrl(path: string, extra: Record<string, string> = {}): string {
  const state = useStore.getState() as Record<string, any>;
  const params = new URLSearchParams();
  params.set('path', path);
  const sessionId = sessionIdForPathFromState(state, path);
  if (sessionId) params.set('sessionId', sessionId);
  for (const [key, value] of Object.entries(extra)) {
    params.set(key, value);
  }
  return `/api/sessions/messages?${params.toString()}`;
}

async function requestActiveSessionStreamResume(path: string, isStreaming: boolean): Promise<void> {
  if (!isStreaming) return;
  try {
    const { requestStreamResume } = await import('../services/stream-resume');
    requestStreamResume(path);
  } catch (err) {
    console.warn('[session] stream resume request skipped after switch:', err);
  }
}

function translate(key: string, fallback: string): string {
  const value = typeof window !== 'undefined' ? window.t?.(key) : undefined;
  return !value ? fallback : value;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err || translate('common.error', 'Error'));
}

function dispatchPlanMode(detail: { enabled: boolean; mode: string }): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('gsap-plan-mode', { detail }));
}

function notifySessionCreateFailed(error: unknown): void {
  const message = error instanceof Error
    ? error.message
    : String(error || translate('session.createFailed', 'Failed to create session'));
  useStore.getState().addToast?.(message, 'error', 6000, {
    dedupeKey: 'session-create-failed',
  });
}

function markSessionCreateFailed(error: unknown): void {
  useStore.setState({
    pendingNewSession: false,
    welcomeVisible: true,
  });
  notifySessionCreateFailed(error);
}

// ══════════════════════════════════════════════════════
//

export async function loadMessages(forPath?: string): Promise<void> {
  const targetPath = forPath || useStore.getState().currentSessionPath;
  if (!targetPath) return;
  const messageLiveVersionBefore = readMessageLiveVersion(targetPath);
  // Capture live version before hydration to avoid overwriting newer todo updates.
  const stateAtStart = useStore.getState() as Record<string, any>;
  const todosLiveVersionBefore =
    sessionScopedValue(stateAtStart, stateAtStart.todosLiveVersionBySession, targetPath) ?? 0;
  // Guard rapid session switches so only the latest load may apply.
  const bumpLoadMessagesVersion = useStore.getState().bumpLoadMessagesVersion;
  const myVersion = typeof bumpLoadMessagesVersion === 'function'
    ? bumpLoadMessagesVersion(targetPath)
    : 0;
  try {
    const res = await gsapFetch(sessionMessagesUrl(targetPath));
    const data = await res.json();
    const latestState = useStore.getState() as Record<string, any>;
    const latestVersion =
      sessionScopedValue(latestState, latestState._loadMessagesVersion, targetPath)
      ?? latestState._loadMessagesVersion?.[targetPath]
      ?? myVersion;
    if (latestVersion !== myVersion) {
      // A newer loadMessages call is in flight; ignore this stale response.
      return;
    }
    const messageLiveVersionNow = readMessageLiveVersion(targetPath);
    if (messageLiveVersionNow !== messageLiveVersionBefore) {
      console.log(
        '[loadMessages] 跳过 session hydrate: mid-flight 收到 live message 更新',
        targetPath,
      );
      return;
    }
    const todosLiveVersionNow =
      sessionScopedValue(useStore.getState() as Record<string, any>, useStore.getState().todosLiveVersionBySession, targetPath) ?? 0;
    if (todosLiveVersionNow !== todosLiveVersionBefore) {
      console.log(
        '[loadMessages] 跳过 session hydrate: mid-flight 收到 live todo 更新',
        targetPath,
      );
      return;
    }
 // per-session todos（防御兼容层：即使后端漏转或缓存残留，这里兜底再转一次）
    const rawTodos = data.todos || [];
    const migratedTodos = migrateLegacyTodos({ todos: rawTodos });
    const items = buildItemsFromHistory(data);
    const revision = typeof data.revision === 'string' ? data.revision : null;
    useStore.getState().setSessionRegistryFiles?.(
      targetPath,
      Array.isArray(data.sessionFiles) ? data.sessionFiles : [],
    );
    useStore.getState().setSessionTodosForPath?.(targetPath, migratedTodos);
    useStore.getState().setSessionCapabilityDrift?.(targetPath, data.capabilityDrift || null);
    if (items.length > 0) {
      useStore.getState().initSession?.(targetPath, items, data.hasMore ?? false, revision);
      if (targetPath === useStore.getState().currentSessionPath) {
        useStore.setState({ welcomeVisible: false });
      }
    } else {
      useStore.getState().initSession?.(targetPath, [], false, revision);
    }
    const snapshot = snapshotStreamBuffer(targetPath);
    if (snapshot?.hasContent) {
      useStore.getState().appendItem?.(targetPath, {
        type: 'message',
        data: buildInflightAssistantMessage(snapshot),
      });
    }
  } catch (err) { console.error('[loadMessages] error:', err); }
}

const _revisionReconcileInFlight = new Map<string, Promise<void>>();

export function reconcileCurrentSessionMessages(reason = 'unknown'): Promise<void> | undefined {
  const s = useStore.getState() as Record<string, any>;
  const target = normalizeSessionPath(s.currentSessionPath);
  if (!target || s.pendingNewSession || s.pendingSessionSwitchPath) return undefined;

  const sessionKey = sessionScopedKey(s, target) || target;
  const streamingSessions = Array.isArray(s.streamingSessions) ? s.streamingSessions : [];
  if (streamingSessions.includes(sessionKey) || streamingSessions.includes(target)) return undefined;

  const cached = sessionScopedValue(s, s.chatSessions || {}, target) as { revision?: string | null } | undefined;
  if (!cached) return undefined;

  const currentSessionId = normalizeSessionId(s.currentSessionId);
  const projection = Array.isArray(s.sessions)
    ? s.sessions.find((session: any) => (
        session?.path === target
        || (!!currentSessionId && normalizeSessionId(session?.sessionId) === currentSessionId)
      ))
    : null;
  const listRevision = typeof projection?.revision === 'string' ? projection.revision : null;
  if (!listRevision) return undefined;
  if ((cached.revision ?? null) === listRevision) return undefined;

  const existing = _revisionReconcileInFlight.get(sessionKey);
  if (existing) return existing;

  const inFlight = loadMessages(target)
    .catch((err) => {
      console.warn(`[session] revision reconcile failed (${reason}):`, err);
    })
    .finally(() => {
      _revisionReconcileInFlight.delete(sessionKey);
    });
  _revisionReconcileInFlight.set(sessionKey, inFlight);
  return inFlight;
}

function buildInflightAssistantMessage(snap: StreamBufferSnapshot): ChatMessage {
  const blocks: ContentBlock[] = [];
  const visibleMeta = splitAssistantMeta(
    snap.text.replace(/<tool_code>[\s\S]*?<\/tool_code>\s*/g, ''),
  );
  const thinking = [snap.thinking, visibleMeta.thinking].filter(Boolean).join('\n');
  if (thinking || snap.inThinking) {
    blocks.push({ type: 'thinking', content: thinking, sealed: !snap.inThinking });
  }
  const mood = [snap.mood, visibleMeta.mood].filter(Boolean).join('\n');
  const moodYuan = visibleMeta.moodYuan || snap.moodYuan;
  if (mood) {
    blocks.push({ type: 'mood', yuan: moodYuan, text: mood });
  }
  if (snap.text) {
    const displayText = visibleMeta.text;
    for (const segment of parseBashInvokesFromContent(displayText).segments) {
      if (segment.type === 'text') {
        blocks.push({ type: 'text', html: renderMarkdown(segment.text), source: segment.text });
      } else {
        blocks.push({ type: 'invoke', name: segment.name, content: segment.content });
      }
    }
  }
  return { id: snap.messageId || `inflight-${Date.now()}`, role: 'assistant', blocks };
}

export async function completeSessionTodos(sessionPath: string): Promise<boolean> {
  if (!sessionPath) return false;
  const state = useStore.getState();
  const sessionKey = sessionScopedKey(state as Record<string, any>, sessionPath) || sessionPath;
  if (state.streamingSessions.includes(sessionKey) || state.streamingSessions.includes(sessionPath)) return false;

  try {
    await gsapFetch('/api/sessions/todos/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: sessionPath,
        ...(sessionKey !== sessionPath ? { sessionId: sessionKey } : {}),
      }),
    });
    useStore.getState().setSessionTodosForPath(sessionPath, []);
    useStore.getState().bumpTodosLiveVersion(sessionPath);
    return true;
  } catch (err) {
    useStore.getState().addToast(errorMessage(err), 'error', 6000);
    return false;
  }
}

/** 上滑加载更早的消息（分页-*/
export async function loadMoreMessages(forPath?: string): Promise<void> {
  const targetPath = forPath || useStore.getState().currentSessionPath;
  if (!targetPath) return;
  const state = useStore.getState();
  const session = sessionScopedValue(state, state.chatSessions, targetPath);
  if (!session || !session.hasMore || session.loadingMore) return;

  useStore.getState().setLoadingMore(targetPath, true);
  try {
    const before = session.oldestId ?? '';
    const res = await gsapFetch(sessionMessagesUrl(targetPath, { before }));
    const data = await res.json();
    if (Array.isArray(data.sessionFiles)) {
      useStore.getState().setSessionRegistryFiles(targetPath, data.sessionFiles);
    }
    const items = buildItemsFromHistory(data);
    if (items.length > 0) {
      useStore.getState().prependItems(targetPath, items, data.hasMore ?? false);
    } else {
      useStore.getState().setLoadingMore(targetPath, false);
    }
  } catch (err) {
    console.error('[loadMoreMessages] error:', err);
    useStore.getState().setLoadingMore(targetPath, false);
  }
}

// ══════════════════════════════════════════════════════
// Session 列表
// ══════════════════════════════════════════════════════

export async function loadSessions(): Promise<void> {
  try {
    const res = await gsapFetch('/api/sessions');
    const data = await res.json();
    const sessions = normalizeSessionListRows(data);

    const s = useStore.getState();
    if (typeof useStore.getState().setSessions === 'function') {
      useStore.getState().setSessions(sessions);
    } else {
      useStore.setState({ sessions });
    }

    if (sessions.length > 0 && !s.currentSessionPath && !s.pendingNewSession && !s.pendingSessionSwitchPath) {
 // 首次加载：走完整-switchSession 确保后端同步 + 消息加载
      await switchSession(sessions[0].path);
    } else {
      void reconcileCurrentSessionMessages('loadSessions');
    }
  } catch { /* ignore */ }
}

// ══════════════════════════════════════════════════════
// Session 切换
// ══════════════════════════════════════════════════════

export async function switchSession(input: SessionSwitchInput): Promise<void> {
  const normalizedInput = normalizeSessionSwitchInput(input);
  const path = normalizedInput.path;
  if (!path) return;
  const s = useStore.getState();
  const myVersion = ++_switchVersion;
  _switchAbortController?.abort();
  _switchAbortController = null;

  if (path === s.currentSessionPath && !s.pendingNewSession) {
    useStore.setState({ pendingSessionSwitchPath: null });
    return;
  }

  useStore.setState({ pendingSessionSwitchPath: path });

  //
  const activePanel = useStore.getState().activePanel;
  if (activePanel === 'activity' || activePanel === 'automation') {
    useStore.getState().setActivePanel(null);
  }

  const abortController = new AbortController();
  _switchAbortController = abortController;

  try {
    const res = await gsapFetch('/api/sessions/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path,
        ...(normalizedInput.sessionId || sessionIdForPathFromState(s as Record<string, any>, path) ? {
          sessionId: normalizedInput.sessionId || sessionIdForPathFromState(s as Record<string, any>, path),
        } : {}),
        currentSessionPath: s.currentSessionPath,
      }),
      signal: abortController.signal,
    });
    const data = await res.json();
    if (!isCurrentSwitch(myVersion, path)) return;
    if (data.error) {
      console.error('[session] switch failed:', data.error);
      useStore.setState((state: Record<string, any>) => (
        state.pendingSessionSwitchPath === path ? { pendingSessionSwitchPath: null } : {}
      ));
      return;
    }

    const resolvedPath = normalizeSessionPath(data.path) || normalizeSessionPath(data.sessionPath) || path;
    const state = useStore.getState();
    const resolvedSessionId = normalizeSessionId(data.sessionId)
      || sessionIdForPathFromState(state as Record<string, any>, path)
      || sessionIdForPathFromState(state as Record<string, any>, resolvedPath);
    const resolvedSessions = Array.isArray(state.sessions)
      ? state.sessions.map((item: any) => {
        const itemSessionId = normalizeSessionId(item?.sessionId);
        const matchesInputPath = item?.path === path;
        const matchesSessionId = !!resolvedSessionId && itemSessionId === resolvedSessionId;
        if (!matchesInputPath && !matchesSessionId) return item;
        const nextItem = {
          ...item,
          path: resolvedPath,
        };
        const nextSessionId = resolvedSessionId || itemSessionId;
        if (nextSessionId) nextItem.sessionId = nextSessionId;
        else delete nextItem.sessionId;
        return nextItem;
      })
      : state.sessions;

    // 以服务端事实对齐当前 session 的流式状态。刷新或重连后，renderer 的本地集合可能已经过期。
    const isStreaming = data.isStreaming === true;
    const streamingSessions = reconcileStreamingSessionsForPath(
      state as Record<string, any>,
      toStringArray(state.streamingSessions),
      resolvedPath,
      isStreaming,
    );
    await requestActiveSessionStreamResume(resolvedPath, isStreaming);
    if (myVersion !== _switchVersion) return;

    // Sync global agent context.
    const switchedAgent = data.agentId && data.agentId !== state.currentAgentId;
    const agentPatch: Record<string, any> = {};

    if (switchedAgent) {
      const ag = state.agents.find((a: any) => a.id === data.agentId);
      agentPatch.currentAgentId = data.agentId;
      agentPatch.agentName = data.agentName || ag?.name || data.agentId;
      agentPatch.agentYuan = normalizeYuanKey(ag?.yuan);
      agentPatch.agentAvatarUrl = ag?.hasAvatar ? gsapUrl(`/api/agents/${data.agentId}/avatar?t=${Date.now()}`, { includeTokenQuery: true }) : null;
    }

 // 保存当前 session 的附件到 keyed store
    const currentPath = s.currentSessionPath;
    const currentAttachments = Array.isArray(state.attachedFiles) ? state.attachedFiles : [];
    if (currentPath && currentAttachments.length) {
      useStore.setState(prev => ({
        attachedFilesBySession: { ...(prev.attachedFilesBySession || {}), [currentPath]: currentAttachments },
      }));
    }

    // Batch-update store for the switched session.
    useStore.setState({
      ...currentSessionIdentityPatch(state as Record<string, any>, resolvedPath, resolvedSessionId),
      sessions: resolvedSessions,
      pendingSessionSwitchPath: null,
      pendingNewSession: false,
      pendingProjectId: null,
      selectedFolder: null,
      workspaceFolders: Array.isArray(data.workspaceFolders) ? data.workspaceFolders : [],
      selectedAgentId: null,
      welcomeVisible: false,
      memoryEnabled: data.memoryEnabled !== false,
      streamingSessions,
      attachedFiles: state.attachedFilesBySession?.[resolvedPath] || state.attachedFilesBySession?.[path] || [],
      deskContextAttached: false,
      docContextAttached: false,
      ...agentPatch,
    });
    useStore.getState().setSessionCapabilityDrift?.(resolvedPath, data.capabilityDrift || null);

    const restoredDeskState = useStore.getState().getDeskStateForOwner?.(resolvedPath);
    useStore.getState().restoreDeskStateForOwner?.(resolvedPath);

 // 同步浏览器状态到 keyed store（服务端返回当前 session -browser 状）
    if (resolvedPath) {
      updateKeyed('browserBySession', resolvedPath, {
        running: !!data.browserRunning,
        url: data.browserUrl || null,
        thumbnail: data.browserRunning
          ? (state.browserBySession[resolvedPath]?.thumbnail ?? state.browserBySession[path]?.thumbnail ?? null)
          : null,
      });
    }

    // Sync panel visibility for the target session tab state.
    syncPreviewPanelForOwner(resolvedPath);
    useStore.getState().clearQuotedSelection();

    // Sync plan mode for the switched-to session
    dispatchPlanMode({
      enabled: data.permissionMode === 'read_only' || data.accessMode === 'read_only' || data.planMode === true,
      mode: data.permissionMode || data.accessMode || (data.planMode ? 'read_only' : 'operate'),
    });

 //
    if (data.thinkingLevel) {
      useStore.getState().setThinkingLevel(data.thinkingLevel);
    }

    // Hydrate per-session model snapshot from switch response
    if (data.currentModelId && data.currentModelProvider) {
      useStore.getState().updateSessionModel(resolvedPath, {
        id: data.currentModelId,
        name: data.currentModelName || data.currentModelId,
        provider: data.currentModelProvider,
        input: Array.isArray(data.currentModelInput) ? data.currentModelInput : undefined,
        video: data.currentModelVideo ?? undefined,
        videoTransport: data.currentModelVideoTransport ?? undefined,
        videoTransportSupported: data.currentModelVideoTransportSupported ?? undefined,
        audio: data.currentModelAudio ?? undefined,
        audioTransport: data.currentModelAudioTransport ?? undefined,
        audioTransportSupported: data.currentModelAudioTransportSupported ?? undefined,
        reasoning: data.currentModelReasoning ?? undefined,
        xhigh: data.currentModelXhigh === true,
        thinkingLevels: Array.isArray(data.currentModelThinkingLevels) ? data.currentModelThinkingLevels : undefined,
        defaultThinkingLevel: data.currentModelDefaultThinkingLevel ?? undefined,
        contextWindow: data.currentModelContextWindow ?? undefined,
      });
    }

    loadModels({ sessionPath: resolvedPath });

    // Load messages when the store does not yet have this session data.
    const hasData = !!sessionScopedValue(
      useStore.getState() as Record<string, any>,
      useStore.getState().chatSessions || {},
      resolvedPath,
    );
    if (hasData) {
      void reconcileCurrentSessionMessages('session_switch');
    }
    if (!hasData) {
      await loadMessages(resolvedPath);
      if (myVersion !== _switchVersion) return;
    }

    // Load Desk files with the switched session cwd.
    loadDeskFiles(restoredDeskState?.deskCurrentPath || '', data.cwd || undefined);

 //
    useStore.setState({ contextTokens: null, contextWindow: null, contextPercent: null });
    import('../services/websocket').then(({ getWebSocket }) => {
      const wsConn = getWebSocket();
      if (wsConn?.readyState === WebSocket.OPEN) {
        const latest = useStore.getState() as Record<string, any>;
        wsConn.send(JSON.stringify({
          type: 'context_usage',
          sessionPath: resolvedPath,
          ...(latest.currentSessionId ? { sessionId: latest.currentSessionId } : {}),
        }));
      }
    }).catch((err) => {
      console.warn('[session] context usage refresh skipped:', err);
    });
  } catch (err) {
    if (myVersion !== _switchVersion || isAbortError(err)) return;
    useStore.setState((state: Record<string, any>) => (
      state.pendingSessionSwitchPath === path ? { pendingSessionSwitchPath: null } : {}
    ));
    console.error('[session] switch failed:', err);
  } finally {
    if (_switchAbortController === abortController) {
      _switchAbortController = null;
    }
  }
}

// ══════════════════════════════════════════════════════
// 新建 Session
// ══════════════════════════════════════════════════════

interface CreateNewSessionOptions {
  projectId?: string | null;
  cwd?: string | null;
}

export async function createNewSession(options: unknown = {}): Promise<void> {
  invalidateSessionSwitches();

  //
  if (useStore.getState().activePanel === 'activity') {
    useStore.getState().setActivePanel(null);
  }

  const opts = options && typeof options === 'object' && !('currentTarget' in options)
    ? options as CreateNewSessionOptions
    : {};
  const s = useStore.getState();
  const requestedFolder = typeof opts.cwd === 'string' && opts.cwd.trim() ? opts.cwd.trim() : null;
  const selectedFolder = requestedFolder || s.homeFolder || null;
  const pendingProjectId = typeof opts.projectId === 'string' && opts.projectId.trim()
    ? opts.projectId.trim()
    : null;

  useStore.setState({
    welcomeVisible: true,
    currentSessionPath: null,
    currentSessionId: null,
    selectedFolder,
    workspaceFolders: [],
    selectedAgentId: null,
    pendingNewSession: true,
    pendingProjectId,
    pendingNewSessionThinkingLevel: null,
    attachedFiles: [],
    deskContextAttached: false,
    docContextAttached: false,
  });

  // 重置 context ring
  useStore.setState({ contextTokens: null, contextWindow: null, contextPercent: null });
  try {
    const res = await gsapFetch('/api/session-permission-mode');
    const data = await res.json();
    const mode = data.defaultMode || data.mode || 'ask';
    dispatchPlanMode({ enabled: mode === 'read_only', mode });
  } catch {
    dispatchPlanMode({ enabled: false, mode: 'ask' });
  }

  try {
    const res = await gsapFetch('/api/session-thinking-level');
    const data = await res.json();
    if (data.thinkingLevel && isPendingNewSessionDraftView()) {
      useStore.getState().setThinkingLevel(data.thinkingLevel);
      useStore.getState().setPendingNewSessionThinkingLevel(data.thinkingLevel);
    }
  } catch {
    useStore.getState().setPendingNewSessionThinkingLevel(null);
  }

 //

 //

  const currentState = useStore.getState();
  loadDeskFiles('', currentState.selectedFolder || currentState.homeFolder || undefined);

 // pending 状下刷新 model 列表，让 ModelSelector 显示 agent Chat 默认 model
  loadModels();

  useStore.getState().requestInputFocus();
}

// ══════════════════════════════════════════════════════
// 确保 Session 存在（首次发消息时调用）
// ══════════════════════════════════════════════════════

export async function ensureSession(): Promise<boolean> {
  const s = useStore.getState();
  if (s.currentSessionPath) {
    if (s.pendingNewSession) {
      useStore.setState({
        pendingNewSession: false,
        pendingProjectId: null,
        pendingNewSessionThinkingLevel: null,
        welcomeVisible: false,
      });
    }
    return true;
  }
  if (!s.pendingNewSession) {
    useStore.setState({ pendingNewSession: true });
  }

  try {
    const body: Record<string, any> = { memoryEnabled: s.memoryEnabled };
    const targetFolder = s.selectedFolder || s.homeFolder || null;
    if (targetFolder) {
      body.cwd = targetFolder;
    }
    if (s.workspaceFolders?.length) {
      body.workspaceFolders = s.workspaceFolders;
    }
    if (s.pendingProjectId) {
      body.projectId = s.pendingProjectId;
    }
    if (s.pendingNewSessionThinkingLevel) {
      body.thinkingLevel = s.pendingNewSessionThinkingLevel;
    }
    if (s.selectedAgentId && s.selectedAgentId !== s.currentAgentId) {
      body.agentId = s.selectedAgentId;
    }
    body.currentSessionPath = s.currentSessionPath;

    const res = await gsapFetch('/api/sessions/new', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.error) {
      console.error('[session] create failed:', data.error);
      markSessionCreateFailed(data.error);
      return false;
    }
    const newSessionPath = typeof data.path === 'string' && data.path.trim()
      ? data.path.trim()
      : typeof data.sessionPath === 'string' && data.sessionPath.trim()
        ? data.sessionPath.trim()
        : null;
    if (!newSessionPath) {
      const err = new Error('Session create response missing path');
      console.error('[session] create failed:', err.message);
      markSessionCreateFailed(err);
      return false;
    }

    const justSelected = targetFolder;

    // Apply base session state patch.
    const patch: Record<string, any> = {
      pendingNewSession: false,
      selectedFolder: null,
      pendingProjectId: null,
      pendingNewSessionThinkingLevel: null,
      workspaceFolders: Array.isArray(data.workspaceFolders) ? data.workspaceFolders : [],
      selectedAgentId: null,
      welcomeVisible: false,
    };

    if (data.agentId) {
      const switched = data.agentId !== s.currentAgentId;
      patch.currentAgentId = data.agentId;
      if (data.agentName) patch.agentName = data.agentName;
      if (switched) {
        const ag = s.agents.find((a: any) => a.id === data.agentId);
        if (ag?.yuan) patch.agentYuan = ag.yuan;
        patch.agentAvatarUrl = null;
        window.i18n.defaultName = data.agentName || s.agentName;
 // 异步刷新头像
        gsapFetch('/api/health').then((r: Response) => r.json()).then((d: any) => {
          loadAvatarsAction(d.avatars);
        }).catch(() => {
          loadAvatarsAction();
        });
      }
    }

    if (newSessionPath) {
      useStore.getState().cloneDeskStateToOwner?.(newSessionPath);
      Object.assign(
        patch,
        currentSessionIdentityPatch(useStore.getState() as Record<string, any>, newSessionPath, data.sessionId),
      );
 // 初始化空 session，ChatArea 自动渲染
      useStore.getState().initSession(newSessionPath, [], false);
    }

    useStore.setState(patch);
    if (data.thinkingLevel) {
      useStore.getState().setThinkingLevel(data.thinkingLevel);
    }
    if (newSessionPath) {
      useStore.getState().restoreDeskStateForOwner?.(newSessionPath);
    }

    // New session defaults to plan mode OFF
    dispatchPlanMode({
      enabled: data.permissionMode === 'read_only' || data.accessMode === 'read_only' || data.planMode === true,
      mode: data.permissionMode || data.accessMode || (data.planMode ? 'read_only' : 'operate'),
    });

    void loadSessions();

 //
    loadModels();

 //

    // Update cwdHistory.
    if (justSelected) {
      const currentState = useStore.getState();
      const historySource = Array.isArray(currentState.cwdHistory) ? currentState.cwdHistory : [];
      let cwdHistory = historySource.filter((p: string) => p !== justSelected);
      cwdHistory = [justSelected, ...cwdHistory];
      if (cwdHistory.length > 10) cwdHistory = cwdHistory.slice(0, 10);
      useStore.setState({ cwdHistory });
    }

    const restoredDeskState = newSessionPath
      ? useStore.getState().getDeskStateForOwner?.(newSessionPath)
      : null;
    loadDeskFiles(restoredDeskState?.deskCurrentPath || '', data.cwd || undefined);

    return true;
  } catch (err) {
    console.error('[session] create failed:', err);
    markSessionCreateFailed(err);
    return false;
  }
}

// ══════════════════════════════════════════════════════
// 归档 Session
// ══════════════════════════════════════════════════════

export async function archiveSession(path: string): Promise<void> {
  try {
    const res = await gsapFetch('/api/sessions/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    });
    const data = await res.json();
    if (data.error) {
      console.error('[session] archive failed:', data.error);
      showSidebarToast(window.t('session.archiveFailed'));
      return;
    }

    const s = useStore.getState();
    if (path === s.currentSessionPath) {
      useStore.setState({ currentSessionPath: null });
      clearChatAction();
    }

    await loadSessions();

    const updated = useStore.getState();
    if (updated.sessions.length === 0) {
      await createNewSession();
    } else if (!updated.currentSessionPath) {
      await switchSession(updated.sessions[0].path);
    }
  } catch (err) {
    console.error('[session] archive failed:', err);
    showSidebarToast(window.t('session.archiveFailed'));
  }
}

// ══════════════════════════════════════════════════════
//
// ══════════════════════════════════════════════════════

function dropKey<T>(source: Record<string, T> | undefined, key: string): Record<string, T> {
  const next = { ...(source || {}) };
  delete next[key];
  return next;
}

function dropSessionPreviews(
  source: Record<string, { sessionPath?: string | null }> | undefined,
  sessionPath: string,
) {
  const next: Record<string, { sessionPath?: string | null }> = {};
  for (const [taskId, entry] of Object.entries(source || {})) {
    if (entry?.sessionPath === sessionPath) continue;
    next[taskId] = entry;
  }
  return next;
}

function dropQuotedSelectionsForSession(value: unknown, sessionPath: string): any[] {
  if (!Array.isArray(value)) return [];
  return value.filter((selection: any) => selection?.sourceSessionPath !== sessionPath);
}

function purgeDeletedSessionState(sessionPath: string): void {
  useStore.getState().clearSession?.(sessionPath);
  useStore.setState((state: any) => {
    const traceIds = toStringArray(state.runtimeTimelineTraceIdsBySession?.[sessionPath]);
    const runtimeTimelineByTrace = { ...(state.runtimeTimelineByTrace || {}) };
    for (const traceId of traceIds) delete runtimeTimelineByTrace[traceId];

    const quotedSelections = dropQuotedSelectionsForSession(state.quotedSelections, sessionPath);
    const patch: Record<string, any> = {
      sessions: Array.isArray(state.sessions)
        ? state.sessions.filter((session: any) => session?.path !== sessionPath)
        : [],
      chatSessions: dropKey(state.chatSessions, sessionPath),
      sessionRegistryFilesByPath: dropKey(state.sessionRegistryFilesByPath, sessionPath),
      sessionModelsByPath: dropKey(state.sessionModelsByPath, sessionPath),
      _loadMessagesVersion: dropKey(state._loadMessagesVersion, sessionPath),
      scrollPositions: dropKey(state.scrollPositions, sessionPath),
      sessionStreams: dropKey(state.sessionStreams, sessionPath),
      todosBySession: dropKey(state.todosBySession, sessionPath),
      todosLiveVersionBySession: dropKey(state.todosLiveVersionBySession, sessionPath),
      attachedFilesBySession: dropKey(state.attachedFilesBySession, sessionPath),
      drafts: dropKey(state.drafts, sessionPath),
      editorDrafts: dropKey(state.editorDrafts, sessionPath),
      browserBySession: dropKey(state.browserBySession, sessionPath),
      contextBySession: dropKey(state.contextBySession, sessionPath),
      inlineErrors: dropKey(state.inlineErrors, sessionPath),
      deskStateByOwner: dropKey(state.deskStateByOwner, sessionPath),
      selectedIdsBySession: dropKey(state.selectedIdsBySession, sessionPath),
      computerOverlayBySession: dropKey(state.computerOverlayBySession, sessionPath),
      previewByOwner: dropKey(state.previewByOwner, sessionPath),
      runtimeTimelineByTrace,
      runtimeTimelineTraceIdsBySession: dropKey(state.runtimeTimelineTraceIdsBySession, sessionPath),
      subagentPreviewByTaskId: dropSessionPreviews(state.subagentPreviewByTaskId, sessionPath),
      streamingSessions: toStringArray(state.streamingSessions).filter(p => p !== sessionPath),
      compactingSessions: toStringArray(state.compactingSessions).filter(p => p !== sessionPath),
      capabilityDriftBySession: dropKey(state.capabilityDriftBySession, sessionPath),
      capabilityRefreshingSessions: toStringArray(state.capabilityRefreshingSessions).filter(p => p !== sessionPath),
    };

    if (quotedSelections.length !== (Array.isArray(state.quotedSelections) ? state.quotedSelections.length : 0)) {
      patch.quotedSelections = quotedSelections;
      patch.quotedSelection = quotedSelections[0] || null;
    }
    if (state.quoteCandidate?.sourceSessionPath === sessionPath) {
      patch.quoteCandidate = null;
    }
    if (state.currentSessionPath === sessionPath) {
      patch.currentSessionPath = null;
      patch.sessionTodos = [];
      patch.attachedFiles = [];
      patch.deskContextAttached = false;
      patch.docContextAttached = false;
      patch.contextTokens = null;
      patch.contextWindow = null;
      patch.contextPercent = null;
    }

    return patch;
  });
}

export async function deleteSession(input: SessionSwitchInput): Promise<void> {
  const normalizedInput = normalizeSessionSwitchInput(input);
  const path = normalizedInput.path;
  const stateBeforeDelete = useStore.getState() as Record<string, any>;
  const sessionId = normalizedInput.sessionId || sessionIdForPathFromState(stateBeforeDelete, path);
  if (!path && !sessionId) return;
  try {
    const res = await gsapFetch('/api/sessions/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(path ? { path } : {}),
        ...(sessionId ? { sessionId } : {}),
      }),
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      console.error('[session] delete failed:', data.error || res.statusText);
      showSidebarToast(translate('session.deleteFailed', 'Failed to delete session'));
      return;
    }

    const wasCurrentSession = path === useStore.getState().currentSessionPath
      || (!!sessionId && sessionId === normalizeSessionId((useStore.getState() as Record<string, any>).currentSessionId));
    if (path) purgeDeletedSessionState(path);
    if (wasCurrentSession) {
      clearChatAction();
    }

    await loadSessions();

    const updated = useStore.getState();
    if (updated.sessions.length === 0) {
      await createNewSession();
    } else if (!updated.currentSessionPath) {
      await switchSession(updated.sessions[0].path);
    }
  } catch (err) {
    console.error('[session] delete failed:', err);
    showSidebarToast(translate('session.deleteFailed', 'Failed to delete session'));
  }
}

export async function continueDeletedAgentSession(path: string): Promise<boolean> {
  try {
    const res = await gsapFetch('/api/sessions/continue-deleted-agent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    });
    const data = await res.json();
    if (!res.ok || data.error || !data.path) {
      const message = data.error || res.statusText || 'continue failed';
      console.error('[session] continue deleted-agent session failed:', message);
      useStore.getState().addToast?.(
        `${translate('session.deletedAgent.continueFailed', 'Failed to continue deleted-agent session')}: ${message}`,
        'error',
        6000,
      );
      return false;
    }

    await loadSessions();
    await switchSession(data.path);
    if (data.compactionError) {
      useStore.getState().addToast?.(
        `${translate('session.deletedAgent.continueCompactionFailed', 'Continuation created, but summarization failed')}: ${data.compactionError}`,
        'warning',
        6000,
      );
    }
    return true;
  } catch (err) {
    console.error('[session] continue deleted-agent session failed:', err);
    useStore.getState().addToast?.(
      `${translate('session.deletedAgent.continueFailed', 'Failed to continue deleted-agent session')}: ${errorMessage(err)}`,
      'error',
      6000,
    );
    return false;
  }
}

export interface ArchivedSession {
  path: string;
  title: string | null;
  archivedAt: string;
  sizeBytes: number;
  agentId: string;
  agentName: string;
}

export type RestoreResult = 'ok' | 'conflict' | 'error';

export async function listArchivedSessions(): Promise<ArchivedSession[]> {
  try {
    const res = await gsapFetch('/api/sessions/archived');
    if (!res.ok) return [];
    return await res.json();
  } catch (err) {
    console.error('[archived] list failed:', err);
    return [];
  }
}

export async function restoreSession(path: string): Promise<RestoreResult> {
  try {
    const res = await gsapFetch('/api/sessions/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    });
    if (res.status === 409) return 'conflict';
    if (!res.ok) return 'error';
    return 'ok';
  } catch (err) {
    console.error('[archived] restore failed:', err);
    return 'error';
  }
}

export async function deleteArchivedSession(path: string): Promise<boolean> {
  try {
    const res = await gsapFetch('/api/sessions/archived/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    });
    return res.ok;
  } catch (err) {
    console.error('[archived] delete failed:', err);
    return false;
  }
}

export async function cleanupArchivedSessions(maxAgeDays: 30 | 90): Promise<{ deleted: number }> {
  try {
    const res = await gsapFetch('/api/sessions/cleanup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxAgeDays }),
    });
    if (!res.ok) return { deleted: 0 };
    const data = await res.json();
    return { deleted: data.deleted ?? 0 };
  } catch (err) {
    console.error('[archived] cleanup failed:', err);
    return { deleted: 0 };
  }
}

// ══════════════════════════════════════════════════════
//
// ══════════════════════════════════════════════════════

export async function renameSession(path: string, title: string): Promise<boolean> {
  try {
    const res = await gsapFetch('/api/sessions/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, title }),
    });
    const data = await res.json();
    if (data.error) {
      console.error('[session] rename failed:', data.error);
      return false;
    }
 // 乐观更新 store 中的 title
    const sessions = useStore.getState().sessions.map(s =>
      s.path === path ? { ...s, title } : s,
    );
    useStore.setState({ sessions });
    return true;
  } catch (err) {
    console.error('[session] rename failed:', err);
    return false;
  }
}

// ══════════════════════════════════════════════════════
// 置顶 / 取消置顶 Session
// ══════════════════════════════════════════════════════

export async function pinSession(path: string, pinned: boolean): Promise<boolean> {
  try {
    const res = await gsapFetch('/api/sessions/pin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, pinned }),
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      console.error('[session] pin failed:', data.error || res.statusText);
      showSidebarToast(window.t(pinned ? 'session.pinFailed' : 'session.unpinFailed'));
      return false;
    }

    const pinnedAt = typeof data.pinnedAt === 'string' ? data.pinnedAt : null;
    const sessions = useStore.getState().sessions.map(s =>
      s.path === path ? { ...s, pinnedAt } : s,
    );
    useStore.setState({ sessions });
    return true;
  } catch (err) {
    console.error('[session] pin failed:', err);
    showSidebarToast(window.t(pinned ? 'session.pinFailed' : 'session.unpinFailed'));
    return false;
  }
}

// ══════════════════════════════════════════════════════
// Toast
// ══════════════════════════════════════════════════════

export async function dismissSessionCapabilityDrift(path: string, fingerprint: string): Promise<boolean> {
  const state = useStore.getState();
  const prevDrift = sessionScopedValue(state, state.capabilityDriftBySession, path) || null;
  useStore.getState().setSessionCapabilityDrift?.(path, null);
  try {
    const res = await gsapFetch('/api/sessions/capability-drift/dismiss', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, fingerprint }),
    });
    if (res.ok) return true;
  } catch (err) {
    console.warn('[session] capability drift dismiss failed:', err);
  }
  useStore.getState().setSessionCapabilityDrift?.(path, prevDrift);
  return false;
}

export async function refreshSessionCapabilities(
  path: string,
  options: { signal?: AbortSignal; timeout?: number; maxAttempts?: number; retryDelayMs?: number } = {},
): Promise<boolean> {
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 3));
  const retryDelayMs = Math.max(0, Math.floor(options.retryDelayMs ?? 600));
  useStore.getState().setSessionCapabilityRefreshing?.(path, true);
  try {
    let data: any = {};
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (options.signal?.aborted) return false;
      const res = await gsapFetch('/api/sessions/fresh-compact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.timeout ? { timeout: options.timeout } : {}),
      });
      data = await res.json().catch(() => ({}));
      if (res.ok && !data.error) break;
      if (attempt >= maxAttempts || !isTransientCapabilityRefreshBusy(res.status, data?.error)) {
        return false;
      }
      await delayCapabilityRefreshRetry(retryDelayMs, options.signal);
    }
    useStore.getState().setSessionCapabilityDrift?.(path, data.capabilityDrift || null);
    await loadMessages(path);
    useStore.getState().setSessionCapabilityDrift?.(path, null);
    return true;
  } catch (err) {
    console.warn('[session] capability refresh failed:', err);
    return false;
  } finally {
    useStore.getState().setSessionCapabilityRefreshing?.(path, false);
  }
}

function isTransientCapabilityRefreshBusy(status: unknown, error: unknown): boolean {
  if (Number(status) !== 409) return false;
  const message = String(error || '').toLowerCase();
  return message.includes('session is streaming')
    || message.includes('already compacting')
    || message.includes('session is busy')
    || message.includes('session_busy')
    || message.includes('reloadsessionruntime: session is busy');
}

function delayCapabilityRefreshRetry(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = globalThis.setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      globalThis.clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

export function showSidebarToast(text: string, duration = 3000): void {
  useStore.getState().addToast(text, 'info', duration);
}
