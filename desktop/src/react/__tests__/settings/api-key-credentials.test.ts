/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MASKED_SECRET } from '../../../../../shared/secret-custody';
import { buildRuntimeApiKeyRef } from '../../../../../shared/runtime-api-key-ref';
import { getApiKeySavePlan } from '../../settings/tabs/providers/api-key-save-plan';
import { ApiKeyCredentials } from '../../settings/tabs/providers/ApiKeyCredentials';

const mocks = vi.hoisted(() => ({
  gsapFetch: vi.fn(),
  invalidateConfigCache: vi.fn(),
}));

vi.mock('../../settings/api', () => ({
  gsapFetch: (...args: unknown[]) => mocks.gsapFetch(...args),
}));

vi.mock('../../hooks/use-config', () => ({
  invalidateConfigCache: (...args: unknown[]) => mocks.invalidateConfigCache(...args),
}));

vi.mock('../../settings/helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../settings/helpers')>();
  return {
    ...actual,
    t: (key: string) => key,
    API_FORMAT_OPTIONS: [{ value: 'openai-completions', label: 'OpenAI' }],
  };
});

function jsonResponse(body: unknown): Response {
  return { json: async () => body } as Response;
}

function renderCredentials(overrides: Partial<React.ComponentProps<typeof ApiKeyCredentials>['summary']> = {}) {
  return render(React.createElement(ApiKeyCredentials, {
    providerId: 'chatgpt',
    summary: {
      type: 'api-key',
      auth_type: 'api-key',
      display_name: 'ChatGPT',
      base_url: 'https://api.openai.com/v1',
      api: 'openai-completions',
      api_key: MASKED_SECRET,
      headers: {},
      models: ['gpt-managed'],
      custom_models: [],
      has_credentials: true,
      supports_oauth: false,
      can_delete: true,
      ...overrides,
    },
    onRefresh: vi.fn(async () => {}),
  }));
}

function readConfigPayload() {
  const call = mocks.gsapFetch.mock.calls.find(([url]) => url === '/api/config');
  expect(call).toBeTruthy();
  return JSON.parse(String((call?.[1] as RequestInit)?.body || '{}'));
}

describe('getApiKeySavePlan', () => {
  it('allows clearing an edited api key without forcing remote verification', () => {
    expect(getApiKeySavePlan({
      keyEdited: true,
      keyVal: '',
      urlEdited: false,
      urlVal: 'https://api.example.com/v1',
      derivedBaseUrl: 'https://api.example.com/v1',
      isPresetSetup: false,
      isLocalPreset: false,
      api: 'openai-completions',
    })).toEqual({
      shouldSave: true,
      shouldVerify: false,
      payload: { api_key: '' },
      effectiveUrl: 'https://api.example.com/v1',
      api: 'openai-completions',
      key: '',
    });
  });

  it('marks local/no-auth presets as auth_type none when first saved', () => {
    expect(getApiKeySavePlan({
      keyEdited: true,
      keyVal: '',
      urlEdited: false,
      urlVal: 'http://127.0.0.1:30000/v1',
      derivedBaseUrl: 'http://127.0.0.1:30000/v1',
      isPresetSetup: true,
      isLocalPreset: true,
      api: 'openai-completions',
    })).toMatchObject({
      shouldSave: true,
      shouldVerify: true,
      payload: {
        base_url: 'http://127.0.0.1:30000/v1',
        api_key: '',
        api: 'openai-completions',
        auth_type: 'none',
        seed_default_models: true,
      },
    });
  });

  it('asks the server to seed default models for preset setup', () => {
    expect(getApiKeySavePlan({
      keyEdited: true,
      keyVal: 'sk-test',
      urlEdited: false,
      urlVal: '',
      derivedBaseUrl: 'https://api.xiaomimimo.com/v1',
      isPresetSetup: true,
      isLocalPreset: false,
      api: 'openai-completions',
    }).payload).toEqual({
      base_url: 'https://api.xiaomimimo.com/v1',
      api_key: 'sk-test',
      api: 'openai-completions',
      seed_default_models: true,
    });
  });

  it('normalizes saved video generation URLs back to the provider base URL', () => {
    expect(getApiKeySavePlan({
      keyEdited: true,
      keyVal: 'sk-test',
      urlEdited: true,
      urlVal: 'https://video.example.com/v1/videos/generations/',
      derivedBaseUrl: 'https://video.example.com/v1',
      isPresetSetup: true,
      isLocalPreset: false,
      api: 'openai-completions',
    })).toMatchObject({
      shouldSave: true,
      payload: {
        base_url: 'https://video.example.com/v1',
        api_key: 'sk-test',
        api: 'openai-completions',
        seed_default_models: true,
      },
      effectiveUrl: 'https://video.example.com/v1',
    });
  });

  it('can repair an existing preset provider with no saved models', () => {
    expect(getApiKeySavePlan({
      keyEdited: true,
      keyVal: 'sk-test',
      urlEdited: false,
      urlVal: 'https://api.xiaomimimo.com/v1',
      derivedBaseUrl: 'https://api.xiaomimimo.com/v1',
      isPresetSetup: false,
      isLocalPreset: false,
      seedDefaultModels: true,
      api: 'openai-completions',
    }).payload).toEqual({
      api_key: 'sk-test',
      seed_default_models: true,
    });
  });

  it('does not persist runtime API key references as plaintext credentials', () => {
    expect(getApiKeySavePlan({
      keyEdited: true,
      keyVal: buildRuntimeApiKeyRef('chatgpt'),
      urlEdited: false,
      urlVal: 'https://api.openai.com/v1',
      derivedBaseUrl: 'https://api.openai.com/v1',
      isPresetSetup: false,
      isLocalPreset: false,
      api: 'openai-completions',
    })).toMatchObject({
      shouldSave: false,
      shouldVerify: false,
      payload: {},
      key: '',
    });
  });
});

describe('ApiKeyCredentials component persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.gsapFetch.mockResolvedValue(jsonResponse({ ok: true }));
  });

  afterEach(() => {
    cleanup();
  });

  it('saves a cleared provider API key when the verify button is clicked', async () => {
    renderCredentials();

    fireEvent.change(screen.getByDisplayValue(MASKED_SECRET), { target: { value: '' } });
    fireEvent.click(screen.getByTitle('settings.providers.verifyConnection'));

    await waitFor(() => expect(mocks.gsapFetch).toHaveBeenCalledWith('/api/config', expect.any(Object)));
    expect(readConfigPayload()).toEqual({
      providers: {
        chatgpt: { api_key: '' },
      },
    });
  });

  it('saves an edited provider API key on blur so model calls use the new credential', async () => {
    renderCredentials();

    const input = screen.getByDisplayValue(MASKED_SECRET);
    fireEvent.change(input, { target: { value: 'sk-chatgpt-new' } });
    fireEvent.blur(input);

    await waitFor(() => expect(mocks.gsapFetch).toHaveBeenCalledWith('/api/config', expect.any(Object)));
    expect(readConfigPayload()).toEqual({
      providers: {
        chatgpt: { api_key: 'sk-chatgpt-new' },
      },
    });
  });

  it('masks runtime API key references in the provider settings input', () => {
    renderCredentials({ api_key: buildRuntimeApiKeyRef('chatgpt') });

    expect(screen.queryByDisplayValue(buildRuntimeApiKeyRef('chatgpt'))).toBeNull();
    expect(screen.getByDisplayValue(MASKED_SECRET)).toBeTruthy();
  });

  it('keeps runtime API key references masked when the user tries to reveal them', async () => {
    mocks.gsapFetch.mockImplementation(async (url: string) => {
      if (url === '/api/providers/chatgpt/api-key') {
        return jsonResponse({ api_key: buildRuntimeApiKeyRef('chatgpt') });
      }
      return jsonResponse({ ok: true });
    });

    renderCredentials({ api_key: buildRuntimeApiKeyRef('chatgpt') });

    fireEvent.click(screen.getByRole('button', { name: 'settings.api.showKey' }));

    await waitFor(() => expect(mocks.gsapFetch).toHaveBeenCalledWith('/api/providers/chatgpt/api-key'));
    expect(screen.queryByDisplayValue(buildRuntimeApiKeyRef('chatgpt'))).toBeNull();
    expect(screen.getByDisplayValue(MASKED_SECRET)).toBeTruthy();
  });
});
