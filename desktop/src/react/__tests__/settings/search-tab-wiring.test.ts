import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SETTINGS_ROOT = path.resolve(__dirname, '../..', 'settings');

function read(rel: string) {
  return fs.readFileSync(path.join(SETTINGS_ROOT, rel), 'utf8');
}

describe('settings search provider wiring', () => {
  it('keeps search preferences inside providers instead of a standalone settings page', () => {
    const content = read('SettingsContent.tsx');
    const nav = read('SettingsNav.tsx');
    const providers = read('tabs/ProvidersTab.tsx');

    expect(content).not.toContain("import { SearchTab } from './tabs/SearchTab'");
    expect(content).not.toContain('search: SearchTab');
    expect(content).not.toContain("search: 'settings.tabs.search'");
    expect(nav).not.toContain("id: 'search'");
    expect(nav).not.toContain("key: 'settings.tabs.search'");
    expect(providers).toContain('OtherModelsSection');
  });

  it('implements search preferences in the provider other-models section', () => {
    const source = read('tabs/providers/OtherModelsSection.tsx');
    const helpers = read('helpers.ts');

    expect(source).toContain('autoSaveGlobalModels');
    expect(helpers).toContain("'/api/preferences/models'");
    expect(source).toContain("'/api/search/verify'");
    expect(source).toContain('SEARCH_API_PROVIDER_IDS');
    expect(source).toContain('ANYSEARCH_FREE_PROVIDER');
    expect(source).toContain('browser');
    expect(source).toContain('KeyInput');
    expect(source).toContain('SelectWidget');
  });
});
