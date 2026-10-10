/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const apiMocks = vi.hoisted(() => ({
  loadMcpState: vi.fn(),
  setMcpEnabled: vi.fn(),
  addMcpConnector: vi.fn(),
  updateMcpConnector: vi.fn(),
  removeMcpConnector: vi.fn(),
  runMcpConnectorAction: vi.fn(),
  setAgentMcpConnector: vi.fn(),
  setAgentMcpTool: vi.fn(),
  startMcpOAuth: vi.fn(),
  pollMcpOAuth: vi.fn(),
  logoutMcpOAuth: vi.fn(),
}));

vi.mock('../../helpers', () => ({
  t: (key: string) => key,
}));

vi.mock('../mcp/mcp-api', () => ({
  EMPTY_MCP_STATE: {
    enabled: false,
    connectors: [],
    agentConfig: { connectors: {} },
  },
  ...apiMocks,
}));

import { McpTab } from '../McpTab';
import { useSettingsStore } from '../../store';

function state(enabled: boolean, extras: Record<string, unknown> = {}) {
  return {
    enabled,
    connectors: [],
    agentConfig: { connectors: {} },
    ...extras,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

afterEach(() => {
  cleanup();
  Object.values(apiMocks).forEach(mock => mock.mockReset());
  useSettingsStore.setState({
    currentAgentId: null,
    agents: [],
    toastMessage: '',
    toastType: '',
    toastVisible: false,
  });
});

describe('McpTab', () => {
  it('toggles the global connector switch when the master row text is clicked', async () => {
    apiMocks.loadMcpState
      .mockResolvedValueOnce(state(false))
      .mockResolvedValueOnce(state(true));
    apiMocks.setMcpEnabled.mockResolvedValue(undefined);
    useSettingsStore.setState({
      currentAgentId: 'codia',
      agents: [{ id: 'codia', name: 'Codia', yuan: 'codia', isPrimary: true }],
    });

    render(<McpTab />);

    await waitFor(() => expect(apiMocks.loadMcpState).toHaveBeenCalledWith('codia'));
    fireEvent.click(screen.getByText('settings.mcp.masterName'));

    await waitFor(() => expect(apiMocks.setMcpEnabled).toHaveBeenCalledWith(true));
  });

  it('does not send duplicate global toggle requests when the small switch is clicked', async () => {
    apiMocks.loadMcpState
      .mockResolvedValueOnce(state(false))
      .mockResolvedValueOnce(state(true));
    apiMocks.setMcpEnabled.mockResolvedValue(undefined);
    useSettingsStore.setState({
      currentAgentId: 'codia',
      agents: [{ id: 'codia', name: 'Codia', yuan: 'codia', isPrimary: true }],
    });

    render(<McpTab />);

    await waitFor(() => expect(apiMocks.loadMcpState).toHaveBeenCalledWith('codia'));
    fireEvent.click(screen.getByRole('switch', { name: 'common.off' }));

    await waitFor(() => expect(apiMocks.setMcpEnabled).toHaveBeenCalledTimes(1));
    expect(apiMocks.setMcpEnabled).toHaveBeenCalledWith(true);
  });

  it('shows a connector enable switch in the connector row and toggles it for the selected agent', async () => {
    apiMocks.loadMcpState
      .mockResolvedValueOnce(state(true, {
        connectors: [{
          id: 'github',
          name: 'GitHub',
          transport: 'remote',
          url: 'https://mcp.example.com/mcp',
          status: 'stopped',
          tools: [],
          authType: 'none',
        }],
        agentConfig: { connectors: { github: { enabled: false } } },
      }))
      .mockResolvedValueOnce(state(true, {
        connectors: [{
          id: 'github',
          name: 'GitHub',
          transport: 'remote',
          url: 'https://mcp.example.com/mcp',
          status: 'stopped',
          tools: [],
          authType: 'none',
        }],
        agentConfig: { connectors: { github: { enabled: true } } },
      }));
    apiMocks.setAgentMcpConnector.mockResolvedValue(undefined);
    useSettingsStore.setState({
      currentAgentId: 'codia',
      agents: [{ id: 'codia', name: 'Codia', yuan: 'codia', isPrimary: true }],
    });

    render(<McpTab />);

    const connectorRow = await screen.findByTestId('mcp-connector-row-github');
    fireEvent.click(within(connectorRow).getByRole('switch'));

    await waitFor(() => expect(apiMocks.setAgentMcpConnector).toHaveBeenCalledWith('codia', 'github', true));
  });

  it('ignores stale agent loads before clearing the loading state', async () => {
    const firstLoad = deferred<ReturnType<typeof state>>();
    const secondLoad = deferred<ReturnType<typeof state>>();
    apiMocks.loadMcpState.mockImplementation((agentId: string) => {
      if (agentId === 'first') return firstLoad.promise;
      if (agentId === 'second') return secondLoad.promise;
      return Promise.resolve(state(false));
    });
    useSettingsStore.setState({
      currentAgentId: 'first',
      agents: [
        { id: 'first', name: 'First Agent', yuan: 'codia', isPrimary: true },
        { id: 'second', name: 'Second Agent', yuan: 'codia', isPrimary: false },
      ],
    });

    render(<McpTab />);

    await waitFor(() => expect(apiMocks.loadMcpState).toHaveBeenCalledWith('first'));
    fireEvent.click(screen.getByTitle('First Agent'));
    fireEvent.click(await screen.findByRole('option', { name: /Second Agent/ }));
    await waitFor(() => expect(apiMocks.loadMcpState).toHaveBeenCalledWith('second'));

    await act(async () => {
      firstLoad.resolve(state(false));
      await firstLoad.promise;
    });

    const loadingSwitch = screen.getByRole('switch', { name: 'status.loading' }) as HTMLButtonElement;
    expect(loadingSwitch.disabled).toBe(true);
    expect(loadingSwitch.getAttribute('aria-busy')).toBe('true');

    await act(async () => {
      secondLoad.resolve(state(true));
      await secondLoad.promise;
    });

    await waitFor(() => {
      const enabledSwitch = screen.getByRole('switch', { name: 'common.on' }) as HTMLButtonElement;
      expect(enabledSwitch.disabled).toBe(false);
    });
  });

  it('surfaces reconnect states and allows valid connector recovery actions', async () => {
    apiMocks.loadMcpState.mockResolvedValue(state(true, {
      connectors: [
        {
          id: 'failed',
          name: 'Failed MCP',
          transport: 'remote',
          url: 'https://mcp.example.com/failed',
          status: 'failed',
          tools: [],
          authType: 'none',
        },
        {
          id: 'connecting',
          name: 'Connecting MCP',
          transport: 'remote',
          url: 'https://mcp.example.com/connecting',
          status: 'connecting',
          tools: [],
          authType: 'none',
        },
      ],
      agentConfig: { connectors: {} },
    }));
    useSettingsStore.setState({
      currentAgentId: 'codia',
      agents: [{ id: 'codia', name: 'Codia', yuan: 'codia', isPrimary: true }],
    });

    render(<McpTab />);

    const failedRow = await screen.findByTestId('mcp-connector-row-failed');
    expect(within(failedRow).getByText('settings.mcp.statusFailed')).toBeTruthy();
    expect((within(failedRow).getByRole('button', { name: 'settings.mcp.start' }) as HTMLButtonElement).disabled).toBe(false);
    expect((within(failedRow).getByRole('button', { name: 'settings.mcp.stop' }) as HTMLButtonElement).disabled).toBe(true);

    const connectingRow = await screen.findByTestId('mcp-connector-row-connecting');
    expect(within(connectingRow).getByText('settings.mcp.statusConnecting')).toBeTruthy();
    expect((within(connectingRow).getByRole('button', { name: 'settings.mcp.start' }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(connectingRow).getByRole('button', { name: 'settings.mcp.stop' }) as HTMLButtonElement).disabled).toBe(false);
  });
});
