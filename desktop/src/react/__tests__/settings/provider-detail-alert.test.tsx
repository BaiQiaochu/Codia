// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../settings/tabs/providers/OAuthCredentials', () => ({
  OAuthCredentials: () => <div data-testid="oauth-credentials" />,
}));

vi.mock('../../settings/tabs/providers/ApiKeyCredentials', () => ({
  ApiKeyCredentials: () => <div data-testid="api-key-credentials" />,
}));

vi.mock('../../settings/tabs/providers/ProviderModelList', () => ({
  ProviderModelList: () => <div data-testid="provider-model-list" />,
}));

vi.mock('../../settings/api', () => ({
  codiaFetch: vi.fn(),
}));

vi.mock('../../hooks/use-config', () => ({
  invalidateConfigCache: vi.fn(),
}));

describe('ProviderDetail alerts', () => {
  beforeEach(() => {
    (window as typeof window & { t?: (key: string, vars?: Record<string, string>) => string }).t = (key, vars) => {
      const messages: Record<string, string> = {
        'settings.providers.configIncompleteDetailed': 'Provider configuration is incomplete. Add {fields} and required models.',
        'settings.providers.field.apiKey': 'API Key',
        'settings.providers.field.baseUrl': 'Base URL',
        'settings.providers.field.models': 'Models',
      };
      let value = messages[key] || key;
      for (const [name, replacement] of Object.entries(vars || {})) {
        value = value.replace(`{${name}}`, replacement);
      }
      return value;
    };
  });

  afterEach(() => {
    cleanup();
  });

  it('renders provider setup errors with localized missing fields', async () => {
    const { ProviderDetail } = await import('../../settings/tabs/providers/ProviderDetail');
    render(
      <ProviderDetail
        providerId="volcengine"
        onRefresh={vi.fn()}
        summary={{
          type: 'api-key',
          display_name: 'volcengine',
          base_url: '',
          api: 'openai-completions',
          api_key: '',
          auth_type: 'api-key',
          models: [],
          custom_models: [],
          has_credentials: false,
          supports_oauth: false,
          can_delete: true,
          config_status: 'needs_setup',
          config_error: null,
          missing_fields: ['api_key', 'base_url', 'models'],
        }}
      />,
    );

    expect(screen.getByText('Provider configuration is incomplete. Add API Key、Base URL、Models and required models.')).toBeTruthy();
  });
});
