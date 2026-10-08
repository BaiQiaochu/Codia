import { beforeEach, describe, expect, it, vi } from 'vitest';

const state: Record<string, any> = {};
const gsapFetchMock = vi.fn();
const loadMessagesStatePatch = vi.fn();

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

describe('refreshSessionCapabilities', () => {
  beforeEach(() => {
    for (const key of Object.keys(state)) delete state[key];
    gsapFetchMock.mockReset();
    loadMessagesStatePatch.mockReset();
    Object.assign(state, {
      capabilityDriftBySession: {
        '/tmp/s.jsonl': { hasDrift: true, fingerprint: 'old' },
      },
      capabilityRefreshingSessions: [],
      todosLiveVersionBySession: {},
      setSessionCapabilityRefreshing: vi.fn((path: string, refreshing: boolean) => {
        state.capabilityRefreshingSessions = refreshing
          ? [...new Set([...(state.capabilityRefreshingSessions || []), path])]
          : (state.capabilityRefreshingSessions || []).filter((item: string) => item !== path);
      }),
      setSessionCapabilityDrift: vi.fn((path: string, drift: unknown) => {
        if (drift) state.capabilityDriftBySession[path] = drift;
        else delete state.capabilityDriftBySession[path];
      }),
      setSessionRegistryFiles: vi.fn(),
      setSessionTodosForPath: vi.fn(),
      initSession: vi.fn(),
      appendItem: vi.fn(),
      _loadMessagesVersion: {},
      bumpLoadMessagesVersion: vi.fn((path: string) => {
        state._loadMessagesVersion[path] = (state._loadMessagesVersion[path] || 0) + 1;
        return state._loadMessagesVersion[path];
      }),
    });
  });

  it('clears stale capability drift after a successful fresh compact even when messages hydration returns old drift', async () => {
    gsapFetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/sessions/fresh-compact') {
        return {
          ok: true,
          json: async () => ({ ok: true, capabilityDrift: { hasDrift: true, fingerprint: 'old' } }),
        };
      }
      if (url.startsWith('/api/sessions/messages?')) {
        loadMessagesStatePatch();
        return {
          ok: true,
          json: async () => ({
            messages: [],
            blocks: [],
            todos: [],
            sessionFiles: [],
            capabilityDrift: { hasDrift: true, fingerprint: 'old' },
          }),
        };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const { refreshSessionCapabilities } = await import('../../stores/session-actions');
    const ok = await refreshSessionCapabilities('/tmp/s.jsonl');

    expect(ok).toBe(true);
    expect(state.setSessionCapabilityDrift).toHaveBeenLastCalledWith('/tmp/s.jsonl', null);
    expect(state.capabilityDriftBySession['/tmp/s.jsonl']).toBeUndefined();
  });

  it('forwards caller abort signal and timeout to the fresh compact request', async () => {
    const controller = new AbortController();
    gsapFetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/sessions/fresh-compact') {
        return {
          ok: true,
          json: async () => ({ ok: true, capabilityDrift: null }),
        };
      }
      if (url.startsWith('/api/sessions/messages?')) {
        return {
          ok: true,
          json: async () => ({
            messages: [],
            blocks: [],
            todos: [],
            sessionFiles: [],
            capabilityDrift: null,
          }),
        };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const { refreshSessionCapabilities } = await import('../../stores/session-actions');
    await refreshSessionCapabilities('/tmp/s.jsonl', {
      signal: controller.signal,
      timeout: 12_345,
    });

    expect(gsapFetchMock).toHaveBeenCalledWith('/api/sessions/fresh-compact', expect.objectContaining({
      signal: controller.signal,
      timeout: 12_345,
    }));
  });

  it('retries a transient busy fresh-compact response before showing refresh failure', async () => {
    let freshCompactAttempts = 0;
    gsapFetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/sessions/fresh-compact') {
        freshCompactAttempts += 1;
        if (freshCompactAttempts === 1) {
          return {
            ok: false,
            status: 409,
            json: async () => ({
              error: 'freshCompactDesktopSession: session is streaming, try again after the reply completes',
            }),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, capabilityDrift: null }),
        };
      }
      if (url.startsWith('/api/sessions/messages?')) {
        return {
          ok: true,
          json: async () => ({
            messages: [],
            blocks: [],
            todos: [],
            sessionFiles: [],
            capabilityDrift: null,
          }),
        };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const { refreshSessionCapabilities } = await import('../../stores/session-actions');
    const ok = await refreshSessionCapabilities('/tmp/s.jsonl', { retryDelayMs: 0 });

    expect(ok).toBe(true);
    expect(freshCompactAttempts).toBe(2);
    expect(state.setSessionCapabilityDrift).toHaveBeenLastCalledWith('/tmp/s.jsonl', null);
  });
});
