import type { Session, SessionCapabilityDrift, SessionStream, TodoItem } from '../types';
import type { SessionConfirmationBlock } from './chat-types';
import type { ThinkingLevel } from './model-slice';

function normalizeSessionId(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeSessionPath(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function mergeSessionLocators(
  current: Record<string, { path: string | null }>,
  sessions: Session[],
): Record<string, { path: string | null }> {
  const next = { ...current };
  for (const session of sessions || []) {
    const sessionId = normalizeSessionId(session.sessionId);
    if (!sessionId) continue;
    next[sessionId] = { path: normalizeSessionPath(session.path) };
  }
  return next;
}

export type SessionLocatorState = {
  currentSessionId?: string | null;
  currentSessionPath?: string | null;
  sessions?: Array<Pick<Session, 'path' | 'sessionId'>>;
  sessionLocatorsById?: Record<string, { path: string | null }>;
};

export function sessionIdForPathFromLocatorState(
  state: SessionLocatorState,
  sessionPath: string | null | undefined,
): string | null {
  const path = normalizeSessionPath(sessionPath);
  if (!path) return null;
  const currentSessionId = normalizeSessionId(state.currentSessionId);
  if (currentSessionId && state.currentSessionPath === path) return currentSessionId;
  const session = (state.sessions || []).find((item) => item?.path === path);
  const sessionId = normalizeSessionId(session?.sessionId);
  if (sessionId) return sessionId;
  for (const [id, locator] of Object.entries(state.sessionLocatorsById || {})) {
    if (locator?.path === path) return id;
  }
  return null;
}

export function sessionScopedKey(
  state: SessionLocatorState,
  sessionPath: string | null | undefined,
): string | null {
  const path = normalizeSessionPath(sessionPath);
  if (!path) return null;
  return sessionIdForPathFromLocatorState(state, path) || path;
}

export function sessionScopedValue<T>(
  state: SessionLocatorState,
  map: Record<string, T> | null | undefined,
  sessionPath: string | null | undefined,
): T | undefined {
  if (!map) return undefined;
  const path = normalizeSessionPath(sessionPath);
  if (!path) return undefined;
  const key = sessionScopedKey(state, path);
  if (key && Object.prototype.hasOwnProperty.call(map, key)) return map[key];
  return Object.prototype.hasOwnProperty.call(map, path) ? map[path] : undefined;
}

export function sessionScopedListIncludes(
  state: SessionLocatorState,
  list: readonly string[] | null | undefined,
  sessionPath: string | null | undefined,
): boolean {
  if (!list || !sessionPath) return false;
  const key = sessionScopedKey(state, sessionPath);
  return !!key && (list.includes(key) || (key !== sessionPath && list.includes(sessionPath)));
}

function putSessionScopedListValue(
  state: SessionLocatorState,
  list: readonly string[],
  sessionPath: string,
): string[] {
  const key = sessionScopedKey(state, sessionPath) || sessionPath;
  const next = list.filter((item) => item !== key && item !== sessionPath);
  next.push(key);
  return next;
}

function deleteSessionScopedListValue(
  state: SessionLocatorState,
  list: readonly string[],
  sessionPath: string,
): string[] {
  const key = sessionScopedKey(state, sessionPath) || sessionPath;
  return list.filter((item) => item !== key && item !== sessionPath);
}

function putSessionScopedValue<T>(
  state: SessionLocatorState,
  map: Record<string, T>,
  sessionPath: string,
  value: T,
): Record<string, T> {
  const key = sessionScopedKey(state, sessionPath) || sessionPath;
  const next = { ...map, [key]: value };
  if (key !== sessionPath) delete next[sessionPath];
  return next;
}

function deleteSessionScopedValue<T>(
  state: SessionLocatorState,
  map: Record<string, T>,
  sessionPath: string,
): Record<string, T> {
  const key = sessionScopedKey(state, sessionPath) || sessionPath;
  const next = { ...map };
  delete next[key];
  if (key !== sessionPath) delete next[sessionPath];
  return next;
}

export interface SessionSlice {
  sessions: Session[];
  currentSessionPath: string | null;
  currentSessionId: string | null;
  sessionLocatorsById: Record<string, { path: string | null }>;
  pendingSessionSwitchPath: string | null;
  sessionStreams: Record<string, SessionStream>;
  capabilityDriftBySession: Record<string, SessionCapabilityDrift>;
  capabilityRefreshingSessions: string[];
  pendingSessionConfirmationsByPath: Record<string, SessionConfirmationBlock>;
  pendingNewSession: boolean;
  pendingProjectId: string | null;
  pendingNewSessionThinkingLevel: ThinkingLevel | null;
  memoryEnabled: boolean;
  sessionTodos: TodoItem[];
  todosBySession: Record<string, TodoItem[]>;
  todosLiveVersionBySession: Record<string, number>;
  setSessions: (sessions: Session[]) => void;
  setCurrentSessionPath: (path: string | null) => void;
  setCurrentSessionRef: (ref: { sessionId?: string | null; path?: string | null }) => void;
  setSessionStream: (sessionPath: string, stream: SessionStream) => void;
  setSessionCapabilityDrift: (sessionPath: string, drift: SessionCapabilityDrift | null) => void;
  setSessionCapabilityRefreshing: (sessionPath: string, refreshing: boolean) => void;
  setPendingSessionConfirmation: (sessionPath: string, block: SessionConfirmationBlock | null) => void;
  resolvePendingSessionConfirmation: (confirmId: string) => void;
  removeSessionStream: (sessionPath: string) => void;
  setPendingNewSession: (pending: boolean) => void;
  setPendingNewSessionThinkingLevel: (level: ThinkingLevel | null) => void;
  setMemoryEnabled: (enabled: boolean) => void;
  setSessionTodos: (todos: TodoItem[]) => void;
  setSessionTodosForPath: (sessionPath: string, todos: TodoItem[]) => void;
  bumpTodosLiveVersion: (sessionPath: string) => void;
}

export const createSessionSlice = (
  set: (partial: Partial<SessionSlice> | ((s: SessionSlice) => Partial<SessionSlice>)) => void
): SessionSlice => ({
  sessions: [],
  currentSessionPath: null,
  currentSessionId: null,
  sessionLocatorsById: {},
  pendingSessionSwitchPath: null,
  sessionStreams: {},
  capabilityDriftBySession: {},
  capabilityRefreshingSessions: [],
  pendingSessionConfirmationsByPath: {},
  pendingNewSession: false,
  pendingProjectId: null,
  pendingNewSessionThinkingLevel: null,
  memoryEnabled: true,
  sessionTodos: [],
  todosBySession: {},
  todosLiveVersionBySession: {},
  setSessions: (sessions) => set((s) => ({
    sessions,
    sessionLocatorsById: mergeSessionLocators(s.sessionLocatorsById, sessions),
  })),
  setCurrentSessionPath: (path) => set({
    currentSessionPath: path,
    ...(path === null ? { currentSessionId: null } : {}),
  }),
  setCurrentSessionRef: (ref) => set((s) => {
    const sessionId = normalizeSessionId(ref?.sessionId);
    const sessionPath = normalizeSessionPath(ref?.path);
    return {
      currentSessionId: sessionId,
      currentSessionPath: sessionPath,
      ...(sessionId ? {
        sessionLocatorsById: {
          ...s.sessionLocatorsById,
          [sessionId]: { path: sessionPath },
        },
      } : {}),
    };
  }),
  setSessionStream: (sessionPath, stream) =>
    set((s) => ({
      sessionStreams: putSessionScopedValue(s, s.sessionStreams, sessionPath, stream),
    })),
  removeSessionStream: (sessionPath) =>
    set((s) => ({
      sessionStreams: deleteSessionScopedValue(s, s.sessionStreams, sessionPath),
    })),
  setSessionCapabilityDrift: (sessionPath, drift) =>
    set((s) => {
      if (drift) {
        return {
          capabilityDriftBySession: putSessionScopedValue(
            s,
            s.capabilityDriftBySession,
            sessionPath,
            drift,
          ),
        };
      }
      return {
        capabilityDriftBySession: deleteSessionScopedValue(s, s.capabilityDriftBySession, sessionPath),
      };
    }),
  setSessionCapabilityRefreshing: (sessionPath, refreshing) =>
    set((s) => ({
      capabilityRefreshingSessions: refreshing
        ? putSessionScopedListValue(s, s.capabilityRefreshingSessions, sessionPath)
        : deleteSessionScopedListValue(s, s.capabilityRefreshingSessions, sessionPath),
    })),
  setPendingSessionConfirmation: (sessionPath, block) =>
    set((s) => {
      const path = normalizeSessionPath(sessionPath);
      if (!path) return {};
      const key = sessionScopedKey(s, path) || path;
      const pendingSessionConfirmationsByPath = { ...s.pendingSessionConfirmationsByPath };
      if (block?.status === 'pending') {
        pendingSessionConfirmationsByPath[key] = block;
        if (key !== path) delete pendingSessionConfirmationsByPath[path];
      } else {
        delete pendingSessionConfirmationsByPath[key];
        delete pendingSessionConfirmationsByPath[path];
      }
      return { pendingSessionConfirmationsByPath };
    }),
  resolvePendingSessionConfirmation: (confirmId) =>
    set((s) => {
      const id = typeof confirmId === 'string' ? confirmId.trim() : '';
      if (!id) return {};
      let changed = false;
      const pendingSessionConfirmationsByPath = { ...s.pendingSessionConfirmationsByPath };
      for (const [sessionPath, block] of Object.entries(pendingSessionConfirmationsByPath)) {
        if (block.confirmId !== id) continue;
        delete pendingSessionConfirmationsByPath[sessionPath];
        changed = true;
      }
      return changed ? { pendingSessionConfirmationsByPath } : {};
    }),
  setPendingNewSession: (pending) => set({ pendingNewSession: pending }),
  setPendingNewSessionThinkingLevel: (level) => set({ pendingNewSessionThinkingLevel: level }),
  setMemoryEnabled: (enabled) => set({ memoryEnabled: enabled }),
  setSessionTodos: (todos) =>
    set((s) => {
      const path = s.currentSessionPath;
      if (!path) return { sessionTodos: todos };
      return {
        sessionTodos: todos,
        todosBySession: putSessionScopedValue(s, s.todosBySession, path, todos),
      };
    }),
  setSessionTodosForPath: (sessionPath, todos) =>
    set((s) => ({
      todosBySession: putSessionScopedValue(s, s.todosBySession, sessionPath, todos),
      sessionTodos: s.currentSessionPath === sessionPath ? todos : s.sessionTodos,
    })),
  bumpTodosLiveVersion: (sessionPath) =>
    set((s) => {
      const key = sessionScopedKey(s, sessionPath) || sessionPath;
      return {
        todosLiveVersionBySession: putSessionScopedValue(
          s,
          s.todosLiveVersionBySession,
          sessionPath,
          (s.todosLiveVersionBySession[key] ?? s.todosLiveVersionBySession[sessionPath] ?? 0) + 1,
        ),
      };
    }),
});
