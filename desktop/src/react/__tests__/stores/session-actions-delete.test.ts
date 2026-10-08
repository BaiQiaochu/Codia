import { beforeEach, describe, expect, it, vi } from 'vitest';

const deletedPath = '/sessions/deleted.jsonl';
const currentPath = '/sessions/current.jsonl';

type MockState = Record<string, unknown>;

let state: MockState;
const gsapFetchMock = vi.fn();
const clearSessionMock = vi.fn();
const clearChatMock = vi.fn();
const addToastMock = vi.fn();

function jsonResponse(data: unknown) {
  return {
    ok: true,
    statusText: 'OK',
    json: async () => data,
  };
}

vi.mock('../../stores/index', () => ({
  useStore: {
    getState: () => state,
    setState: (patch: MockState | ((s: MockState) => MockState)) => {
      const next = typeof patch === 'function' ? patch(state) : patch;
      state = { ...state, ...next };
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
  clearChat: () => clearChatMock(),
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

describe('deleteSession cleanup', () => {
  beforeEach(() => {
    vi.resetModules();
    gsapFetchMock.mockReset();
    clearSessionMock.mockReset();
    clearChatMock.mockReset();
    state = {
      sessions: [
        { path: deletedPath, title: 'deleted', sessionId: 'sess_deleted' },
        { path: currentPath, title: 'current' },
      ],
      currentSessionPath: currentPath,
      pendingNewSession: false,
      pendingSessionSwitchPath: null,
      activePanel: null,
      agents: [{ id: 'gsap', name: 'G-SAP', yuan: 'gsap' }],
      currentAgentId: 'gsap',
      agentName: 'G-SAP',
      currentModelInfo: null,
      chatSessions: { [deletedPath]: { items: [], hasMore: false } },
      sessionStreams: { [deletedPath]: { isStreaming: true }, [currentPath]: { isStreaming: false } },
      todosBySession: { [deletedPath]: [{ content: 'old', status: 'pending' }] },
      todosLiveVersionBySession: { [deletedPath]: 3 },
      attachedFilesBySession: { [deletedPath]: [{ path: '/tmp/a.txt', name: 'a.txt' }] },
      drafts: { [deletedPath]: 'draft' },
      browserBySession: { [deletedPath]: { running: true, url: 'https://example.test', thumbnail: null } },
      contextBySession: { [deletedPath]: { tokens: 1, window: 2, percent: 50 } },
      inlineErrors: { [deletedPath]: 'boom' },
      deskStateByOwner: { [deletedPath]: { deskFiles: [] } },
      selectedIdsBySession: { [deletedPath]: ['msg-1'] },
      computerOverlayBySession: { [deletedPath]: { phase: 'running', action: 'click', sessionPath: deletedPath, ts: 1 } },
      previewByOwner: { [deletedPath]: { artifacts: [] } },
      streamingSessions: [deletedPath, currentPath],
      compactingSessions: [deletedPath],
      subagentPreviewByTaskId: {
        taskA: { open: true, sessionPath: deletedPath, loading: true, loadedOnce: true },
        taskB: { open: true, sessionPath: currentPath, loading: false, loadedOnce: true },
      },
      runtimeTimelineTraceIdsBySession: { [deletedPath]: ['trace-a'], [currentPath]: ['trace-b'] },
      runtimeTimelineByTrace: {
        'trace-a': { turnTraceId: 'trace-a', sessionPath: deletedPath, events: [] },
        'trace-b': { turnTraceId: 'trace-b', sessionPath: currentPath, events: [] },
      },
      clearSession: clearSessionMock,
      addToast: addToastMock,
      clearQuotedSelection: vi.fn(),
      setSessionCapabilityDrift: vi.fn(),
      restoreDeskStateForOwner: vi.fn(),
      getDeskStateForOwner: vi.fn(() => null),
      setThinkingLevel: vi.fn(),
    };
    addToastMock.mockReset();

    gsapFetchMock.mockImplementation((url: string) => {
      if (url === '/api/sessions/delete') return Promise.resolve(jsonResponse({ ok: true }));
      if (url === '/api/sessions') return Promise.resolve(jsonResponse([{ path: currentPath, title: 'current' }]));
      return Promise.resolve(jsonResponse({ ok: true }));
    });
  });

  it('removes all per-session UI caches after permanent deletion', async () => {
    const { deleteSession } = await import('../../stores/session-actions');

    await deleteSession(deletedPath);

    expect(gsapFetchMock).toHaveBeenCalledWith('/api/sessions/delete', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ path: deletedPath, sessionId: 'sess_deleted' }),
    }));
    expect(clearSessionMock).toHaveBeenCalledWith(deletedPath);
    expect(state.sessions).toEqual([{ path: currentPath, title: 'current' }]);
    for (const key of [
      'sessionStreams',
      'todosBySession',
      'todosLiveVersionBySession',
      'attachedFilesBySession',
      'drafts',
      'browserBySession',
      'contextBySession',
      'inlineErrors',
      'deskStateByOwner',
      'selectedIdsBySession',
      'computerOverlayBySession',
      'previewByOwner',
    ]) {
      expect((state[key] as Record<string, unknown>)[deletedPath]).toBeUndefined();
    }
    expect(state.streamingSessions).toEqual([currentPath]);
    expect(state.compactingSessions).toEqual([]);
    expect(state.subagentPreviewByTaskId).toEqual({
      taskB: { open: true, sessionPath: currentPath, loading: false, loadedOnce: true },
    });
    expect(state.runtimeTimelineTraceIdsBySession).toEqual({ [currentPath]: ['trace-b'] });
    expect(state.runtimeTimelineByTrace).toEqual({
      'trace-b': { turnTraceId: 'trace-b', sessionPath: currentPath, events: [] },
    });
    expect(clearChatMock).not.toHaveBeenCalled();
  });

  it('continues a deleted-agent session and warns without discarding when fresh compaction failed', async () => {
    const continuedPath = '/sessions/continued.jsonl';
    gsapFetchMock.mockImplementation((url: string) => {
      if (url === '/api/sessions/continue-deleted-agent') {
        return Promise.resolve(jsonResponse({
          ok: true,
          path: continuedPath,
          agentId: 'gsap',
          agentName: 'G-SAP',
          cwd: '/workspace',
          workspaceFolders: ['/workspace'],
          compacted: false,
          compactionError: 'summary model unavailable',
        }));
      }
      if (url === '/api/sessions') {
        return Promise.resolve(jsonResponse([{ path: continuedPath, title: 'continued' }]));
      }
      if (url === '/api/sessions/switch') {
        return Promise.resolve(jsonResponse({
          ok: true,
          isStreaming: false,
          agentId: 'gsap',
          agentName: 'G-SAP',
          workspaceFolders: ['/workspace'],
          memoryEnabled: true,
          permissionMode: 'ask',
          accessMode: 'operate',
          cwd: '/workspace',
        }));
      }
      return Promise.resolve(jsonResponse({ ok: true }));
    });
    const testWindow = Object.assign(
      ((globalThis as typeof globalThis & { window?: Partial<Window> }).window ?? {}),
      {
        t: (key: string) => key,
        dispatchEvent: () => true,
      },
    );
    (globalThis as typeof globalThis & { window: typeof globalThis.window }).window =
      testWindow as unknown as typeof globalThis.window;

    const { continueDeletedAgentSession } = await import('../../stores/session-actions');

    await expect(continueDeletedAgentSession(deletedPath)).resolves.toBe(true);

    expect(gsapFetchMock).toHaveBeenCalledWith('/api/sessions/continue-deleted-agent', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ path: deletedPath }),
    }));
    expect(state.sessions).toEqual([{ path: continuedPath, title: 'continued' }]);
    expect(state.currentSessionPath).toBe(continuedPath);
    expect(addToastMock).toHaveBeenCalledWith(
      'session.deletedAgent.continueCompactionFailed: summary model unavailable',
      'warning',
      6000,
    );
    expect(clearSessionMock).not.toHaveBeenCalledWith(continuedPath);
  });
});
