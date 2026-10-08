// @vitest-environment jsdom

import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelSelector } from '../../components/input/ModelSelector';

const mocks = vi.hoisted(() => ({
  state: {} as Record<string, any>,
  fetch: vi.fn(),
  loadModels: vi.fn(),
}));
vi.mock('../../stores', () => ({
  useStore: {
    getState: () => mocks.state,
    setState: (patch: Record<string, unknown>) => Object.assign(mocks.state, patch),
  },
}));
vi.mock('../../hooks/use-gsap-fetch', () => ({ gsapFetch: (...args: unknown[]) => mocks.fetch(...args) }));
vi.mock('../../hooks/use-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('../../utils/ui-helpers', () => ({ loadModels: (...args: unknown[]) => mocks.loadModels(...args) }));
vi.mock('../../pwa-runtime', () => ({ isPwaRuntime: () => false }));
vi.mock('../../ui', () => ({
  SelectWidget: (props: { onChange: (value: string) => void; disabled: boolean }) => (
    <button type="button" disabled={props.disabled} onClick={() => props.onChange('chat:test/new-model')}>Change model</button>
  ),
  ProviderGroupHeader: () => null,
  selectWidgetStyles: {},
}));

function deferredResponse() {
  let resolve!: (value: unknown) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, reject, resolve: (data: unknown) => resolve({ ok: true, json: async () => data }) };
}

const models = [
  { id: 'old-model', name: 'Old', provider: 'test', isCurrent: true },
  { id: 'new-model', name: 'New', provider: 'test' },
];
const switched = { model: { id: 'new-model', provider: 'test', name: 'New' }, thinkingLevel: 'high' };

function selectModel() {
  fireEvent.click(screen.getByRole('button', { name: 'Change model' }));
}

describe('model selector asynchronous ownership', () => {
  beforeEach(() => {
    mocks.fetch.mockReset();
    mocks.loadModels.mockReset().mockResolvedValue(undefined);
    mocks.state = {
      currentSessionPath: '/sessions/original.jsonl',
      currentAgentId: 'agent-original',
      activeServerConnectionId: 'connection-original',
      pendingNewSession: false,
      welcomeVisible: false,
      sessionModelsByPath: {},
      models,
      thinkingLevel: 'medium',
      modelSwitching: false,
      updateSessionModel: vi.fn(),
      setThinkingLevel: vi.fn((value: string) => { mocks.state.thinkingLevel = value; }),
      setPendingNewSessionThinkingLevel: vi.fn(),
      setModelSwitching: vi.fn((value: boolean) => { mocks.state.modelSwitching = value; }),
      addToast: vi.fn(),
    };
  });
  afterEach(cleanup);

  it('does not dismiss a new-chat draft when an old session switch completes', async () => {
    const response = deferredResponse();
    mocks.fetch.mockReturnValueOnce(response.promise);
    const onVideoChange = vi.fn();
    render(<ModelSelector models={models} onChatVideoModeChange={onVideoChange} />);
    selectModel();
    Object.assign(mocks.state, { currentSessionPath: null, pendingNewSession: true, welcomeVisible: true });
    await act(async () => { response.resolve(switched); });

    expect(mocks.state.pendingNewSession).toBe(true);
    expect(mocks.state.welcomeVisible).toBe(true);
    expect(mocks.state.thinkingLevel).toBe('medium');
    expect(onVideoChange).not.toHaveBeenCalled();
    expect(mocks.loadModels).not.toHaveBeenCalled();
    expect(mocks.state.modelSwitching).toBe(false);
  });

  it('does not replace saved-chat controls with an old welcome model response', async () => {
    Object.assign(mocks.state, { currentSessionPath: null, pendingNewSession: true, welcomeVisible: true });
    const response = deferredResponse();
    mocks.fetch.mockReturnValueOnce(response.promise);
    render(<ModelSelector models={models} />);
    selectModel();
    Object.assign(mocks.state, { currentSessionPath: '/sessions/new.jsonl', pendingNewSession: false, welcomeVisible: false });
    mocks.fetch.mockResolvedValueOnce({ json: async () => ({ models: [{ id: 'stale-model' }] }) });
    await act(async () => { response.resolve({ thinkingLevel: 'high' }); });

    expect(mocks.state.thinkingLevel).toBe('medium');
    expect(mocks.state.models).toEqual(models);
    expect(mocks.state.setPendingNewSessionThinkingLevel).not.toHaveBeenCalled();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it('releases the busy state on unmount without applying the delayed response', async () => {
    const response = deferredResponse();
    mocks.fetch.mockReturnValueOnce(response.promise);
    const view = render(<ModelSelector models={models} />);
    selectModel();
    expect(mocks.state.modelSwitching).toBe(true);
    view.unmount();
    expect(mocks.state.modelSwitching).toBe(false);
    await act(async () => { response.resolve(switched); });
    expect(mocks.state.updateSessionModel).not.toHaveBeenCalled();
    expect(mocks.state.setThinkingLevel).not.toHaveBeenCalled();
  });

  it('preserves a newer selector busy state when an old request settles', async () => {
    const oldResponse = deferredResponse();
    mocks.fetch.mockReturnValueOnce(oldResponse.promise);
    const oldView = render(<ModelSelector models={models} />);
    selectModel();
    oldView.unmount();
    const newResponse = deferredResponse();
    mocks.fetch.mockReturnValueOnce(newResponse.promise);
    render(<ModelSelector models={models} />);
    selectModel();
    await act(async () => { oldResponse.resolve(switched); });
    expect(mocks.state.modelSwitching).toBe(true);
    await act(async () => { newResponse.resolve(switched); });
    expect(mocks.state.modelSwitching).toBe(false);
  });

  it('suppresses an error from the previous owner after navigation', async () => {
    const response = deferredResponse();
    mocks.fetch.mockReturnValueOnce(response.promise);
    render(<ModelSelector models={models} />);
    selectModel();
    mocks.state.currentAgentId = 'replacement-agent';
    await act(async () => { response.reject(new Error('old owner failed')); });
    expect(mocks.state.addToast).not.toHaveBeenCalled();
  });

  it('applies a completed switch for the current session and releases the busy state', async () => {
    mocks.fetch.mockResolvedValueOnce({ ok: true, json: async () => switched });
    render(<ModelSelector models={models} />);
    selectModel();
    await waitFor(() => expect(mocks.state.modelSwitching).toBe(false));
    expect(mocks.state.updateSessionModel).toHaveBeenCalledWith('/sessions/original.jsonl', switched.model);
    expect(mocks.state.thinkingLevel).toBe('high');
    expect(mocks.loadModels).toHaveBeenCalledWith({ sessionPath: '/sessions/original.jsonl' });
  });

  it('applies a welcome model choice while preserving the new-chat draft', async () => {
    Object.assign(mocks.state, { currentSessionPath: null, pendingNewSession: true, welcomeVisible: true });
    const updatedModels = models.map(model => ({ ...model, isCurrent: model.id === 'new-model' }));
    mocks.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ thinkingLevel: 'high' }) });
    mocks.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ models: updatedModels }) });
    mocks.loadModels.mockImplementationOnce(async () => { mocks.state.models = updatedModels; });
    render(<ModelSelector models={models} />);
    selectModel();
    await waitFor(() => expect(mocks.state.models).toEqual(updatedModels));
    expect(mocks.state.setThinkingLevel).toHaveBeenCalledWith('high');
    expect(mocks.state.setPendingNewSessionThinkingLevel).toHaveBeenCalledWith('high');
    expect(mocks.state.pendingNewSession).toBe(true);
    expect(mocks.state.welcomeVisible).toBe(true);
  });

  it('suppresses stale adaptation notices if navigation occurs during model refresh', async () => {
    let finishRefresh!: () => void;
    mocks.loadModels.mockReturnValueOnce(new Promise<void>(resolve => { finishRefresh = resolve; }));
    mocks.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ ...switched, adaptations: ['compacted'] }) });
    render(<ModelSelector models={models} />);
    selectModel();
    await waitFor(() => expect(mocks.loadModels).toHaveBeenCalled());
    mocks.state.currentSessionPath = '/sessions/replacement.jsonl';
    await act(async () => { finishRefresh(); });
    expect(mocks.state.addToast).not.toHaveBeenCalled();
    expect(mocks.state.modelSwitching).toBe(false);
  });

  it('reports an active-owner failure and makes retry possible', async () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      mocks.fetch.mockRejectedValueOnce(new Error('current owner failed'));
      render(<ModelSelector models={models} />);
      selectModel();
      await waitFor(() => expect(mocks.state.addToast).toHaveBeenCalledWith('current owner failed', 'error'));
      expect(mocks.state.modelSwitching).toBe(false);
      expect(screen.getByRole('button', { name: 'Change model' }).hasAttribute('disabled')).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

});
