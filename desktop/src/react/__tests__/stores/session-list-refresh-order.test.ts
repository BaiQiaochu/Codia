import { beforeEach, describe, expect, it, vi } from 'vitest';

const state: Record<string, unknown> = {};
const gsapFetchMock = vi.fn();

vi.mock('../../stores/index', () => ({
  useStore: {
    getState: () => state,
    setState: (patch: Record<string, unknown> | ((s: Record<string, unknown>) => Record<string, unknown>)) => {
      Object.assign(state, typeof patch === 'function' ? patch(state) : patch);
    },
  },
}));
vi.mock('../../hooks/use-gsap-fetch', () => ({
  gsapFetch: (...args: unknown[]) => gsapFetchMock(...args),
  gsapUrl: (path: string) => path,
}));
vi.mock('../../utils/ui-helpers', () => ({ loadModels: vi.fn() }));
vi.mock('../../stores/desk-actions', () => ({ loadDeskFiles: vi.fn() }));
vi.mock('../../stores/agent-actions', () => ({ loadAvatars: vi.fn(), clearChat: vi.fn() }));
vi.mock('../../stores/preview-actions', () => ({ syncPreviewPanelForOwner: vi.fn() }));
vi.mock('../../utils/history-builder', () => ({ buildItemsFromHistory: vi.fn(() => []) }));
vi.mock('../../utils/todo-compat', () => ({ migrateLegacyTodos: vi.fn(input => input.todos || []) }));

function deferredResponse() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise(value => { resolve = value; });
  return { promise, resolve: (data: unknown) => resolve({ json: async () => data }) };
}

describe('session list refresh ordering', () => {
  beforeEach(() => {
    for (const key of Object.keys(state)) delete state[key];
    Object.assign(state, {
      currentSessionPath: '/sessions/current.jsonl',
      pendingNewSession: false,
      pendingSessionSwitchPath: null,
      sessions: [],
      setSessions: vi.fn(sessions => { state.sessions = sessions; }),
    });
    gsapFetchMock.mockReset();
  });

  it('does not resurrect removed sessions when an older refresh arrives last', async () => {
    const { loadSessions } = await import('../../stores/session-actions');
    const stale = deferredResponse();
    gsapFetchMock.mockReturnValueOnce(stale.promise);
    const older = loadSessions();
    const current = [{ path: '/sessions/current.jsonl', sessionId: 'sess_current', title: 'Updated' }];
    gsapFetchMock.mockResolvedValueOnce({ json: async () => current });
    await loadSessions();

    stale.resolve([
      { path: '/sessions/removed.jsonl', sessionId: 'sess_removed', title: 'Removed' },
      { path: '/sessions/current.jsonl', sessionId: 'sess_current', title: 'Old title' },
    ]);
    await older;

    expect(state.sessions).toEqual(current);
    expect(state.setSessions).toHaveBeenCalledTimes(1);
  });

  it('applies a sequential refresh and preserves the active session', async () => {
    const { loadSessions } = await import('../../stores/session-actions');
    gsapFetchMock.mockResolvedValueOnce({ json: async () => [{ path: '/sessions/current.jsonl', title: 'Old' }] });
    await loadSessions();
    const current = [{ path: '/sessions/current.jsonl', title: 'Renamed' }];
    gsapFetchMock.mockResolvedValueOnce({ json: async () => current });
    await loadSessions();

    expect(state.sessions).toEqual(current);
    expect(state.currentSessionPath).toBe('/sessions/current.jsonl');
    expect(state.setSessions).toHaveBeenCalledTimes(2);
  });

  it.each(['currentAgentId', 'activeServerConnectionId'])(
    'ignores old session lists after %s changes',
    async (ownerField) => {
      state[ownerField] = 'original';
      const { loadSessions } = await import('../../stores/session-actions');
      const stale = deferredResponse();
      gsapFetchMock.mockReturnValueOnce(stale.promise);
      const pending = loadSessions();
      state[ownerField] = 'replacement';
      stale.resolve([{ path: '/sessions/original-owner.jsonl' }]);
      await pending;
      expect(state.sessions).toEqual([]);
      expect(state.setSessions).not.toHaveBeenCalled();
    },
  );

  it('does not apply an older session list after the newest refresh fails', async () => {
    const { loadSessions } = await import('../../stores/session-actions');
    const stale = deferredResponse();
    gsapFetchMock.mockReturnValueOnce(stale.promise);
    const older = loadSessions();
    gsapFetchMock.mockRejectedValueOnce(new Error('synthetic unavailable'));
    await loadSessions();
    stale.resolve([{ path: '/sessions/removed.jsonl' }]);
    await older;
    expect(state.sessions).toEqual([]);
    expect(state.setSessions).not.toHaveBeenCalled();
  });

});
