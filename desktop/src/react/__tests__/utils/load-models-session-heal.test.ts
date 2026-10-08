import { beforeEach, describe, expect, it, vi } from 'vitest';

type StoreState = {
  currentSessionPath: string | null;
  currentSessionId?: string | null;
  currentAgentId?: string | null;
  activeServerConnectionId?: string | null;
  pendingNewSession: boolean;
  welcomeVisible: boolean;
  sessionModelsByPath: Record<string, { id: string; name: string; provider: string }>;
  models: Array<{ id: string; provider: string; name?: string; isCurrent?: boolean }>;
  currentModel: { id: string; provider: string } | null;
};

let storeState: StoreState;
const gsapFetchMock = vi.fn();

const useStoreMock = Object.assign(
  () => storeState,
  {
    getState: () => storeState,
    setState: (partial: Partial<StoreState>) => Object.assign(storeState, partial),
  },
);

vi.mock('../../stores', () => ({
  useStore: useStoreMock,
}));

vi.mock('../../hooks/use-gsap-fetch', () => ({
  gsapFetch: (...args: unknown[]) => gsapFetchMock(...args),
}));

vi.mock('../../../../shared/error-bus.ts', () => ({
  errorBus: { report: vi.fn() },
}));

vi.mock('../../../../shared/errors.ts', () => ({
  AppError: class AppError extends Error {
    constructor(_code: string, opts?: { message?: string }) {
      super(opts?.message || 'error');
    }
  },
}));

describe('loadModels session healing', () => {
  beforeEach(() => {
    storeState = {
      currentSessionPath: 'E:/sessions/session-1.jsonl',
      pendingNewSession: true,
      welcomeVisible: true,
      sessionModelsByPath: {},
      models: [],
      currentModel: null,
    };

    gsapFetchMock.mockResolvedValue({
      json: async () => ({
        activeModel: { id: 'vision-model', provider: 'openai' },
        models: [
          { id: 'vision-model', provider: 'openai' },
          { id: 'text-model', provider: 'openai' },
        ],
      }),
    });
  });

  it('heals stale pendingNewSession when a current session already exists', async () => {
    const { loadModels } = await import('../../utils/ui-helpers');
    await loadModels();

    expect(storeState.pendingNewSession).toBe(false);
    expect(storeState.welcomeVisible).toBe(false);
    expect(storeState.currentModel).toEqual({ id: 'vision-model', provider: 'openai' });
  });

  it('uses activeModel as a fallback while waiting on a new session', async () => {
    storeState.currentSessionPath = null;
    storeState.pendingNewSession = true;
    storeState.welcomeVisible = true;

    const { loadModels } = await import('../../utils/ui-helpers');
    await loadModels();

    expect(storeState.pendingNewSession).toBe(true);
    expect(storeState.models.find((model) => model.id === 'vision-model')?.isCurrent).toBe(true);
    expect(storeState.currentModel).toEqual({ id: 'vision-model', provider: 'openai' });
  });

  it('keeps a session-bound model current even when /api/models reports another active session', async () => {
    storeState.pendingNewSession = false;
    storeState.sessionModelsByPath['E:/sessions/session-1.jsonl'] = {
      id: 'text-model',
      name: 'Text Model',
      provider: 'openai',
    };

    const { loadModels } = await import('../../utils/ui-helpers');
    await loadModels({ sessionPath: 'E:/sessions/session-1.jsonl' });

    expect(storeState.models.find((model) => model.id === 'text-model')?.isCurrent).toBe(true);
    expect(storeState.models.find((model) => model.id === 'vision-model')?.isCurrent).toBe(false);
    expect(storeState.currentModel).toEqual({ id: 'text-model', provider: 'openai' });
  });

  it('drops a stale model refresh when the focused session changed mid-flight', async () => {
    let resolveFetch: (value: unknown) => void = () => {};
    gsapFetchMock.mockReturnValue(new Promise((resolve) => {
      resolveFetch = resolve;
    }));

    const { loadModels } = await import('../../utils/ui-helpers');
    const pending = loadModels({ sessionPath: 'E:/sessions/session-1.jsonl' });
    storeState.currentSessionPath = 'E:/sessions/session-2.jsonl';
    storeState.models = [{ id: 'kept-model', provider: 'openai', isCurrent: true }];
    storeState.currentModel = { id: 'kept-model', provider: 'openai' };

    resolveFetch({
      json: async () => ({
        activeModel: { id: 'vision-model', provider: 'openai' },
        models: [
          { id: 'vision-model', provider: 'openai' },
          { id: 'text-model', provider: 'openai' },
        ],
      }),
    });
    await pending;

    expect(storeState.models).toEqual([{ id: 'kept-model', provider: 'openai', isCurrent: true }]);
    expect(storeState.currentModel).toEqual({ id: 'kept-model', provider: 'openai' });
  });

  it('drops a welcome-screen refresh after navigating to a saved session', async () => {
    storeState.currentSessionPath = null;
    const { loadModels } = await import('../../utils/ui-helpers');
    let resolveFetch!: (value: unknown) => void;
    gsapFetchMock.mockReturnValueOnce(new Promise(resolve => { resolveFetch = resolve; }));
    const pending = loadModels();

    storeState.currentSessionPath = 'E:/sessions/session-2.jsonl';
    storeState.pendingNewSession = false;
    storeState.models = [{ id: 'saved-session-model', provider: 'openai', isCurrent: true }];
    storeState.currentModel = { id: 'saved-session-model', provider: 'openai' };
    resolveFetch({ json: async () => ({
      activeModel: { id: 'welcome-model', provider: 'openai' },
      models: [{ id: 'welcome-model', provider: 'openai', isCurrent: true }],
    }) });
    await pending;

    expect(storeState.currentModel).toEqual({ id: 'saved-session-model', provider: 'openai' });
    expect(storeState.models).toEqual([{ id: 'saved-session-model', provider: 'openai', isCurrent: true }]);
  });

  it('keeps the newest model refresh when responses arrive out of order', async () => {
    const { loadModels } = await import('../../utils/ui-helpers');
    let resolveOlder!: (value: unknown) => void;
    gsapFetchMock.mockReturnValueOnce(new Promise(resolve => { resolveOlder = resolve; }));
    const older = loadModels();
    gsapFetchMock.mockResolvedValueOnce({ json: async () => ({
      activeModel: { id: 'new-model', provider: 'new-provider' },
      models: [{ id: 'new-model', provider: 'new-provider', isCurrent: true }],
    }) });
    await loadModels();
    resolveOlder({ json: async () => ({
      activeModel: { id: 'old-model', provider: 'old-provider' },
      models: [{ id: 'old-model', provider: 'old-provider', isCurrent: true }],
    }) });
    await older;

    expect(storeState.currentModel).toEqual({ id: 'new-model', provider: 'new-provider' });
    expect(storeState.models).toEqual([{ id: 'new-model', provider: 'new-provider', isCurrent: true }]);
  });

  it('reads the session-bound model from its stable session ID', async () => {
    storeState.pendingNewSession = false;
    storeState.currentSessionId = 'sess_stable';
    storeState.sessionModelsByPath.sess_stable = {
      id: 'text-model', name: 'Text Model', provider: 'openai',
    };
    const { loadModels } = await import('../../utils/ui-helpers');
    await loadModels();

    expect(storeState.currentModel).toEqual({ id: 'text-model', provider: 'openai' });
    expect(storeState.models.find(model => model.id === 'text-model')?.isCurrent).toBe(true);
  });


  it.each(['currentAgentId', 'activeServerConnectionId'] as const)(
    'ignores an old owner response when %s changed with the same session path',
    async (ownerField) => {
      storeState[ownerField] = 'original';
      const { loadModels } = await import('../../utils/ui-helpers');
      let resolveOlder!: (value: unknown) => void;
      gsapFetchMock.mockReturnValueOnce(new Promise(resolve => { resolveOlder = resolve; }));
      const pending = loadModels();
      storeState[ownerField] = 'replacement';
      resolveOlder({ json: async () => ({
        activeModel: { id: 'old-owner-model', provider: 'old-provider' },
        models: [{ id: 'old-owner-model', provider: 'old-provider', isCurrent: true }],
      }) });
      await pending;
      expect(storeState.models).toEqual([]);
      expect(storeState.currentModel).toBeNull();
    },
  );

  it('does not apply an older model refresh after the latest refresh fails', async () => {
    const { loadModels } = await import('../../utils/ui-helpers');
    let resolveOlder!: (value: unknown) => void;
    gsapFetchMock.mockReturnValueOnce(new Promise(resolve => { resolveOlder = resolve; }));
    const older = loadModels();
    gsapFetchMock.mockRejectedValueOnce(new Error('synthetic unavailable'));
    await loadModels();
    resolveOlder({ json: async () => ({
      activeModel: { id: 'old-model', provider: 'old-provider' },
      models: [{ id: 'old-model', provider: 'old-provider', isCurrent: true }],
    }) });
    await older;
    expect(storeState.models).toEqual([]);
    expect(storeState.currentModel).toBeNull();
  });

  it('drops a saved-session refresh after returning to the welcome screen', async () => {
    const { loadModels } = await import('../../utils/ui-helpers');
    let resolveOlder!: (value: unknown) => void;
    gsapFetchMock.mockReturnValueOnce(new Promise(resolve => { resolveOlder = resolve; }));
    const pending = loadModels();
    storeState.currentSessionPath = null;
    storeState.pendingNewSession = true;
    resolveOlder({ json: async () => ({
      activeModel: { id: 'saved-session-model', provider: 'openai' },
      models: [{ id: 'saved-session-model', provider: 'openai', isCurrent: true }],
    }) });
    await pending;
    expect(storeState.currentModel).toBeNull();
    expect(storeState.pendingNewSession).toBe(true);
  });

});
