import { beforeEach, describe, expect, it, vi } from 'vitest';

type StoreState = {
  currentSessionPath: string | null;
  pendingNewSession: boolean;
  welcomeVisible: boolean;
  sessionModelsByPath: Record<string, { id: string; name: string; provider: string }>;
  models: Array<{ id: string; provider: string; name?: string; isCurrent?: boolean }>;
  currentModel: { id: string; provider: string } | null;
};

let storeState: StoreState;
const codiaFetchMock = vi.fn();

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

vi.mock('../../hooks/use-codia-fetch', () => ({
  codiaFetch: (...args: unknown[]) => codiaFetchMock(...args),
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

    codiaFetchMock.mockResolvedValue({
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
    codiaFetchMock.mockReturnValue(new Promise((resolve) => {
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
});
