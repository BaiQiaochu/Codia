// @vitest-environment jsdom
import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
  gsapFetch: vi.fn(),
}));

vi.mock('../../hooks/use-config', () => ({
  invalidateConfigCache: vi.fn(),
}));

describe('ProviderDetail MiniMax plan notice', () => {
  afterEach(() => {
    cleanup();
  });

  it('warns that MiniMax Token Plan keys are not normal MiniMax API keys', async () => {
    const { ProviderDetail } = await import('../../settings/tabs/providers/ProviderDetail');

    render(
      <ProviderDetail
        providerId="minimax-token-plan"
        onRefresh={vi.fn()}
        summary={{
          type: 'api-key',
          display_name: 'MiniMax Token Plan',
          base_url: 'https://api.minimaxi.com/anthropic',
          api: 'anthropic-messages',
          api_key: '',
          auth_type: 'api-key',
          models: [],
          custom_models: [],
          has_credentials: false,
          supports_oauth: false,
          can_delete: false,
        }}
      />,
    );

    expect(screen.getByText(/订阅计划 Key/)).toBeTruthy();
    expect(screen.getByText(/不能和普通 MiniMax 按量付费 API Key 混用/)).toBeTruthy();
  });

  it('keeps token-plan providers available from the provider preset list', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../utils/provider-presets.ts'), 'utf8');

    expect(source).toContain("value: 'minimax-token-plan'");
    expect(source).toContain("value: 'mimo-token-plan'");
  });
});
