// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type MockStoreState = {
  agentAvatarUrl: string | null;
  agentName: string;
  agentYuan: string;
  agents: Array<{ id: string; name: string; yuan: string; isPrimary?: boolean; hasAvatar?: boolean }>;
  currentAgentId: string;
  currentSessionPath: string | null;
  sessions: Array<{ path: string; cwd?: string | null }>;
  deskBasePath: string | null;
  deskWorkspaceMountId: string | null;
  homeFolder: string | null;
  addToast: ReturnType<typeof vi.fn>;
};

let storeState: MockStoreState;
const gsapFetchMock = vi.fn();

const useStoreMock = Object.assign(
  <T,>(selector: (state: MockStoreState) => T): T => selector(storeState),
  {
    getState: () => storeState,
    setState: vi.fn(),
  },
);

vi.mock('../../stores', () => ({
  useStore: useStoreMock,
}));

vi.mock('../../hooks/use-panel', async () => {
  const ReactActual = await vi.importActual<typeof import('react')>('react');
  return {
    usePanel: (_panel: string, loadData?: () => void | Promise<void>) => {
      ReactActual.useEffect(() => {
        void loadData?.();
      }, [loadData]);
      return { visible: true, close: vi.fn() };
    },
  };
});

vi.mock('../../hooks/use-gsap-fetch', () => ({
  gsapFetch: (...args: unknown[]) => gsapFetchMock(...args),
  gsapUrl: (path: string) => path,
}));

describe('automation error smoke', () => {
  beforeEach(() => {
    storeState = {
      agentAvatarUrl: null,
      agentName: 'G-SAP',
      agentYuan: 'gsap',
      agents: [],
      currentAgentId: 'gsap',
      currentSessionPath: null,
      sessions: [],
      deskBasePath: null,
      deskWorkspaceMountId: null,
      homeFolder: null,
      addToast: vi.fn(),
    };
    gsapFetchMock.mockReset();
    (window as typeof window & { t?: (key: string) => string }).t = (key: string) => key;
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('shows an explicit error toast when cron creation fails validation', async () => {
    gsapFetchMock.mockImplementation(async (url: unknown, options?: RequestInit) => {
      const text = String(url);
      if (text === '/api/desk/cron' && (!options || options.method === undefined)) {
        return { json: async () => ({ jobs: [] }) };
      }
      if (text === '/api/models') {
        return { json: async () => ({ models: [] }) };
      }
      if (text === '/api/desk/cron' && options?.method === 'POST') {
        return { ok: false, json: async () => ({ error: 'Invalid cron schedule: "70 * * * *"' }) };
      }
      return { json: async () => ({}) };
    });

    const { AutomationPanel } = await import('../../components/AutomationPanel');

    render(React.createElement(AutomationPanel));

    fireEvent.click(screen.getByTitle('automation.add'));

    await waitFor(() => {
      expect(storeState.addToast).toHaveBeenCalledWith(
        expect.stringContaining('Invalid cron schedule'),
        'error',
      );
    });
  });

  it('uses the active assistant avatar instead of the stale global assistant avatar', async () => {
    storeState = {
      ...storeState,
      agentAvatarUrl: '/api/avatar/agent?t=stale',
      agentName: 'Stale Assistant',
      agentYuan: 'gsap',
      currentAgentId: 'agent-a',
      agents: [{ id: 'agent-a', name: 'Real Assistant', yuan: 'ming', isPrimary: true, hasAvatar: true }],
    };
    gsapFetchMock.mockImplementation(async (url: unknown, options?: RequestInit) => {
      const text = String(url);
      if (text === '/api/desk/cron' && (!options || options.method === undefined)) {
        return {
          json: async () => ({
            jobs: [{ id: 'job-1', type: 'cron', enabled: true, label: 'Daily task', schedule: '0 9 * * *' }],
          }),
        };
      }
      if (text === '/api/models') {
        return { json: async () => ({ models: [] }) };
      }
      return { json: async () => ({}) };
    });

    const { AutomationPanel } = await import('../../components/AutomationPanel');
    const { container } = render(React.createElement(AutomationPanel));

    await waitFor(() => {
      const img = container.querySelector('img');
      expect(img?.getAttribute('src')).toContain('/api/agents/agent-a/avatar');
      expect(img?.getAttribute('src')).not.toContain('/api/avatar/agent');
      expect(screen.getByText('Real Assistant')).toBeTruthy();
    });
  });
});
