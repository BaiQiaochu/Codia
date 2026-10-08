/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { saveModel, saveProvider, saveOnboardingIdentity, saveLocale, saveUserName, saveWorkspace, testConnection } from '../onboarding-actions';
import type { gsapFetch } from '../onboarding-actions';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
}

describe('onboarding actions', () => {
  beforeEach(() => {
    vi.stubGlobal('t', (key: string) => key);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('tests the initial setup connection with inline credentials before the provider is saved', async () => {
    const gsapFetchMock = vi.fn<gsapFetch>(async () => jsonResponse({ ok: true }));

    await testConnection({
      gsapFetch: gsapFetchMock,
      providerUrl: 'https://api.minimaxi.com/anthropic',
      providerApi: 'anthropic-messages',
      apiKey: 'sk-test',
    });

    expect(gsapFetchMock).toHaveBeenCalledWith('/api/providers/test', expect.objectContaining({
      method: 'POST',
    }));
    const body = JSON.parse(String(gsapFetchMock.mock.calls[0][1]?.body));
    expect(body).toEqual({
      base_url: 'https://api.minimaxi.com/anthropic',
      api: 'anthropic-messages',
      api_key: 'sk-test',
    });
  });

  it('returns the provider test error so first-run setup can show the real failure', async () => {
    const gsapFetchMock = vi.fn<gsapFetch>(async () => jsonResponse({
      ok: false,
      error: 'HTTP 401: Unauthorized',
    }));

    const result = await testConnection({
      gsapFetch: gsapFetchMock,
      providerUrl: 'https://api.example.com/v1',
      providerApi: 'openai-completions',
      apiKey: 'bad-key',
    });

    expect(result).toEqual({ ok: false, text: 'HTTP 401: Unauthorized' });
  });

  it('saves first-run provider models before selecting the chat model in one config update', async () => {
    const gsapFetchMock = vi.fn<gsapFetch>(async () => jsonResponse({ ok: true }));

    await saveModel({
      gsapFetch: gsapFetchMock,
      providerName: 'custom-provider',
      selectedModel: 'chat-model',
      addedModels: [
        'chat-model',
        { id: 'utility-model', name: 'Utility Model', context: 64000, reasoning: true },
      ],
      selectedUtility: 'utility-model',
      selectedUtilityLarge: 'chat-model',
    });

    expect(gsapFetchMock).toHaveBeenCalledWith('/api/agents/gsap/config', expect.objectContaining({
      method: 'PUT',
    }));
    const configBody = JSON.parse(String(gsapFetchMock.mock.calls[0][1]?.body));
    expect(configBody).toEqual({
      providers: {
        'custom-provider': {
          models: [
            'chat-model',
            { id: 'utility-model', name: 'Utility Model', context: 64000, reasoning: true },
          ],
        },
      },
      models: {
        chat: { id: 'chat-model', provider: 'custom-provider' },
      },
    });
    expect(gsapFetchMock).toHaveBeenCalledWith('/api/preferences/models', expect.objectContaining({
      method: 'PUT',
    }));
    expect(gsapFetchMock).toHaveBeenCalledTimes(2);
  });
});


describe('onboarding persistence failures', () => {
  const saveActions: Array<[string, (fetch: gsapFetch) => Promise<void>]> = [
    ['provider', fetch => saveProvider({ gsapFetch: fetch, providerName: 'local', providerUrl: 'http://localhost:11434/v1', apiKey: '', providerApi: 'openai-completions' })],
    ['identity', fetch => saveOnboardingIdentity({ gsapFetch: fetch, userName: 'User', agentName: 'Assistant', memoryEnabled: false })],
    ['locale', fetch => saveLocale(fetch, 'en')],
    ['user name', fetch => saveUserName(fetch, 'User')],
    ['workspace', fetch => saveWorkspace({ gsapFetch: fetch, workspacePath: '/workspace/chosen', defaultPath: '/workspace/default' })],
    ['model', fetch => saveModel({ gsapFetch: fetch, providerName: 'local', selectedModel: 'chat', addedModels: ['chat'], selectedUtility: 'chat', selectedUtilityLarge: '' })],
  ];

  it.each(saveActions)('rejects an unsuccessful %s save', async (_name, save) => {
    const fetch = vi.fn<gsapFetch>(async () => new Response(JSON.stringify({ error: 'config persistence failed' }), { status: 500 }));
    await expect(save(fetch)).rejects.toThrow('config persistence failed');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not report model setup complete when the utility preference write fails', async () => {
    const fetch = vi.fn<gsapFetch>()
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'utility model rejected' }), { status: 400 }));
    await expect(saveModel({ gsapFetch: fetch, providerName: 'local', selectedModel: 'chat', addedModels: ['chat'], selectedUtility: 'chat', selectedUtilityLarge: '' })).rejects.toThrow('utility model rejected');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('reports the HTTP failure when the server cannot return JSON', async () => {
    const fetch = vi.fn<gsapFetch>(async () => new Response('Service unavailable', { status: 503 }));
    await expect(saveLocale(fetch, 'en')).rejects.toThrow('503');
  });
});
