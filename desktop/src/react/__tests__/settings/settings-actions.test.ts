// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const responses = new Map<string, unknown>();

vi.mock('../../settings/api', () => ({
  codiaFetch: vi.fn(async (url: string) => {
    if (!responses.has(url)) {
      throw new Error(`unexpected fetch: ${url}`);
    }
    const value = responses.get(url);
    if (value instanceof Error) throw value;
    return {
      json: async () => value,
    };
  }),
  codiaUrl: (path: string) => path,
}));

describe('settings actions', () => {
  beforeEach(async () => {
    responses.clear();
    vi.resetModules();
    const { useSettingsStore } = await import('../../settings/store');
    useSettingsStore.setState({
      agents: [],
      currentAgentId: null,
      settingsAgentId: null,
      agentName: 'Codia',
      userName: 'User',
      agentYuan: 'codia',
      settingsConfig: null,
      globalModelsConfig: null,
      currentPins: [],
    });
  });

  it('loads the default agent config and keeps identity fields when experience is paused', async () => {
    const { loadSettingsConfig } = await import('../../settings/actions');
    const { useSettingsStore } = await import('../../settings/store');

    responses.set('/api/agents', {
      agents: [{ id: 'codia', name: 'Codia', yuan: 'ming', isPrimary: true }],
    });
    responses.set('/api/agents/codia/config', {
      agent: { name: 'Codia', yuan: 'ming' },
      user: { name: 'KSKOOO' },
      desk: { home_folder: 'E:/work' },
    });
    responses.set('/api/agents/codia/identity', { content: '# Codia\nKSKOOO personal assistant.' });
    responses.set('/api/agents/codia/ishiki', { content: '# Persona\nReason first.' });
    responses.set('/api/agents/codia/public-ishiki', { content: 'public' });
    responses.set('/api/user-profile', { content: 'user profile' });
    responses.set('/api/agents/codia/pinned', { pins: ['stable'] });
    responses.set('/api/preferences/models', { models: { utility: 'u' } });
    responses.set('/api/agents/codia/experience', new Error('codiaFetch /api/agents/codia/experience: 403 experience is paused'));

    await loadSettingsConfig();

    const state = useSettingsStore.getState();
    expect(state.currentAgentId).toBe('codia');
    expect(state.agentName).toBe('Codia');
    expect(state.userName).toBe('KSKOOO');
    expect(state.agentYuan).toBe('ming');
    expect(state.settingsConfig?._identity).toContain('KSKOOO personal assistant');
    expect(state.settingsConfig?._ishiki).toContain('Reason first');
    expect(state.settingsConfig?._experience).toBe('');
  });
});
