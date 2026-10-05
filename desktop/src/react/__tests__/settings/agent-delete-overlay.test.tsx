/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSettingsStore } from '../../settings/store';

type MockResponse = { json: () => Promise<unknown> };

const gsapFetchMock = vi.fn(async (_url: string, _opts?: RequestInit): Promise<MockResponse> => ({
  json: async () => ({ ok: true }),
}));
const switchToAgentMock = vi.fn(async (..._args: unknown[]) => {});
const loadAgentsMock = vi.fn(async () => {});
const loadSettingsConfigMock = vi.fn(async () => {});
const settingsChangedMock = vi.fn();
const showToastMock = vi.fn();

vi.mock('../../settings/api', () => ({
  gsapFetch: (url: string, opts?: RequestInit) => gsapFetchMock(url, opts),
}));

vi.mock('../../settings/helpers', () => ({
  t: (key: string, params?: Record<string, string>) => {
    if (key === 'settings.agent.deleteTitle1') return `delete-1:${params?.name || ''}`;
    if (key === 'settings.agent.deleteTitle2') return `delete-2:${params?.name || ''}`;
    if (key === 'settings.agent.deleted') return `deleted:${params?.name || ''}`;
    return key;
  },
}));

vi.mock('../../settings/actions', () => ({
  switchToAgent: (id: string) => switchToAgentMock(id),
  loadAgents: () => loadAgentsMock(),
  loadSettingsConfig: () => loadSettingsConfigMock(),
}));

describe('AgentDeleteOverlay', () => {
  beforeEach(() => {
    gsapFetchMock.mockReset();
    switchToAgentMock.mockReset();
    loadAgentsMock.mockReset();
    loadSettingsConfigMock.mockReset();
    settingsChangedMock.mockReset();
    showToastMock.mockReset();
    useSettingsStore.setState({
      agents: [
        { id: 'agent-a', name: 'Alpha', yuan: 'gsap', isPrimary: true },
        { id: 'agent-b', name: 'Beta', yuan: 'ming', isPrimary: false },
      ],
      currentAgentId: 'agent-a',
      settingsAgentId: null,
      showToast: showToastMock,
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

  it('deletes the assistant explicitly provided by the delete event detail', async () => {
    const { AgentDeleteOverlay } = await import('../../settings/overlays/AgentDeleteOverlay');
    render(<AgentDeleteOverlay />);

    act(() => {
      window.dispatchEvent(new CustomEvent('gsap-show-agent-delete', {
        detail: { agentId: 'agent-b' },
      }));
    });

    expect(screen.getByText('delete-1:Beta')).toBeInTheDocument();
    fireEvent.click(screen.getByText('settings.agent.deleteNext'));
    fireEvent.change(screen.getByPlaceholderText('settings.agent.deletePlaceholder'), {
      target: { value: 'Beta' },
    });
    fireEvent.click(screen.getByText('settings.agent.deleteConfirm'));

    await waitFor(() => expect(gsapFetchMock).toHaveBeenCalledWith('/api/agents/agent-b', {
      method: 'DELETE',
    }));
    expect(switchToAgentMock).not.toHaveBeenCalled();
    expect(loadAgentsMock).toHaveBeenCalledTimes(1);
    expect(loadSettingsConfigMock).toHaveBeenCalledTimes(1);
    expect(settingsChangedMock).toHaveBeenCalledWith('agent-deleted', { agentId: 'agent-b' });
  });
});
