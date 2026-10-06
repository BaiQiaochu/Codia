import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const settingsRoot = path.resolve(__dirname, '../../settings');
const localeRoot = path.resolve(__dirname, '../../../locales');
const repoRoot = path.resolve(__dirname, '../../../../..');

function read(relativePath: string) {
  return fs.readFileSync(path.join(settingsRoot, relativePath), 'utf8');
}

describe('Experiments settings entry contract', () => {
  it('moves computer-use settings into experiments instead of registering a standalone tab', () => {
    const content = read('SettingsContent.tsx');
    const experiments = read('tabs/ExperimentsTab.tsx');

    expect(content).toContain("import { ExperimentsTab } from './tabs/ExperimentsTab'");
    expect(content).not.toContain("import { ComputerUseTab } from './tabs/ComputerUseTab'");
    expect(content).not.toContain('computer: ComputerUseTab');
    expect(content).toContain('experiments: ExperimentsTab');
    expect(read('settings-navigation.ts')).toContain("{ id: 'experiments', key: 'settings.tabs.experiments', fallback: '实验功能' }");
    expect(experiments).toContain("import { ComputerUseSection } from './ComputerUseSection'");
    expect(experiments).toContain('<ComputerUseSection />');
    expect(experiments).not.toContain("import { ComputerUseTab } from './ComputerUseTab'");
    expect(experiments).not.toContain('<ComputerUseTab />');
  });

  it('adds experiments to the native settings navigation without computer-use', () => {
    const nav = read('settings-navigation.ts');

    expect(nav).toContain("{ id: 'experiments'");
    expect(nav).toContain("key: 'settings.tabs.experiments'");
    expect(nav).not.toContain("{ id: 'computer'");
    expect(nav).not.toContain('supportsComputerUseTab');
  });

  it('removes the stale computer-use tab label from every bundled locale', () => {
    for (const localeFile of ['en.json', 'ja.json', 'ko.json', 'zh-TW.json', 'zh.json']) {
      const locale = JSON.parse(fs.readFileSync(path.join(localeRoot, localeFile), 'utf8'));
      expect(locale.settings.tabs, localeFile).not.toHaveProperty('computer');
    }
  });

  it('points user-facing guidance at experiments instead of a standalone computer-use tab', () => {
    const guide = fs.readFileSync(path.join(repoRoot, 'skills2set/user-guide/SKILL.md'), 'utf8');

    expect(guide).toContain('设置 → 实验');
    expect(guide).not.toContain('设置 → 使用电脑');
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
