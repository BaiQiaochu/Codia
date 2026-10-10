import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const settingsRoot = path.resolve(__dirname, '../../settings');
const localeRoot = path.resolve(__dirname, '../../../locales');

function read(relativePath: string) {
  return fs.readFileSync(path.join(settingsRoot, relativePath), 'utf8');
}

describe('graduated settings entry contract', () => {
  it('registers context and computer-use as formal settings routes', () => {
    const content = read('SettingsContent.tsx');
    expect(content).toContain("import { ContextTab } from './tabs/ContextTab'");
    expect(content).toContain("import { ComputerUseSection } from './tabs/ComputerUseSection'");
    expect(content).toContain('context: ContextTab');
    expect(content).toContain('computer: ComputerUseSection');
  });

  it('removes the empty experiments entry from navigation', () => {
    const nav = read('settings-navigation.ts');
    expect(nav).toContain("{ id: 'context'");
    expect(nav).toContain("{ id: 'computer'");
    expect(nav).not.toContain("{ id: 'experiments'");
  });

  it('provides formal route labels in every bundled locale', () => {
    for (const localeFile of ['en.json', 'ja.json', 'ko.json', 'zh-TW.json', 'zh.json']) {
      const locale = JSON.parse(fs.readFileSync(path.join(localeRoot, localeFile), 'utf8'));
      expect(locale.settings.tabs.context, localeFile).toBeTruthy();
      expect(locale.settings.tabs.computerUse, localeFile).toBeTruthy();
    }
  });

  it('redirects the retired experiments route to context', () => {
    expect(read('settings-route.ts')).toContain("experiments: 'context'");
  });

  it('keeps experiment section descriptions below the title instead of using the right-side context slot', () => {
    const section = read('components/SettingsSection.tsx');
    const sectionCss = read('components/settings-components.module.css');
    const experiments = read('tabs/ExperimentsTab.tsx');
    const computerUse = read('tabs/ComputerUseSection.tsx');

    expect(section).toContain('description?: React.ReactNode');
    expect(section).toContain('sectionDescription');
    expect(sectionCss).toContain('.sectionHeaderWithDescription');
    expect(sectionCss).toContain('.sectionDescription');
    expect(experiments).toContain("description={t(cacheSnapshotExperiment?.descriptionKey || 'settings.experiments.memorySectionDescription')}");
    expect(experiments).not.toContain("context={t(cacheSnapshotExperiment?.descriptionKey || 'settings.experiments.memorySectionDescription')}");
    expect(experiments).not.toContain("context={t('settings.experiments.cacheSnapshot.description')}");
    expect(computerUse).toContain("description={t('settings.computerUse.description')}");
    expect(computerUse).toContain("state.settingsSnapshot.data?.preferences?.computerUse");
    expect(computerUse).toContain('updateSettingsSnapshot');
    expect(computerUse).not.toContain('<SettingsSection.Note>');
  });
});
