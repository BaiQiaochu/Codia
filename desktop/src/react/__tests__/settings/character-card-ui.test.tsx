/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSettingsStore } from '../../settings/store';

type MockResponse = { json: () => Promise<unknown> };

const codiaFetchMock = vi.fn(async (_url: string, _opts?: RequestInit): Promise<MockResponse> => ({
  json: async () => ({ ok: true }),
}));
const switchToAgentMock = vi.fn(async (..._args: unknown[]) => {});
const settingsChangedMock = vi.fn();
const showToastMock = vi.fn();

vi.mock('../../settings/api', () => ({
  codiaFetch: (url: string, opts?: RequestInit) => codiaFetchMock(url, opts),
  codiaUrl: (path: string) => path,
  yuanFallbackAvatar: (yuan: string) => `/fallback-${yuan}.png`,
}));

vi.mock('../../settings/helpers', () => ({
  t: (key: string, params?: Record<string, string>) => {
    if (key === 'yuan.types') {
      return {
        codia: { label: 'Codia Balance' },
        ming: { label: 'Codia Rational' },
      };
    }
    if (key === 'settings.agent.created') return `${params?.name || ''} created`;
    return key;
  },
}));

vi.mock('../../settings/actions', () => ({
  switchToAgent: (id: string) => switchToAgentMock(id),
}));

describe('professional assistant creation UI', () => {
  beforeEach(() => {
    codiaFetchMock.mockReset();
    switchToAgentMock.mockReset();
    settingsChangedMock.mockReset();
    showToastMock.mockReset();
    useSettingsStore.setState({
      showToast: showToastMock,
      serverPort: 8123,
      serverToken: 'token',
      homeFolder: 'E:/workspace/current',
    });
    (window as unknown as { platform?: unknown }).platform = {
      settingsChanged: settingsChangedMock,
    };
  });

  afterEach(() => {
    cleanup();
    document.body.innerHTML = '';
    delete (window as unknown as { platform?: unknown }).platform;
  });

  it('keeps the fast assistant creation path when no character card is selected', async () => {
    codiaFetchMock.mockResolvedValueOnce({
      json: async () => ({ id: 'agent-a', name: 'Ada' }),
    });

    const { AgentCreateOverlay } = await import('../../settings/overlays/AgentCreateOverlay');
    render(<AgentCreateOverlay />);

    act(() => {
      window.dispatchEvent(new Event('codia-show-agent-create'));
    });

    fireEvent.change(screen.getByPlaceholderText('settings.agent.namePlaceholder'), {
      target: { value: 'Ada' },
    });
    fireEvent.click(screen.getByText('settings.agent.confirm'));

    await waitFor(() => expect(switchToAgentMock).toHaveBeenCalledWith('agent-a'));
    expect(codiaFetchMock).toHaveBeenCalledWith('/api/agents', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ name: 'Ada', yuan: 'codia', homeFolder: 'E:/workspace/current' }),
    }));
    expect(settingsChangedMock).toHaveBeenCalledWith('agent-created', {
      agentId: 'agent-a',
      name: 'Ada',
    });
  });

  it('does not expose role-card package import in the professional create dialog', async () => {
    const { AgentCreateOverlay } = await import('../../settings/overlays/AgentCreateOverlay');
    render(<AgentCreateOverlay />);

    act(() => {
      window.dispatchEvent(new Event('codia-show-agent-create'));
    });

    expect(document.querySelector('input[type="file"]')).toBeNull();
    expect(screen.queryByText(/角色卡/)).not.toBeInTheDocument();
    expect(codiaFetchMock.mock.calls.some(([url]) => String(url).startsWith('/api/character-cards'))).toBe(false);
  });
});
