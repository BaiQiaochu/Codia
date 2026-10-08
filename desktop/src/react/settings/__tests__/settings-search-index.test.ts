import { describe, expect, it } from 'vitest';
import {
  buildSettingsSearchEntries,
  searchSettings,
  type SettingsSearchNavItem,
} from '../settings-search-index';

const navItems: SettingsSearchNavItem[] = [
  { id: 'agent', label: 'Agent', categoryLabel: 'Account & Agent' },
  { id: 'interface', label: 'Interface', categoryLabel: 'General & Devices' },
  { id: 'browser', label: 'Browser', categoryLabel: 'Work & Extensions' },
  { id: 'providers', label: 'Providers', categoryLabel: 'Models & Capabilities' },
  { id: 'experiments', label: 'Experiments', categoryLabel: 'System & Security' },
  { id: 'plugin-native', label: 'Native Plugin', categoryLabel: 'Work & Extensions' },
];

const translate = (key: string) => {
  const labels: Record<string, string> = {
    'settings.tabs.agent': 'Agent',
    'settings.tabs.interface': 'Interface',
    'settings.tabs.browser': 'Browser',
    'settings.tabs.providers': 'Providers',
    'settings.tabs.experiments': 'Experiments',
    'settings.api.apiKey': 'API Key',
    'settings.api.searchProvider': 'Search Service',
    'settings.search.title': 'Search Settings',
    'settings.browser.cookiesTitle': 'Cookies and site data',
    'settings.appearance.theme': 'Theme',
  };
  return labels[key] || key;
};

describe('settings search index', () => {
  it('matches provider API key settings and returns the owning settings tab', () => {
    const entries = buildSettingsSearchEntries(navItems);
    const results = searchSettings('api key', entries, translate);

    expect(results[0]).toMatchObject({
      id: 'providers-api-key',
      tabId: 'providers',
      title: 'API Key',
      path: 'Models & Capabilities / Providers',
    });
  });

  it('routes original search-provider queries to the providers tab', () => {
    const entries = buildSettingsSearchEntries(navItems);
    const results = searchSettings('search provider', entries, translate);

    expect(results[0]).toMatchObject({
      id: 'providers-search',
      tabId: 'providers',
      title: 'Search Service',
      path: 'Models & Capabilities / Providers',
    });
  });

  it('adds native plugin settings tabs as searchable tab-level results', () => {
    const entries = buildSettingsSearchEntries(navItems);
    const results = searchSettings('native', entries, translate);

    expect(results[0]).toMatchObject({
      id: 'plugin-native',
      tabId: 'plugin-native',
      title: 'Native Plugin',
      path: 'Work & Extensions / Native Plugin',
    });
  });

  it('does not return duplicate visible results for built-in top-level tabs', () => {
    const entries = buildSettingsSearchEntries([{ id: 'me', label: 'Me' }]);
    const englishTranslate = (key: string) => {
      const labels: Record<string, string> = {
        'settings.tabs.me': 'Me',
      };
      return labels[key] || key;
    };

    const results = searchSettings('me', entries, englishTranslate);
    const visibleKeys = results.map(result => `${result.tabId}\0${result.title}\0${result.path}`);

    expect(visibleKeys.filter(key => key === 'me\0Me\0Me')).toHaveLength(1);
  });
});
