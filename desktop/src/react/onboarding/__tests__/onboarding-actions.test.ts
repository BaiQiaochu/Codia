/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { saveModel, testConnection } from '../onboarding-actions';
import type { gsapFetch } from '../onboarding-actions';

function jsonResponse(body: unknown): Response {
  return { json: async () => body } as Response;
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
