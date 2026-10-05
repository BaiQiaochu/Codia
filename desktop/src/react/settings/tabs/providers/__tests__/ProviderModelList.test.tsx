/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const mocks = vi.hoisted(() => ({
  gsapFetch: vi.fn(),
  lookupModelMeta: vi.fn((_id: unknown, _provider?: unknown): unknown => null),
}));

vi.mock('../../../api', () => ({
  gsapFetch: (...args: unknown[]) => mocks.gsapFetch(...args),
}));

vi.mock('../../../../hooks/use-config', () => ({
  invalidateConfigCache: vi.fn(),
}));

vi.mock('../../../helpers', () => ({
  t: (key: string) => key,
  formatContext: (n: number) => `${n}`,
  lookupModelMeta: (id: unknown, provider?: unknown) => mocks.lookupModelMeta(id, provider),
}));

import { ProviderModelList } from '../ProviderModelList';

function jsonResponse(body: unknown): Response {
  return { json: async () => body } as Response;
}

describe('ProviderModelList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.gsapFetch.mockResolvedValue(jsonResponse({ models: [] }));
    mocks.lookupModelMeta.mockReturnValue(null);
  });

  afterEach(() => {
    cleanup();
    document.body.innerHTML = '';
  });

  it('shows image, video and reasoning capability icons for added chat models', () => {
    mocks.lookupModelMeta.mockImplementation((id: unknown, provider: unknown) => {
      if (id === 'doubao-seed-2-0-lite-260428' && provider === 'volcengine') {
        return {
          name: 'Doubao Seed 2.0 Lite',
          image: true,
          video: true,
          reasoning: true,
          context: 256000,
        };
      }
      return null;
    });

    render(
      <ProviderModelList
        providerId="volcengine"
        summary={{
          type: 'api-key',
          auth_type: 'api-key',
          display_name: 'Volcengine',
          base_url: 'https://ark.cn-beijing.volces.com/api/v3',
          api: 'openai-completions',
          api_key: 'sk-test',
          models: ['doubao-seed-2-0-lite-260428'],
          custom_models: [],
          has_credentials: true,
          supports_oauth: false,
          is_coding_plan: false,
          can_delete: true,
        }}
        onRefresh={vi.fn(async () => {})}
      />,
    );

    expect(screen.getByTitle('settings.api.capability.image')).toBeInTheDocument();
    expect(screen.getByTitle('settings.api.capability.video')).toBeInTheDocument();
    expect(screen.getByTitle('settings.api.capability.reasoning')).toBeInTheDocument();
  });

  it('passes saved custom provider credentials when fetching remote models', async () => {
    mocks.gsapFetch
      .mockResolvedValueOnce(jsonResponse({ models: [] }))
      .mockResolvedValueOnce(jsonResponse({ models: [{ id: 'gpt-4o' }] }));

    render(
      <ProviderModelList
        providerId="custom-gateway"
        summary={{
          type: 'api-key',
          auth_type: 'api-key',
          display_name: 'Custom Gateway',
          base_url: 'https://gateway.example.com/v1',
          api: 'openai-completions',
          api_key: 'sk-test',
          models: [],
          custom_models: [],
          has_credentials: true,
          supports_oauth: false,
          is_coding_plan: false,
          can_delete: true,
        }}
        onRefresh={vi.fn(async () => {})}
      />,
    );

    fireEvent.click(screen.getByTitle('settings.providers.fetchModels'));

    await waitFor(() => expect(mocks.gsapFetch).toHaveBeenCalledWith(
      '/api/providers/fetch-models',
      expect.objectContaining({
        body: JSON.stringify({
          name: 'custom-gateway',
          base_url: 'https://gateway.example.com/v1',
          api: 'openai-completions',
          api_key: 'sk-test',
        }),
      }),
    ));
  });

  it('passes preset endpoint config when fetching models before credentials are saved', async () => {
    mocks.gsapFetch
      .mockResolvedValueOnce(jsonResponse({ models: [] }))
      .mockResolvedValueOnce(jsonResponse({ models: [{ id: 'deepseek-chat' }] }));

    render(
      <ProviderModelList
        providerId="deepseek"
        summary={{
          type: 'api-key',
          auth_type: 'api-key',
          display_name: 'DeepSeek',
          base_url: 'https://api.deepseek.com/v1',
          api: 'openai-completions',
          api_key: '',
          models: [],
          custom_models: [],
          has_credentials: false,
          supports_oauth: false,
          is_coding_plan: false,
          can_delete: false,
        }}
        onRefresh={vi.fn(async () => {})}
      />,
    );

    fireEvent.click(screen.getByTitle('settings.providers.fetchModels'));

    await waitFor(() => expect(mocks.gsapFetch).toHaveBeenCalledWith(
      '/api/providers/fetch-models',
      expect.objectContaining({
        body: JSON.stringify({
          name: 'deepseek',
          base_url: 'https://api.deepseek.com/v1',
          api: 'openai-completions',
        }),
      }),
    ));
  });

  it('defaults explicitly named video providers to video discovery and hides chat models in the dropdown', async () => {
    mocks.gsapFetch
      .mockResolvedValueOnce(jsonResponse({ models: [] }))
      .mockResolvedValueOnce(jsonResponse({
        models: [
          { id: 'gpt-5.5', type: 'chat' },
          { id: 'seedance-2', type: 'video' },
        ],
      }));

    render(
      <ProviderModelList
        providerId="video-gateway"
        summary={{
          type: 'api-key',
          auth_type: 'api-key',
          display_name: 'Video Gateway',
          base_url: 'https://video.example.com/v1',
          api: 'openai-completions',
          api_key: 'sk-test',
          models: [],
          custom_models: [],
          has_credentials: true,
          supports_oauth: false,
          is_coding_plan: false,
          can_delete: true,
        }}
        onRefresh={vi.fn(async () => {})}
      />,
    );

    fireEvent.click(screen.getByTitle('settings.providers.fetchModels'));

    await waitFor(() => expect(mocks.gsapFetch).toHaveBeenCalledWith(
      '/api/providers/fetch-models',
      expect.objectContaining({
        body: JSON.stringify({
            name: 'video-gateway',
            base_url: 'https://video.example.com/v1',
          api: 'openai-completions',
          api_key: 'sk-test',
          model_type: 'video',
        }),
      }),
    ));

    fireEvent.click(screen.getByText('settings.api.addModel'));

    await waitFor(() => {
      expect(screen.getByText('seedance-2')).toBeInTheDocument();
      expect(screen.queryByText('gpt-5.5')).not.toBeInTheDocument();
    });
  });

  it('does not switch an existing provider to video discovery when its display name becomes ToAPIs', async () => {
    mocks.gsapFetch
      .mockResolvedValueOnce(jsonResponse({ models: [] }))
      .mockResolvedValueOnce(jsonResponse({ models: [] }))
      .mockResolvedValueOnce(jsonResponse({ models: [{ id: 'seedance-2', type: 'video' }] }));

    const baseSummary = {
      type: 'api-key' as const,
      auth_type: 'api-key' as const,
      display_name: 'Custom Gateway',
      api: 'openai-completions',
      api_key: 'sk-test',
      models: [],
      custom_models: [],
      has_credentials: true,
      supports_oauth: false,
      is_coding_plan: false,
      can_delete: true,
    };

    const { rerender } = render(
      <ProviderModelList
        providerId="custom-gateway"
        summary={{
          ...baseSummary,
          base_url: 'https://gateway.example.com/v1',
        }}
        onRefresh={vi.fn(async () => {})}
      />,
    );

    rerender(
      <ProviderModelList
        providerId="custom-gateway"
        summary={{
          ...baseSummary,
          display_name: 'ToAPIs',
          base_url: 'https://toapis.com/v1',
        }}
        onRefresh={vi.fn(async () => {})}
      />,
    );

    fireEvent.click(screen.getByTitle('settings.providers.fetchModels'));

    await waitFor(() => expect(mocks.gsapFetch).toHaveBeenCalledWith(
      '/api/providers/fetch-models',
      expect.objectContaining({
        body: JSON.stringify({
            name: 'custom-gateway',
            base_url: 'https://toapis.com/v1',
            api: 'openai-completions',
            api_key: 'sk-test',
          }),
        }),
      ));
  });

  it('does not force video discovery for custom providers using a ToAPIs-compatible gateway URL', async () => {
    mocks.gsapFetch
      .mockResolvedValueOnce(jsonResponse({ models: [] }))
      .mockResolvedValueOnce(jsonResponse({ models: [{ id: 'gpt-5.5', type: 'chat' }] }));

    render(
      <ProviderModelList
        providerId="imges2"
        summary={{
          type: 'api-key',
          auth_type: 'api-key',
          display_name: 'imges2',
          base_url: 'https://yh.m7ai.com/v1',
          api: 'openai-completions',
          api_key: '',
          headers: {
            Authorization: 'Bearer token',
            'X-Corp-Auth': 'secret',
          },
          models: [],
          custom_models: [],
          has_credentials: true,
          supports_oauth: false,
          is_coding_plan: false,
          can_delete: true,
        }}
        onRefresh={vi.fn(async () => {})}
      />,
    );

    fireEvent.click(screen.getByTitle('settings.providers.fetchModels'));

    await waitFor(() => expect(mocks.gsapFetch).toHaveBeenCalledWith(
      '/api/providers/fetch-models',
      expect.objectContaining({
        body: JSON.stringify({
          name: 'imges2',
          base_url: 'https://yh.m7ai.com/v1',
          api: 'openai-completions',
          headers: {
            Authorization: 'Bearer token',
            'X-Corp-Auth': 'secret',
          },
        }),
      }),
    ));
  });

  it('shows the backend discovery error instead of a generic fetch failure', async () => {
    mocks.gsapFetch.mockImplementation((url: unknown) => {
      if (String(url).includes('/discovered-models')) {
        return Promise.resolve(jsonResponse({ models: [] }));
      }
      if (String(url) === '/api/providers/fetch-models') {
        return Promise.resolve(jsonResponse({ error: 'No models found for provider "custom-gateway"', models: [] }));
      }
      return Promise.resolve(jsonResponse({ models: [] }));
    });

    render(
      <ProviderModelList
        providerId="custom-gateway"
        summary={{
          type: 'api-key',
          auth_type: 'api-key',
          display_name: 'Custom Gateway',
          base_url: 'https://gateway.example.com/v1',
          api: 'openai-completions',
          api_key: '',
          models: [],
          custom_models: [],
          has_credentials: false,
          supports_oauth: false,
          is_coding_plan: false,
          can_delete: true,
        }}
        onRefresh={vi.fn(async () => {})}
      />,
    );

    await waitFor(() => expect(mocks.gsapFetch).toHaveBeenCalledWith('/api/providers/custom-gateway/discovered-models'));

    fireEvent.click(screen.getByTitle('settings.providers.fetchModels'));

    expect(await screen.findByText('settings.providers.fetchFailed: No models found for provider "custom-gateway"')).toBeInTheDocument();
  });
});
