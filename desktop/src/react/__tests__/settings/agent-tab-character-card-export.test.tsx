/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSettingsStore } from '../../settings/store';

type MockResponse = { json: () => Promise<unknown> };

const codiaFetchMock = vi.fn(async (_url: string, _opts?: RequestInit): Promise<MockResponse> => ({
  json: async () => ({ models: [] }),
}));

vi.mock('../../settings/api', () => ({
  codiaFetch: (url: string, opts?: RequestInit) => codiaFetchMock(url, opts),
  codiaUrl: (path: string) => path,
  yuanFallbackAvatar: (yuan: string) => `/fallback-${yuan}.png`,
}));

vi.mock('../../settings/helpers', () => ({
  t: (key: string, params?: Record<string, string>) => {
    if (key === 'settings.agent.modelUnavailable') return params?.model || key;
    return key;
  },
  autoSaveConfig: vi.fn(async () => true),
}));

vi.mock('../../settings/actions', () => ({
  browseAgent: vi.fn(),
  setPrimaryAgent: vi.fn(),
  loadSettingsConfig: vi.fn(async () => {}),
  loadAgents: vi.fn(async () => {}),
}));

vi.mock('../../settings/widgets/SelectWidget', () => ({
  SelectWidget: ({ value }: { value?: string }) => <div data-testid="model-select">{value || ''}</div>,
  selectWidgetStyles: {
    providerInset: 'mock-provider-inset',
  },
}));

vi.mock('../../settings/tabs/agent/AgentCardStack', () => ({
  AgentCardStack: ({
    selectedId,
    onExport,
  }: {
    selectedId: string | null;
    onExport?: (id: string) => void;
  }) => (
    <div>
      <div data-testid="selected-agent">{selectedId || ''}</div>
      <div data-testid="has-export">{String(typeof onExport === 'function')}</div>
    </div>
  ),
}));

vi.mock('../../settings/tabs/agent/YuanSelector', () => ({
  YuanSelector: () => <div data-testid="yuan-selector" />,
}));

vi.mock('../../settings/tabs/agent/AgentMemory', () => ({
  MemorySection: () => <div data-testid="agent-memory" />,
}));

vi.mock('../../settings/tabs/agent/AgentToolsSection', () => ({
  AgentToolsSection: () => <div data-testid="agent-tools" />,
}));

vi.mock('../../settings/tabs/agent/AgentExperience', () => ({
  parseExperience: () => [],
  ExperienceBlock: () => null,
  putExperience: vi.fn(),
}));

describe('AgentTab professional export surface', () => {
  beforeEach(() => {
    codiaFetchMock.mockImplementation(async (url: string): Promise<MockResponse> => {
      if (url === '/api/models') return { json: async () => ({ models: [] }) };
      return { json: async () => ({ ok: true }) };
    });
    (window as unknown as { platform?: unknown }).platform = {};
    useSettingsStore.setState({
      agents: [{ id: 'agent-a', name: 'Codia Operator', yuan: 'codia', isPrimary: true }],
      currentAgentId: 'agent-a',
      settingsAgentId: null,
      settingsConfig: {
        agent: { name: 'Codia Operator', yuan: 'codia' },
        memory: { enabled: true },
      },
      currentPins: [],
      globalModelsConfig: { models: { utility: { id: 'u' }, utility_large: { id: 'ul' } } },
      showToast: vi.fn(),
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    document.body.innerHTML = '';
    delete (window as unknown as { platform?: unknown }).platform;
  });

  it('does not expose character-card export from professional agent settings', async () => {
    const { AgentTab } = await import('../../settings/tabs/AgentTab');
    render(<AgentTab />);

    expect(screen.getByTestId('selected-agent')).toHaveTextContent('agent-a');
    expect(screen.getByTestId('has-export')).toHaveTextContent('false');

    await waitFor(() => expect(codiaFetchMock.mock.calls.some(([url]) => url === '/api/models')).toBe(true));
    expect(codiaFetchMock.mock.calls.some(([url]) => String(url).startsWith('/api/character-cards'))).toBe(false);
  });
});
