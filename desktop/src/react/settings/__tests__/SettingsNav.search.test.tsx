// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsNav } from '../SettingsNav';
import { useSettingsStore } from '../store';

const translations: Record<string, string> = {
  'settings.settingsSearch.placeholder': 'Search settings',
  'settings.settingsSearch.clear': 'Clear search',
  'settings.settingsSearch.results': 'Search results',
  'settings.settingsSearch.noResults': 'No settings found',
  'settings.categories.accountAgent': 'Account & Agent',
  'settings.categories.agentSettings': 'Agent Settings',
  'settings.categories.personalProfile': 'Profile',
  'settings.categories.modelsCapabilities': 'Models & Capabilities',
  'settings.categories.modelServices': 'Model Services',
  'settings.categories.workExtensions': 'Work & Extensions',
  'settings.categories.systemSecurity': 'System & Security',
  'settings.categories.generalDevices': 'General & Devices',
  'settings.tabs.agent': 'Assistant',
  'settings.tabs.me': 'Me',
  'settings.tabs.interface': 'Interface',
  'settings.tabs.general': 'General',
  'settings.tabs.browser': 'Browser',
  'settings.tabs.work': 'Workspace',
  'settings.tabs.skills': 'Skills',
  'settings.tabs.mcp': 'Connectors',
  'settings.tabs.bridge': 'Integrations',
  'settings.tabs.providers': 'Providers',
  'settings.tabs.media': 'Media',
  'settings.tabs.sharing': 'Sharing',
  'settings.tabs.access': 'Access',
  'settings.tabs.plugins': 'Plugins',
  'settings.tabs.experiments': 'Experiments',
  'settings.tabs.context': 'Context',
  'settings.tabs.computerUse': 'Computer Use',
  'settings.tabs.security': 'Security',
  'settings.tabs.diagnostics': 'Diagnostics',
  'settings.tabs.about': 'About',
  'settings.api.apiKey': 'API Key',
  'settings.api.searchProvider': 'Search Provider',
  'settings.appearance.theme': 'Theme',
};

describe('SettingsNav search', () => {
  beforeEach(() => {
    window.t = ((key: string) => translations[key] || key) as typeof window.t;
    window.i18n = {
      locale: 'en',
      defaultName: 'Codia Professional',
      _data: {},
      _agentOverrides: {},
      load: vi.fn(async () => {}),
      setAgentOverrides: vi.fn(),
      t: ((key: string) => translations[key] || key) as typeof window.t,
    };
    useSettingsStore.setState({
      activeTab: 'agent',
      pluginSettingsTabs: [
        {
          pluginId: 'native',
          id: 'native-settings',
          title: { zh: 'Native panel', en: 'Native Panel' },
          nativeComponent: 'unknown-native-tab',
        },
      ],
    } as never);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('shows five consolidated categories in the confirmed order', () => {
    const { container } = render(<SettingsNav />);

    expect(Array.from(container.querySelectorAll('[data-settings-category]')).map(node => node.textContent)).toEqual([
      'Account & Agent',
      'Models & Capabilities',
      'Work & Extensions',
      'System & Security',
      'General & Devices',
    ]);
    expect(container.querySelector('[data-tab]')).toBeNull();
  });

  it('switches from the tab list to search results and opens the matched result tab', () => {
    const onTabChange = vi.fn();
    render(<SettingsNav onTabChange={onTabChange} />);

    fireEvent.change(screen.getByPlaceholderText('Search settings'), { target: { value: 'api key' } });

    expect(screen.getByText('Search results')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /API Key/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Account & Agent' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /API Key/ }));

    expect(useSettingsStore.getState().activeTab).toBe('providers');
    expect(onTabChange).toHaveBeenCalledWith('providers');
    expect((screen.getByPlaceholderText('Search settings') as HTMLInputElement).value).toBe('');
  });

  it('finds original search setting keywords inside the providers tab', () => {
    const onTabChange = vi.fn();
    render(<SettingsNav onTabChange={onTabChange} />);

    fireEvent.change(screen.getByPlaceholderText('Search settings'), { target: { value: 'search provider' } });
    fireEvent.click(screen.getByRole('button', { name: /Search Provider/ }));

    expect(useSettingsStore.getState().activeTab).toBe('providers');
    expect(onTabChange).toHaveBeenCalledWith('providers');
  });

  it('clears back to the normal tab list', () => {
    render(<SettingsNav />);

    fireEvent.change(screen.getByPlaceholderText('Search settings'), { target: { value: 'theme' } });
    expect(screen.getByText('Search results')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Clear search'));

    expect((screen.getByPlaceholderText('Search settings') as HTMLInputElement).value).toBe('');
    expect(screen.getByRole('button', { name: 'Account & Agent' })).toBeInTheDocument();
  });

  it('opens the merged General page for appearance searches', () => {
    const onTabChange = vi.fn();
    render(<SettingsNav onTabChange={onTabChange} />);

    fireEvent.change(screen.getByPlaceholderText('Search settings'), { target: { value: 'theme' } });
    fireEvent.click(screen.getByRole('button', { name: /Theme/ }));

    expect(useSettingsStore.getState().activeTab).toBe('about');
    expect(onTabChange).toHaveBeenCalledWith('about');
  });
});
