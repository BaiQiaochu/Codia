/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type MockState = Record<string, any>;

const mockState: MockState = {};
const mockCodiaFetch = vi.fn();

vi.mock('../../settings/store', () => {
  const hook: any = (selector?: (s: MockState) => unknown) =>
    selector ? selector(mockState) : mockState;
  hook.getState = () => mockState;
  hook.setState = (partial: Partial<MockState>) => Object.assign(mockState, partial);
  return { useSettingsStore: hook };
});

vi.mock('../../settings/api', () => ({
  codiaFetch: (...args: unknown[]) => mockCodiaFetch(...args),
}));

vi.mock('../../settings/helpers', () => ({
  t: (key: string) => key,
  autoSaveConfig: vi.fn(async () => {}),
}));

vi.mock('../../settings/tabs/bridge/AgentSelect', () => ({
  AgentSelect: ({ value }: { value: string | null }) => (
    <div data-testid="agent-select">{value}</div>
  ),
}));

function jsonResponse(body: unknown): Response {
  return { json: async () => body } as unknown as Response;
}

describe('WorkTab workspace context injection toggles', () => {
  beforeEach(() => {
    Object.keys(mockState).forEach(key => delete mockState[key]);
    Object.assign(mockState, {
      settingsConfig: { desk: {} },
      currentAgentId: 'agent-a',
      showToast: vi.fn(),
    });
    mockCodiaFetch.mockReset();
    mockCodiaFetch.mockImplementation((url: string, options?: RequestInit) => {
      if (url === '/api/agents/agent-a/config' && !options?.method) {
        return Promise.resolve(jsonResponse({
          desk: {
            home_folder: '/old-home',
            heartbeat_enabled: true,
            heartbeat_interval: 17,
          },
          workspace_context: {
            inject_agents_md: false,
            inject_claude_md: true,
          },
        }));
      }
      if (url === '/api/agents/agent-a/config' && options?.method === 'PUT') {
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      throw new Error(`unexpected request: ${url}`);
    });
    window.platform = {
      selectFolder: vi.fn(async () => '/new-home'),
      settingsChanged: vi.fn(),
    } as unknown as typeof window.platform;
  });

  afterEach(() => {
    cleanup();
  });

  it('saves the selected agent AGENTS.md injection toggle', async () => {
    mockState.settingsConfig = {
      desk: {
        home_folder: '/old-home',
        heartbeat_enabled: true,
        heartbeat_interval: 17,
      },
      workspace_context: {
        inject_agents_md: false,
        inject_claude_md: true,
      },
    };
    const { WorkTab } = await import('../../settings/tabs/WorkTab');

    render(<WorkTab />);

    fireEvent.click(await screen.findByRole('switch', { name: 'settings.work.injectAgentsMd' }));

    await waitFor(() => {
      expect(mockCodiaFetch).toHaveBeenCalledWith('/api/agents/agent-a/config', expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ workspace_context: { inject_agents_md: true } }),
      }));
    });
    expect(window.platform.settingsChanged).not.toHaveBeenCalled();
  });

  it('saves the selected agent CLAUDE.md injection toggle', async () => {
    mockState.settingsConfig = {
      desk: {
        home_folder: '/old-home',
        heartbeat_enabled: true,
        heartbeat_interval: 17,
      },
      workspace_context: {
        inject_agents_md: false,
        inject_claude_md: true,
      },
    };
    const { WorkTab } = await import('../../settings/tabs/WorkTab');

    render(<WorkTab />);

    fireEvent.click(await screen.findByRole('switch', { name: 'settings.work.injectClaudeMd' }));

    await waitFor(() => {
      expect(mockCodiaFetch).toHaveBeenCalledWith('/api/agents/agent-a/config', expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ workspace_context: { inject_claude_md: false } }),
      }));
    });
    expect(window.platform.settingsChanged).not.toHaveBeenCalled();
  });

  it('shows the operational notice on the per-agent patrol toggle', async () => {
    mockState.settingsConfig = {
      desk: {
        home_folder: '/old-home',
        heartbeat_enabled: true,
        heartbeat_interval: 17,
      },
      workspace_context: {
        inject_agents_md: false,
        inject_claude_md: true,
      },
    };
    const { WorkTab } = await import('../../settings/tabs/WorkTab');

    render(<WorkTab />);

    expect(await screen.findByText('settings.work.heartbeatOperationalNotice')).toBeTruthy();
  });
});
