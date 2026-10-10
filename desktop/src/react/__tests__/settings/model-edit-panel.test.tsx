// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type ProviderSummary = {
  models: Array<string | { id: string; name?: string; image?: boolean; video?: boolean; reasoning?: boolean }>;
};

type StoreState = {
  providersSummary: Record<string, ProviderSummary>;
  settingsConfig: null;
  showToast: ReturnType<typeof vi.fn>;
};

let storeState: StoreState;
const codiaFetchMock = vi.fn();
const settingsChangedMock = vi.fn();

const useSettingsStoreMock = Object.assign(
  (selector?: (state: StoreState) => unknown) => selector ? selector(storeState) : storeState,
  {
    getState: () => storeState,
    setState: (partial: Partial<StoreState>) => Object.assign(storeState, partial),
  },
);

vi.mock('../../settings/store', () => ({
  useSettingsStore: useSettingsStoreMock,
}));

vi.mock('../../settings/api', () => ({
  codiaFetch: (...args: unknown[]) => codiaFetchMock(...args),
}));

vi.mock('../../settings/widgets/ComboInput', () => ({
  ComboInput: ({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder?: string }) => (
    React.createElement('input', { value, placeholder, onChange: (event: React.ChangeEvent<HTMLInputElement>) => onChange(event.target.value) })
  ),
}));

vi.mock('../../settings/widgets/Toggle', () => ({
  Toggle: ({ on, onChange }: { on: boolean; onChange: (value: boolean) => void }) => (
    React.createElement('button', { type: 'button', role: 'switch', 'aria-checked': on, onClick: () => onChange(!on) }, on ? 'on' : 'off')
  ),
}));

describe('ModelEditPanel', () => {
  beforeEach(() => {
    storeState = {
      providersSummary: {
        openai: {
          models: [
            { id: 'gpt-test', name: 'GPT Test', image: true, video: false, reasoning: true },
          ],
        },
      },
      settingsConfig: null,
      showToast: vi.fn(),
    };
    codiaFetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    settingsChangedMock.mockReset();
    (window as unknown as { platform?: { settingsChanged: typeof settingsChangedMock }; t?: (key: string) => string }).platform = {
      settingsChanged: settingsChangedMock,
    };
    (window as typeof window & { t?: (key: string) => string }).t = (key: string) => key;
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('saving model metadata emits a metadata refresh event without switching models', async () => {
    const onRefresh = vi.fn(async () => {});
    const onClose = vi.fn();
    const { ModelEditPanel } = await import('../../settings/tabs/providers/ModelEditPanel');

    render(React.createElement(ModelEditPanel, {
      modelId: 'gpt-test',
      providerId: 'openai',
      anchorEl: null,
      onClose,
      onRefresh,
    }));

    fireEvent.click(screen.getByRole('button', { name: 'settings.api.save' }));

    await waitFor(() => {
      expect(codiaFetchMock).toHaveBeenCalledWith('/api/providers/openai/models/gpt-test', expect.objectContaining({
        method: 'PUT',
      }));
    });
    const request = codiaFetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).not.toMatchObject({
      image: expect.any(Boolean),
      video: expect.any(Boolean),
      reasoning: expect.any(Boolean),
    });
    expect(codiaFetchMock).not.toHaveBeenCalledWith('/api/models/switch', expect.anything());
    expect(settingsChangedMock).toHaveBeenCalledWith('model-metadata-changed', {
      providerId: 'openai',
      modelId: 'gpt-test',
    });
    expect(settingsChangedMock).not.toHaveBeenCalledWith('models-changed');
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
