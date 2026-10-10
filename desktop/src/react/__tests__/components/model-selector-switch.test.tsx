// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type StoreState = {
  currentSessionPath: string | null;
  pendingNewSession: boolean;
  sessionModelsByPath: Record<string, { id: string; name: string; provider: string }>;
  models?: Array<{ id: string; name: string; provider: string; isCurrent?: boolean }>;
  currentModel?: { id: string; provider: string } | null;
  updateSessionModel: ReturnType<typeof vi.fn>;
  setModelSwitching: ReturnType<typeof vi.fn>;
  addToast: ReturnType<typeof vi.fn>;
};

let storeState: StoreState;
const codiaFetchMock = vi.fn();

const useStoreMock = Object.assign(
  (selector?: (state: StoreState) => unknown) => selector ? selector(storeState) : storeState,
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

vi.mock('../../hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

describe('ModelSelector existing-session switching', () => {
  beforeEach(() => {
    storeState = {
      currentSessionPath: 'E:/sessions/session-1.jsonl',
      pendingNewSession: false,
      sessionModelsByPath: {},
      models: [],
      currentModel: null,
      updateSessionModel: vi.fn((path, model) => {
        storeState.sessionModelsByPath[path] = model;
      }),
      setModelSwitching: vi.fn(),
      addToast: vi.fn(),
    };

    codiaFetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/models/switch') {
        return {
          ok: true,
          json: async () => ({
            model: { id: 'new-model', name: 'New Model', provider: 'openai' },
            adaptations: [],
          }),
        };
      }
      if (url === '/api/models') {
        return {
          ok: true,
          json: async () => ({
            activeModel: { id: 'new-model', provider: 'openai' },
            models: [
              { id: 'old-model', name: 'Old Model', provider: 'openai' },
              { id: 'new-model', name: 'New Model', provider: 'openai' },
            ],
          }),
        };
      }
      throw new Error(`unexpected url: ${url}`);
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('uses /api/models/switch for an existing session even before messages hydrate', async () => {
    const { ModelSelector } = await import('../../components/input/ModelSelector');
    render(React.createElement(ModelSelector, {
      models: [
        { id: 'old-model', name: 'Old Model', provider: 'openai', isCurrent: true, vision: false },
        { id: 'new-model', name: 'New Model', provider: 'openai', vision: true },
      ],
    }));

    fireEvent.click(screen.getByRole('button', { name: /Old Model/ }));
    expect(await screen.findByText('文本')).toBeTruthy();
    expect(await screen.findByText('视觉')).toBeTruthy();
    fireEvent.click(await screen.findByRole('option', { name: /New Model/ }));

    await waitFor(() => {
      expect(codiaFetchMock).toHaveBeenCalledWith('/api/models/switch', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          sessionPath: 'E:/sessions/session-1.jsonl',
          modelId: 'new-model',
          provider: 'openai',
        }),
      }));
    });

    expect(codiaFetchMock).not.toHaveBeenCalledWith('/api/models/set', expect.anything());
    expect(storeState.updateSessionModel).toHaveBeenCalledWith('E:/sessions/session-1.jsonl', {
      id: 'new-model',
      name: 'New Model',
      provider: 'openai',
    });
  });

  it('does not open or switch models while the active session is streaming', async () => {
    const { ModelSelector } = await import('../../components/input/ModelSelector');
    render(React.createElement(ModelSelector, {
      isStreaming: true,
      models: [
        { id: 'old-model', name: 'Old Model', provider: 'openai', isCurrent: true, vision: false },
        { id: 'new-model', name: 'New Model', provider: 'openai', vision: true },
      ],
    }));

    fireEvent.click(screen.getByRole('button', { name: /Old Model/ }));

    expect(screen.queryByText('视觉')).toBeNull();
    expect(codiaFetchMock).not.toHaveBeenCalled();
    expect(storeState.addToast).toHaveBeenCalledWith('model.switchWhileStreaming', 'warning', 4000, {
      dedupeKey: 'model-switch-streaming',
    });
  });

  it('maps backend streaming switch rejection to a stable warning toast', async () => {
    codiaFetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/models/switch') {
        return {
          ok: false,
          json: async () => ({ error: 'cannot switch model while streaming' }),
        };
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const { ModelSelector } = await import('../../components/input/ModelSelector');
    render(React.createElement(ModelSelector, {
      models: [
        { id: 'old-model', name: 'Old Model', provider: 'openai', isCurrent: true, vision: false },
        { id: 'new-model', name: 'New Model', provider: 'openai', vision: true },
      ],
    }));

    fireEvent.click(screen.getByRole('button', { name: /Old Model/ }));
    fireEvent.click(await screen.findByRole('option', { name: /New Model/ }));

    await waitFor(() => {
      expect(storeState.addToast).toHaveBeenCalledWith('model.switchWhileStreaming', 'warning', 4000, {
        dedupeKey: 'model-switch-streaming',
      });
    });
    expect(storeState.setModelSwitching).toHaveBeenLastCalledWith(false);
  });

  it('does not show unknown models as vision capable without explicit capability metadata', async () => {
    storeState.currentSessionPath = null;
    const { ModelSelector } = await import('../../components/input/ModelSelector');
    render(React.createElement(ModelSelector, {
      models: [
        { id: 'unknown-model', name: 'Unknown Model', provider: 'custom', isCurrent: true },
        { id: 'vision-model', name: 'Vision Model', provider: 'custom', input: ['text', 'image'] },
      ],
    }));

    fireEvent.click(screen.getByRole('button', { name: /Unknown Model/ }));

    expect(await screen.findAllByText('文本')).toHaveLength(1);
    expect(await screen.findByText('视觉')).toBeTruthy();
  });

  it('still uses /api/models/switch when pendingNewSession is stale but currentSessionPath already exists', async () => {
    storeState.pendingNewSession = true;

    const { ModelSelector } = await import('../../components/input/ModelSelector');
    render(React.createElement(ModelSelector, {
      models: [
        { id: 'old-model', name: 'Old Model', provider: 'openai', isCurrent: true, vision: false },
        { id: 'new-model', name: 'New Model', provider: 'openai', vision: true },
      ],
    }));

    fireEvent.click(screen.getByRole('button', { name: /Old Model/ }));
    fireEvent.click(await screen.findByRole('option', { name: /New Model/ }));

    await waitFor(() => {
      expect(codiaFetchMock).toHaveBeenCalledWith('/api/models/switch', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          sessionPath: 'E:/sessions/session-1.jsonl',
          modelId: 'new-model',
          provider: 'openai',
        }),
      }));
    });

    expect(codiaFetchMock).not.toHaveBeenCalledWith('/api/models/set', expect.anything());
    expect(storeState.pendingNewSession).toBe(false);
  });

  it('does not let a stale post-switch model refresh overwrite a newly focused session', async () => {
    let resolveModelsFetch: (value: unknown) => void = () => {};
    codiaFetchMock.mockImplementation((url: string) => {
      if (url === '/api/models/switch') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            model: { id: 'new-model', name: 'New Model', provider: 'openai' },
            adaptations: [],
          }),
        });
      }
      if (url === '/api/models') {
        return new Promise((resolve) => {
          resolveModelsFetch = resolve;
        });
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const { ModelSelector } = await import('../../components/input/ModelSelector');
    render(React.createElement(ModelSelector, {
      models: [
        { id: 'old-model', name: 'Old Model', provider: 'openai', isCurrent: true, vision: false },
        { id: 'new-model', name: 'New Model', provider: 'openai', vision: true },
      ],
    }));

    fireEvent.click(screen.getByRole('button', { name: /Old Model/ }));
    fireEvent.click(await screen.findByRole('option', { name: /New Model/ }));

    await waitFor(() => {
      expect(storeState.updateSessionModel).toHaveBeenCalledWith('E:/sessions/session-1.jsonl', {
        id: 'new-model',
        name: 'New Model',
        provider: 'openai',
      });
    });

    storeState.currentSessionPath = 'E:/sessions/session-2.jsonl';
    storeState.models = [{ id: 'session-2-model', name: 'Session 2 Model', provider: 'openai', isCurrent: true }];
    storeState.currentModel = { id: 'session-2-model', provider: 'openai' };

    resolveModelsFetch({
      ok: true,
      json: async () => ({
        activeModel: { id: 'new-model', provider: 'openai' },
        models: [
          { id: 'new-model', name: 'New Model', provider: 'openai' },
          { id: 'session-2-model', name: 'Session 2 Model', provider: 'openai' },
        ],
      }),
    });

    await waitFor(() => {
      expect(storeState.setModelSwitching).toHaveBeenLastCalledWith(false);
    });
    expect(storeState.models).toEqual([{ id: 'session-2-model', name: 'Session 2 Model', provider: 'openai', isCurrent: true }]);
    expect(storeState.currentModel).toEqual({ id: 'session-2-model', provider: 'openai' });
  });

  it('does not show a hard-coded video provider when no video model is configured', async () => {
    const onChatVideoModeChange = vi.fn();
    const { ModelSelector } = await import('../../components/input/ModelSelector');
    render(React.createElement(ModelSelector, {
      models: [
        { id: 'old-model', name: 'Old Model', provider: 'openai', isCurrent: true, vision: false },
      ],
      onChatVideoModeChange,
    }));

    fireEvent.click(screen.getByRole('button', { name: /Old Model/ }));

    expect(screen.queryByText('ToAPIs / Seedance 2')).toBeNull();
    expect(onChatVideoModeChange).not.toHaveBeenCalled();
    expect(codiaFetchMock).not.toHaveBeenCalledWith('/api/models/switch', expect.anything());
    expect(codiaFetchMock).not.toHaveBeenCalledWith('/api/models/set', expect.anything());
  });

  it('selects the configured video provider without switching the chat model', async () => {
    const onChatVideoModeChange = vi.fn();
    const { ModelSelector } = await import('../../components/input/ModelSelector');
    render(React.createElement(ModelSelector, {
      models: [
        { id: 'old-model', name: 'Old Model', provider: 'openai', isCurrent: true, vision: false },
        { id: 'seedance-2', name: 'Seedance 2', provider: 'kskooo', type: 'video' },
        { id: 'doubao-video', name: 'Doubao Video', provider: 'volcengine', type: 'video' },
      ],
      onChatVideoModeChange,
    }));

    fireEvent.click(screen.getByRole('button', { name: /Old Model/ }));
    expect(await screen.findByText('Seedance 2')).toBeTruthy();
    expect(await screen.findByText('Doubao Video')).toBeTruthy();
    expect(screen.queryByText('ToAPIs / Seedance 2')).toBeNull();
    fireEvent.click(await screen.findByRole('option', { name: /Seedance 2/ }));

    expect(onChatVideoModeChange).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'kskooo',
      model: 'seedance-2',
      mediaType: 'video',
    }));
    expect(codiaFetchMock).not.toHaveBeenCalledWith('/api/models/switch', expect.anything());
    expect(codiaFetchMock).not.toHaveBeenCalledWith('/api/models/set', expect.anything());
  });

  it('renders the current model as read-only in PWA mode', async () => {
    vi.stubGlobal('window', {
      __CODIA_PWA__: {},
      localStorage: {
        getItem: () => 'pwa.locked-token',
      },
    });

    const { ModelSelector } = await import('../../components/input/ModelSelector');
    render(React.createElement(ModelSelector, {
      models: [
        { id: 'locked-model', name: 'Locked Model', provider: 'openai', isCurrent: true, vision: false },
      ],
    }));

    const trigger = screen.getByRole('button', { name: /Locked Model/ });
    expect(trigger).toHaveProperty('disabled', true);
    fireEvent.click(trigger);
    expect(screen.queryByRole('option', { name: /视觉/ })).toBeNull();
    expect(codiaFetchMock).not.toHaveBeenCalled();
  });
});
