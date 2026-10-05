// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSettingsStore } from '../../settings/store';
import type { ProviderSummary } from '../../settings/store';

const gsapFetchMock = vi.fn();

vi.mock('../../settings/api', () => ({
  gsapFetch: (...args: unknown[]) => gsapFetchMock(...args),
}));

vi.mock('../../settings/actions', () => ({
  loadSettingsConfig: vi.fn(),
}));

vi.mock('../../settings/helpers', () => ({
  t: (key: string, vars?: Record<string, string>) => {
    if (!vars) return key;
    return Object.entries(vars).reduce((text, [name, value]) => text.replace(`{${name}}`, value), key);
  },
  PROVIDER_PRESETS: [
    { value: 'openai', label: 'OpenAI', url: 'https://api.openai.com/v1', api: 'openai' },
  ],
  API_FORMAT_OPTIONS: [
    { value: 'openai-completions', label: 'OpenAI Compatible' },
  ],
}));

vi.mock('../../settings/widgets/SelectWidget', () => ({
  SelectWidget: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => (
    <select data-testid="provider-api-format" value={value} onChange={(event) => onChange(event.target.value)}>
      <option value="openai-completions">OpenAI Compatible</option>
    </select>
  ),
}));

vi.mock('../../settings/widgets/KeyInput', () => ({
  KeyInput: ({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder?: string }) => (
    <input
      data-testid="provider-api-key"
      value={value}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));

vi.mock('../../settings/tabs/providers/ProviderDetail', () => ({
  ProviderDetail: ({ providerId, isPresetSetup }: { providerId: string; isPresetSetup?: boolean }) => (
    <div data-testid="provider-detail" data-preset-setup={isPresetSetup ? 'true' : 'false'}>{providerId}</div>
  ),
}));

vi.mock('../../settings/tabs/providers/OtherModelsSection', () => ({
  OtherModelsSection: () => <div data-testid="other-models">other models</div>,
}));

vi.mock('../../settings/tabs/providers/UsageLedgerSection', () => ({
  UsageLedgerSection: () => <section data-testid="usage-ledger-section">usage ledger</section>,
}));

vi.mock('../../ui', () => ({
  ProviderIcon: ({ provider, className }: { provider?: string; className?: string }) => (
    <span aria-hidden="true" className={className} data-testid={`provider-icon-${provider || 'unknown'}`} />
  ),
}));

describe('ProvidersTab', () => {
  beforeEach(() => {
    gsapFetchMock.mockResolvedValue({ json: async () => ({ providers: {} }) });
    vi.stubGlobal('platform', { settingsChanged: vi.fn() });
    Object.defineProperty(window, 'platform', {
      value: { settingsChanged: vi.fn() },
      configurable: true,
    });
    useSettingsStore.setState({
      providersSummary: {},
      selectedProviderId: null,
      settingsConfig: { providers: {} },
      toastVisible: false,
      toastMessage: '',
      toastType: '',
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('opens the custom provider form as an in-card overlay and keeps other models outside it', async () => {
    const { ProvidersTab } = await import('../../settings/tabs/ProvidersTab');

    render(<ProvidersTab />);

    await waitFor(() => expect(gsapFetchMock).toHaveBeenCalledWith('/api/providers/summary'));
    fireEvent.click(screen.getByRole('button', { name: '+ settings.providers.addCustom' }));

    expect(screen.getByText('settings.providers.addCustom')).toBeTruthy();
    expect(screen.getByRole('button', { name: /settings.api.cancel/ })).toBeTruthy();
    expect(screen.getByPlaceholderText('my-provider')).toBeTruthy();
    expect(screen.getByPlaceholderText('https://api.example.com/v1')).toBeTruthy();
    expect(screen.getByTestId('provider-api-key')).toBeTruthy();
    expect(screen.getByTestId('provider-api-format')).toBeTruthy();
    expect(screen.getByTestId('other-models')).toBeTruthy();
    expect(screen.getByTestId('usage-ledger-section')).toBeTruthy();
  });

  it('keeps registry-only providers selectable as setup entries without treating them as configured', async () => {
    const { ProvidersTab } = await import('../../settings/tabs/ProvidersTab');
    const providersSummary: Record<string, ProviderSummary> = {
      'openai': {
        type: 'api-key',
        display_name: 'OpenAI',
        base_url: 'https://api.openai.com/v1',
        api: 'openai',
        api_key: '',
        auth_type: 'api-key',
        models: [],
        custom_models: [],
        has_credentials: false,
        supports_oauth: false,
        is_coding_plan: false,
        is_configured: false,
        can_delete: false,
        config_status: 'needs_setup',
        config_error: null,
        missing_fields: ['api_key', 'models'],
      },
      'registry-coding': {
        type: 'api-key',
        display_name: 'Registry Coding',
        base_url: 'https://registry.example/v1',
        api: 'openai',
        api_key: '',
        auth_type: 'api-key',
        models: [],
        custom_models: [],
        has_credentials: false,
        supports_oauth: false,
        is_coding_plan: true,
        is_configured: false,
        can_delete: false,
        config_status: 'needs_setup',
        config_error: null,
        missing_fields: ['api_key', 'models'],
      },
    };
    gsapFetchMock.mockResolvedValueOnce({ json: async () => ({ providers: providersSummary }) });
    useSettingsStore.setState({
      providersSummary,
      selectedProviderId: null,
      settingsConfig: { providers: {} },
    });

    render(<ProvidersTab />);

    fireEvent.click(screen.getByRole('button', { name: 'OpenAI' }));
    expect(screen.getByTestId('provider-detail').dataset.presetSetup).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'Registry Coding' }));
    expect(screen.getByTestId('provider-detail').textContent).toBe('registry-coding');
  });

  it('groups providers as OAuth, Coding Plan, and API with provider icons', async () => {
    const { ProvidersTab } = await import('../../settings/tabs/ProvidersTab');
    const providersSummary: Record<string, ProviderSummary> = {
      'openai-codex-oauth': {
        type: 'oauth',
        display_name: 'ChatGPT Plus/Pro',
        base_url: '',
        api: 'openai-codex-responses',
        api_key: '',
        auth_type: 'oauth',
        models: [],
        custom_models: [],
        has_credentials: true,
        supports_oauth: true,
        can_delete: false,
      },
      openai: {
        type: 'api-key',
        display_name: 'OpenAI',
        base_url: 'https://api.openai.com/v1',
        api: 'openai',
        api_key: '',
        auth_type: 'api-key',
        models: [],
        custom_models: [],
        has_credentials: true,
        supports_oauth: false,
        can_delete: false,
      },
      'kimi-coding': {
        type: 'api-key',
        display_name: 'Kimi Coding Plan',
        base_url: 'https://api.kimi.com/coding/',
        api: 'anthropic-messages',
        api_key: '',
        auth_type: 'api-key',
        models: [],
        custom_models: [],
        has_credentials: true,
        supports_oauth: false,
        is_coding_plan: true,
        can_delete: false,
      },
      comfyui: {
        type: 'api-key',
        display_name: 'ComfyUI',
        base_url: 'http://127.0.0.1:8188',
        api: 'openai',
        api_key: '',
        auth_type: 'api-key',
        models: [],
        custom_models: [],
        has_credentials: true,
        supports_oauth: false,
        can_delete: false,
      },
      'minimax-token-plan': {
        type: 'api-key',
        display_name: 'MiniMax Token Plan',
        base_url: 'https://api.minimaxi.com/anthropic',
        api: 'anthropic-messages',
        api_key: '',
        auth_type: 'api-key',
        models: [],
        custom_models: [],
        has_credentials: true,
        supports_oauth: false,
        can_delete: false,
      },
    };
    gsapFetchMock.mockResolvedValueOnce({ json: async () => ({ providers: providersSummary }) });
    useSettingsStore.setState({
      providersSummary,
      selectedProviderId: null,
      settingsConfig: { providers: {} },
    });

    render(<ProvidersTab />);

    expect(screen.getByText('settings.providers.groups.oauth')).toBeTruthy();
    expect(screen.getByText('settings.providers.groups.codingPlan')).toBeTruthy();
    expect(screen.getByText('settings.providers.groups.api')).toBeTruthy();
    expect(screen.getByTestId('provider-icon-openai-codex-oauth')).toBeTruthy();
    expect(screen.getByTestId('provider-icon-kimi-coding')).toBeTruthy();
    expect(screen.getByTestId('provider-icon-openai')).toBeTruthy();

    const codingButton = screen.getByText('Kimi Coding Plan').closest('button');
    expect(codingButton).toBeTruthy();
    fireEvent.click(codingButton as HTMLButtonElement);
    expect(screen.getByTestId('provider-detail').textContent).toBe('kimi-coding');
  });

  it('keeps the provider selector and provider details in the same themed layout card', async () => {
    const { ProvidersTab } = await import('../../settings/tabs/ProvidersTab');
    const providersSummary: Record<string, ProviderSummary> = {
      openai: {
        type: 'api-key',
        display_name: 'OpenAI',
        base_url: 'https://api.openai.com/v1',
        api: 'openai',
        api_key: '',
        auth_type: 'api-key',
        models: [{ id: 'gpt-5.5', name: 'GPT-5.5' }],
        custom_models: [],
        has_credentials: true,
        supports_oauth: false,
        can_delete: false,
      },
    };
    gsapFetchMock.mockResolvedValueOnce({ json: async () => ({ providers: providersSummary }) });
    useSettingsStore.setState({
      providersSummary,
      selectedProviderId: null,
      settingsConfig: { providers: { openai: { models: ['gpt-5.5'] } } },
    });

    const { container } = render(<ProvidersTab />);
    const layout = container.querySelector('.pv-layout');
    expect(layout).toBeTruthy();
    expect(layout?.querySelector('.pv-list')).toBeTruthy();
    expect(layout?.querySelector('.pv-detail')).toBeTruthy();
    expect(layout?.querySelector('[data-testid="provider-detail"]')?.textContent).toBe('openai');
  });
});
