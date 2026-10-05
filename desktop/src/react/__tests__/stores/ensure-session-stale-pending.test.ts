import { beforeEach, describe, expect, it, vi } from 'vitest';

const state: Record<string, unknown> = {};
const gsapFetchMock = vi.fn();

vi.mock('../../stores/index', () => ({
  useStore: {
    getState: () => state,
    setState: (patch: Record<string, unknown> | ((s: Record<string, unknown>) => Record<string, unknown>)) => {
      const next = typeof patch === 'function' ? patch(state) : patch;
      Object.assign(state, next);
    },
  },
}));

vi.mock('../../hooks/use-gsap-fetch', () => ({
  gsapFetch: (...args: unknown[]) => gsapFetchMock(...args),
  gsapUrl: (path: string) => path,
}));

vi.mock('../../utils/ui-helpers', () => ({
  loadModels: vi.fn(),
}));

vi.mock('../../stores/desk-actions', () => ({
  loadDeskFiles: vi.fn(),
}));

vi.mock('../../stores/agent-actions', () => ({
  loadAvatars: vi.fn(),
  clearChat: vi.fn(),
}));

vi.mock('../../stores/preview-actions', () => ({
  syncPreviewPanelForOwner: vi.fn(),
}));

vi.mock('../../utils/history-builder', () => ({
  buildItemsFromHistory: vi.fn(() => []),
}));

vi.mock('../../utils/todo-compat', () => ({
  migrateLegacyTodos: vi.fn((input) => input.todos || []),
}));

describe('ensureSession stale pending state', () => {
  beforeEach(() => {
    for (const key of Object.keys(state)) delete state[key];
    gsapFetchMock.mockReset();
  });

  it('heals a stale pendingNewSession flag when a current session path already exists', async () => {
    Object.assign(state, {
      pendingNewSession: true,
      currentSessionPath: 'E:/sessions/existing.jsonl',
      selectedFolder: null,
      workspaceFolders: [],
      selectedAgentId: null,
      currentAgentId: 'agent-main',
      memoryEnabled: true,
    });

    const { ensureSession } = await import('../../stores/session-actions');
    const ok = await ensureSession();

    expect(ok).toBe(true);
    expect(state.pendingNewSession).toBe(false);
    expect(state.welcomeVisible).toBe(false);
    expect(gsapFetchMock).not.toHaveBeenCalledWith('/api/sessions/new', expect.anything());
  });

  it('creates a session when the focused chat path is missing even if the pending flag was lost', async () => {
    const initSession = vi.fn();
    const cloneDeskStateToOwner = vi.fn();
    const restoreDeskStateForOwner = vi.fn();
    Object.assign(state, {
      pendingNewSession: false,
      currentSessionPath: null,
      selectedFolder: 'D:/xshell/0601/04/chain',
      homeFolder: 'D:/xshell/0601/04/chain',
      workspaceFolders: [],
      selectedAgentId: null,
      currentAgentId: 'agent-main',
      memoryEnabled: true,
      agents: [],
      cwdHistory: [],
      cloneDeskStateToOwner,
      initSession,
      restoreDeskStateForOwner,
      getDeskStateForOwner: vi.fn(() => null),
    });
    gsapFetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/sessions/new') {
        return {
          json: async () => ({
            path: 'E:/sessions/new-chat.jsonl',
            cwd: 'D:/xshell/0601/04/chain',
            workspaceFolders: [],
          }),
        };
      }
      if (url === '/api/sessions') {
        return { json: async () => [{ path: 'E:/sessions/new-chat.jsonl' }] };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const { ensureSession } = await import('../../stores/session-actions');
    const ok = await ensureSession();

    expect(ok).toBe(true);
    expect(gsapFetchMock).toHaveBeenCalledWith('/api/sessions/new', expect.objectContaining({
      method: 'POST',
      body: expect.stringContaining('"cwd":"D:/xshell/0601/04/chain"'),
    }));
    expect(state.currentSessionPath).toBe('E:/sessions/new-chat.jsonl');
    expect(state.pendingNewSession).toBe(false);
    expect(state.welcomeVisible).toBe(false);
    expect(initSession).toHaveBeenCalledWith('E:/sessions/new-chat.jsonl', [], false);
    expect(cloneDeskStateToOwner).toHaveBeenCalledWith('E:/sessions/new-chat.jsonl');
    expect(restoreDeskStateForOwner).toHaveBeenCalledWith('E:/sessions/new-chat.jsonl');
  });

  it('does not block first prompt send on sidebar session list refresh', async () => {
    let resolveSessions: (value: unknown) => void = () => {};
    const sessionsRefresh = new Promise((resolve) => {
      resolveSessions = resolve;
    });
    Object.assign(state, {
      pendingNewSession: true,
      currentSessionPath: null,
      selectedFolder: 'D:/xshell/0601/04/chain',
      homeFolder: 'D:/xshell/0601/04/chain',
      workspaceFolders: [],
      selectedAgentId: null,
      currentAgentId: 'agent-main',
      memoryEnabled: true,
      agents: [],
      cwdHistory: [],
      cloneDeskStateToOwner: vi.fn(),
      initSession: vi.fn(),
      restoreDeskStateForOwner: vi.fn(),
      getDeskStateForOwner: vi.fn(() => null),
    });
    gsapFetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/sessions/new') {
        return {
          json: async () => ({
            path: 'E:/sessions/fast-first-send.jsonl',
            cwd: 'D:/xshell/0601/04/chain',
            workspaceFolders: [],
          }),
        };
      }
      if (url === '/api/sessions') return sessionsRefresh;
      throw new Error(`unexpected fetch: ${url}`);
    });

    const { ensureSession } = await import('../../stores/session-actions');
    let settled = false;
    const pending = ensureSession().then((ok) => {
      settled = true;
      return ok;
    });

    await new Promise(resolve => setTimeout(resolve, 0));
    const settledBeforeSidebarRefresh = settled;

    resolveSessions({ json: async () => [{ path: 'E:/sessions/fast-first-send.jsonl' }] });
    const ok = await pending;

    expect(ok).toBe(true);
    expect(state.currentSessionPath).toBe('E:/sessions/fast-first-send.jsonl');
    expect(settledBeforeSidebarRefresh).toBe(true);
  });

  it('surfaces session creation failures and restores a retryable pending state', async () => {
    const addToast = vi.fn();
    Object.assign(state, {
      pendingNewSession: true,
      currentSessionPath: null,
      selectedFolder: 'D:/xshell/0423/GASP',
      homeFolder: 'D:/xshell/0423/GASP',
      workspaceFolders: [],
      selectedAgentId: null,
      currentAgentId: 'agent-main',
      memoryEnabled: true,
      pendingProjectId: null,
      addToast,
    });
    gsapFetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/sessions/new') {
        return {
          json: async () => ({ error: 'workspace unavailable' }),
        };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const { ensureSession } = await import('../../stores/session-actions');
    const ok = await ensureSession();

    expect(ok).toBe(false);
    expect(state.currentSessionPath).toBeNull();
    expect(state.pendingNewSession).toBe(false);
    expect(state.welcomeVisible).toBe(true);
    expect(addToast).toHaveBeenCalledWith(
      'workspace unavailable',
      'error',
      6000,
      expect.objectContaining({ dedupeKey: 'session-create-failed' }),
    );
  });

  it('treats a missing created session path as a visible creation failure', async () => {
    const addToast = vi.fn();
    Object.assign(state, {
      pendingNewSession: true,
      currentSessionPath: null,
      selectedFolder: 'D:/xshell/0423/GASP',
      homeFolder: 'D:/xshell/0423/GASP',
      workspaceFolders: [],
      selectedAgentId: null,
      currentAgentId: 'agent-main',
      memoryEnabled: true,
      pendingProjectId: null,
      addToast,
    });
    gsapFetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/sessions/new') {
        return {
          json: async () => ({ ok: true }),
        };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const { ensureSession } = await import('../../stores/session-actions');
    const ok = await ensureSession();

    expect(ok).toBe(false);
    expect(state.currentSessionPath).toBeNull();
    expect(state.pendingNewSession).toBe(false);
    expect(state.welcomeVisible).toBe(true);
    expect(addToast).toHaveBeenCalledWith(
      'Session create response missing path',
      'error',
      6000,
      expect.objectContaining({ dedupeKey: 'session-create-failed' }),
    );
  });

  it('ignores stale switch responses after opening a new-session draft', async () => {
    let resolveSwitch: (value: unknown) => void = () => {};
    const switchResponse = new Promise((resolve) => {
      resolveSwitch = resolve;
    });
    const restoreDeskStateForOwner = vi.fn();
    const clearQuotedSelection = vi.fn();
    Object.assign(state, {
      activePanel: null,
      pendingNewSession: false,
      pendingSessionSwitchPath: null,
      currentSessionPath: 'E:/sessions/current.jsonl',
      selectedFolder: null,
      homeFolder: 'D:/workspace/current',
      workspaceFolders: [],
      selectedAgentId: null,
      currentAgentId: 'agent-main',
      memoryEnabled: true,
      agents: [],
      attachedFiles: [],
      attachedFilesBySession: {},
      browserBySession: {},
      streamingSessions: [],
      chatSessions: {
        'E:/sessions/target.jsonl': { items: [], hasMore: false, loadingMore: false },
      },
      restoreDeskStateForOwner,
      getDeskStateForOwner: vi.fn(() => null),
      clearQuotedSelection,
      setThinkingLevel: vi.fn(),
      updateSessionModel: vi.fn(),
      requestInputFocus: vi.fn(),
    });
    gsapFetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/sessions/switch') return switchResponse;
      if (url === '/api/session-permission-mode') return { json: async () => ({ mode: 'ask' }) };
      if (url === '/api/session-thinking-level') return { json: async () => ({}) };
      throw new Error(`unexpected fetch: ${url}`);
    });

    const { switchSession, createNewSession } = await import('../../stores/session-actions');
    const switchTask = switchSession('E:/sessions/target.jsonl');
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(state.pendingSessionSwitchPath).toBe('E:/sessions/target.jsonl');

    await createNewSession({ cwd: 'D:/workspace/new' });

    expect(state.pendingSessionSwitchPath).toBeNull();
    expect(state.currentSessionPath).toBeNull();
    expect(state.pendingNewSession).toBe(true);
    expect(state.selectedFolder).toBe('D:/workspace/new');

    resolveSwitch({
      json: async () => ({
        cwd: 'D:/workspace/target',
        workspaceFolders: [],
        memoryEnabled: true,
      }),
    });
    await switchTask;

    expect(state.currentSessionPath).toBeNull();
    expect(state.pendingNewSession).toBe(true);
    expect(restoreDeskStateForOwner).not.toHaveBeenCalledWith('E:/sessions/target.jsonl');
    expect(clearQuotedSelection).not.toHaveBeenCalled();
  });

  it('uses the server-confirmed session path when switching a migrated pinned history row', async () => {
    const restoreDeskStateForOwner = vi.fn();
    const clearQuotedSelection = vi.fn();
    Object.assign(state, {
      activePanel: null,
      pendingNewSession: false,
      pendingSessionSwitchPath: null,
      currentSessionPath: 'E:/sessions/current.jsonl',
      currentSessionId: 'sess-current',
      sessionLocatorsById: {
        'sess-pinned': { path: 'E:/sessions/stale-pinned.jsonl' },
      },
      sessions: [
        {
          path: 'E:/sessions/stale-pinned.jsonl',
          sessionId: 'sess-pinned',
          title: 'Pinned migrated session',
        },
      ],
      selectedFolder: null,
      homeFolder: 'D:/workspace/current',
      workspaceFolders: [],
      selectedAgentId: null,
      currentAgentId: 'agent-main',
      memoryEnabled: true,
      agents: [],
      attachedFiles: [],
      attachedFilesBySession: {},
      browserBySession: {},
      streamingSessions: [],
      chatSessions: {
        'E:/sessions/current-path.jsonl': { items: [], hasMore: false, loadingMore: false },
      },
      restoreDeskStateForOwner,
      getDeskStateForOwner: vi.fn(() => null),
      clearQuotedSelection,
      setThinkingLevel: vi.fn(),
      updateSessionModel: vi.fn(),
      requestInputFocus: vi.fn(),
      setSessionCapabilityDrift: vi.fn(),
    });
    gsapFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/sessions/switch') {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          path: 'E:/sessions/stale-pinned.jsonl',
          sessionId: 'sess-pinned',
        });
        return {
          json: async () => ({
            path: 'E:/sessions/current-path.jsonl',
            sessionId: 'sess-pinned',
            cwd: 'D:/workspace/current',
            workspaceFolders: [],
            memoryEnabled: true,
            isStreaming: false,
          }),
        };
      }
      if (url === '/api/session-permission-mode') return { json: async () => ({ mode: 'ask' }) };
      if (url === '/api/session-thinking-level') return { json: async () => ({}) };
      throw new Error(`unexpected fetch: ${url}`);
    });

    const { switchSession } = await import('../../stores/session-actions');
    await switchSession('E:/sessions/stale-pinned.jsonl');

    expect(state.currentSessionPath).toBe('E:/sessions/current-path.jsonl');
    expect(state.currentSessionId).toBe('sess-pinned');
    expect(state.sessionLocatorsById).toMatchObject({
      'sess-pinned': { path: 'E:/sessions/current-path.jsonl' },
    });
    expect(restoreDeskStateForOwner).toHaveBeenCalledWith('E:/sessions/current-path.jsonl');
    expect(clearQuotedSelection).toHaveBeenCalled();
  });

  it('normalizes legacy list id before switching a non-pinned history row', async () => {
    const restoreDeskStateForOwner = vi.fn();
    const clearQuotedSelection = vi.fn();
    Object.assign(state, {
      activePanel: null,
      pendingNewSession: false,
      pendingSessionSwitchPath: null,
      currentSessionPath: 'E:/sessions/current.jsonl',
      currentSessionId: 'sess-current',
      sessionLocatorsById: {},
      sessions: [],
      selectedFolder: null,
      homeFolder: 'D:/workspace/current',
      workspaceFolders: [],
      selectedAgentId: null,
      currentAgentId: 'agent-main',
      memoryEnabled: true,
      agents: [],
      attachedFiles: [],
      attachedFilesBySession: {},
      browserBySession: {},
      streamingSessions: [],
      chatSessions: {
        'E:/sessions/non-pinned-current.jsonl': { items: [], hasMore: false, loadingMore: false },
      },
      setSessions: vi.fn((sessions) => {
        state.sessions = sessions;
        state.sessionLocatorsById = Object.fromEntries(
          sessions
            .filter((session: { sessionId?: string }) => session.sessionId)
            .map((session: { sessionId: string; path: string }) => [session.sessionId, { path: session.path }]),
        );
      }),
      restoreDeskStateForOwner,
      getDeskStateForOwner: vi.fn(() => null),
      clearQuotedSelection,
      setThinkingLevel: vi.fn(),
      updateSessionModel: vi.fn(),
      requestInputFocus: vi.fn(),
      setSessionCapabilityDrift: vi.fn(),
    });
    gsapFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/sessions') {
        return {
          json: async () => ([
            {
              id: 'sess-history-legacy',
              path: 'E:/sessions/non-pinned-stale.jsonl',
              title: 'Non-pinned migrated session',
            },
          ]),
        };
      }
      if (url === '/api/sessions/switch') {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          path: 'E:/sessions/non-pinned-stale.jsonl',
          sessionId: 'sess-history-legacy',
        });
        return {
          json: async () => ({
            path: 'E:/sessions/non-pinned-current.jsonl',
            sessionId: 'sess-history-legacy',
            cwd: 'D:/workspace/current',
            workspaceFolders: [],
            memoryEnabled: true,
            isStreaming: false,
          }),
        };
      }
      if (url === '/api/session-permission-mode') return { json: async () => ({ mode: 'ask' }) };
      if (url === '/api/session-thinking-level') return { json: async () => ({}) };
      throw new Error(`unexpected fetch: ${url}`);
    });

    const { loadSessions, switchSession } = await import('../../stores/session-actions');
    await loadSessions();
    await switchSession('E:/sessions/non-pinned-stale.jsonl');

    expect(state.currentSessionPath).toBe('E:/sessions/non-pinned-current.jsonl');
    expect(state.currentSessionId).toBe('sess-history-legacy');
    expect(state.sessions).toMatchObject([
      {
        path: 'E:/sessions/non-pinned-current.jsonl',
        sessionId: 'sess-history-legacy',
      },
    ]);
  });
});
