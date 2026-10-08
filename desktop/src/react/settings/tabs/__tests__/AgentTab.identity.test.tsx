/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), loadConfig: vi.fn(), loadAgents: vi.fn() }));
vi.mock('../../api', () => ({
  gsapFetch: (...args: unknown[]) => mocks.fetch(...args),
  gsapUrl: (url: string) => url,
  yuanFallbackAvatar: (yuan: string) => `/avatars/${yuan}.png`,
}));
vi.mock('../../helpers', () => ({ t: (key: string) => key, autoSaveConfig: vi.fn() }));
vi.mock('../../actions', () => ({
  browseAgent: vi.fn(), setPrimaryAgent: vi.fn(),
  loadSettingsConfig: () => mocks.loadConfig(), loadAgents: () => mocks.loadAgents(),
}));
vi.mock('../agent/AgentCardStack', () => ({ AgentCardStack: () => null }));
vi.mock('../agent/YuanSelector', () => ({ YuanSelector: () => <div>identity types</div> }));
vi.mock('../agent/AgentMemory', () => ({ MemorySection: () => null }));
vi.mock('../agent/AgentToolsSection', () => ({ AgentToolsSection: () => null }));
vi.mock('../../../ui', () => ({ ProviderGroupHeader: () => null }));

import { AgentTab } from '../AgentTab';
import { useSettingsStore } from '../../store';

beforeEach(() => {
  mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ models: [] }) });
  mocks.loadConfig.mockResolvedValue(undefined);
  mocks.loadAgents.mockResolvedValue(undefined);
  useSettingsStore.setState({
    agents: [
      { id: 'active-agent', name: 'Active', yuan: 'gsap', isPrimary: true },
      { id: 'selected-agent', name: 'Selected', yuan: 'gsap', isPrimary: false, hasAvatar: true },
    ],
    currentAgentId: 'active-agent', settingsAgentId: 'selected-agent',
    settingsConfig: { agent: { name: 'Selected' }, _identity: 'Existing identity', _ishiki: 'Existing instructions' },
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.clearAllMocks(); });

describe('assistant identity card', () => {
  it('keeps identity and instruction edits in the profile card and saves to the selected assistant', async () => {
    render(<AgentTab />);
    const card = within(screen.getByTestId('agent-identity-card'));
    fireEvent.change(card.getByRole('textbox', { name: 'settings.agent.identity' }), { target: { value: 'Edited identity' } });
    fireEvent.change(card.getByRole('textbox', { name: 'settings.agent.ishiki' }), { target: { value: 'Edited instructions' } });
    fireEvent.click(card.getAllByRole('button', { name: 'settings.save' }).at(-1)!);
    await waitFor(() => expect(mocks.loadConfig).toHaveBeenCalled());
    expect(mocks.fetch).toHaveBeenCalledWith('/api/agents/selected-agent/identity', expect.objectContaining({
      method: 'PUT', body: JSON.stringify({ content: 'Edited identity' }),
    }));
    expect(mocks.fetch).toHaveBeenCalledWith('/api/agents/selected-agent/ishiki', expect.objectContaining({
      method: 'PUT', body: JSON.stringify({ content: 'Edited instructions' }),
    }));
  });

  it('refreshes the large avatar after the agent list reloads following an upload', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
    render(<AgentTab />);
    const avatar = screen.getByRole('img', { name: 'Selected' });
    const initialSrc = avatar.getAttribute('src');
    expect(initialSrc).toBe('/api/agents/selected-agent/avatar?t=1000');
    now.mockReturnValue(2000);
    await act(async () => useSettingsStore.setState({
      agents: useSettingsStore.getState().agents.map(agent => ({ ...agent })),
    }));
    expect(avatar).toHaveAttribute('src', '/api/agents/selected-agent/avatar?t=2000');
    expect(avatar.getAttribute('src')).not.toBe(initialSrc);
  });

  it('clears previews on assistant switch and ignores a late response even if fetch does not abort', async () => {
    const template = (content: string) => ({ identity: {
      kind: 'identity', yuan: 'gsap', current: '', template: content,
      diff: { changed: 0, added: 0, removed: 0, lines: [] },
    } });
    let resolveLate!: (response: unknown) => void;
    const lateResponse = new Promise(resolve => { resolveLate = resolve; });
    let selectedRequestCount = 0;
    mocks.fetch.mockImplementation((url: string) => {
      if (url === '/api/agents/selected-agent/prompt-templates') {
        selectedRequestCount += 1;
        if (selectedRequestCount === 2) return lateResponse;
        return Promise.resolve({ ok: true, json: async () => template('Previous assistant template') });
      }
      if (url === '/api/agents/active-agent/prompt-templates') {
        return Promise.resolve({ ok: true, json: async () => template('Current assistant template') });
      }
      return Promise.resolve({ ok: true, json: async () => ({ models: [] }) });
    });
    render(<AgentTab />);
    fireEvent.click(screen.getByRole('button', { name: '模板预览' }));
    expect(await screen.findByText('Previous assistant template')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '模板预览' }));
    const lateOptions = mocks.fetch.mock.calls.filter(([url]) => url === '/api/agents/selected-agent/prompt-templates').at(-1)?.[1];
    await act(async () => useSettingsStore.setState({ settingsAgentId: 'active-agent' }));
    expect(screen.queryByText('Previous assistant template')).not.toBeInTheDocument();
    expect(lateOptions?.signal?.aborted).toBe(true);
    await act(async () => resolveLate({ ok: true, json: async () => template('Late previous assistant template') }));
    expect(screen.queryByText('Late previous assistant template')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '模板预览' }));
    expect(await screen.findByText('Current assistant template')).toBeInTheDocument();
  });

  it('does not replace the next assistant identity when an earlier reset finishes late', async () => {
    let resolveReset!: (response: unknown) => void;
    const resetResponse = new Promise(resolve => { resolveReset = resolve; });
    mocks.fetch.mockImplementation((url: string) => url.endsWith('/prompt-templates/identity/reset')
      ? resetResponse
      : Promise.resolve({ ok: true, json: async () => ({ models: [] }) }));
    render(<AgentTab />);
    fireEvent.click(screen.getByRole('button', { name: '恢复默认' }));
    await act(async () => useSettingsStore.setState({
      settingsAgentId: 'active-agent',
      settingsConfig: { agent: { name: 'Active' }, _identity: 'Current assistant identity' },
    }));
    await act(async () => resolveReset({ ok: true, json: async () => ({ content: 'Previous assistant reset' }) }));
    expect(screen.getByRole('textbox', { name: 'settings.agent.identity' })).toHaveValue('Current assistant identity');
    expect(mocks.loadConfig).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '恢复默认' })).toBeEnabled();
  });
});
