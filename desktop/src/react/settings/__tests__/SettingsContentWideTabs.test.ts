import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const settingsContentPath = path.resolve(__dirname, '../SettingsContent.tsx');
const settingsCssPath = path.resolve(__dirname, '../Settings.module.css');

function readSettingsContent() {
  return fs.readFileSync(settingsContentPath, 'utf8');
}

function readSettingsCss() {
  return fs.readFileSync(settingsCssPath, 'utf8');
}

describe('SettingsContent wide layout tabs', () => {
  it('widens dense provider, media, and marketplace settings pages', () => {
    const source = readSettingsContent();

    expect(source).toContain('WIDE_SETTINGS_TABS');
    expect(source).toContain("'providers'");
    expect(source).toContain("'media'");
    expect(source).toContain("'plugin-marketplace'");
    expect(source).toContain('WIDE_SETTINGS_TABS.has(effectiveActiveTab)');
  });

  it('keeps modal content below the header and includes usage ledger styles', () => {
    const css = readSettingsCss();

    expect(css).toContain('padding-top: var(--space-sm);');
    expect(css).toContain('.settings-main > .settings-tab-title');
    expect(css).toContain('.settings-main-wide > .settings-tab-title');
    expect(css).toContain('.usage-ledger');
  });
});
