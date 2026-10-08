import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

describe('InterfaceTab theme buttons', () => {
  it('renders theme choices as explicit buttons and keeps editor typography controls wired', () => {
    const source = fs.readFileSync(
      path.join(root, 'desktop/src/react/settings/tabs/InterfaceTab.tsx'),
      'utf-8',
    );

    expect(source).toContain('VALID_THEMES.map');
    expect(source).toContain('type="button"');
    expect(source).toContain("styles['theme-card']");
    expect(source).toContain("saveEditorTypography({ [row.key]: value })");
    expect(source).toContain("saveEditorTypography({ lineHeight: value })");
    expect(source).toContain("saveEditorTypography({ contentPadding: value })");
  });

  it('does not expose the removed global serif font switch', () => {
    const source = fs.readFileSync(
      path.join(root, 'desktop/src/react/settings/tabs/InterfaceTab.tsx'),
      'utf-8',
    );

    expect(source).not.toContain('serifEnabled');
    expect(source).not.toContain('setSerifFont');
    expect(source).not.toContain('settings.appearance.serifFont');
  });

  it('does not keep global serif font switch copy in bundled locales', () => {
    for (const localeFile of ['en.json', 'ja.json', 'ko.json', 'zh-TW.json', 'zh.json']) {
      const locale = JSON.parse(fs.readFileSync(
        path.join(root, 'desktop/src/locales', localeFile),
        'utf-8',
      ));

      expect(locale.settings.appearance, localeFile).not.toHaveProperty('serifFont');
      expect(locale.settings.appearance, localeFile).not.toHaveProperty('serifFontHint');
    }
  });

  it('keeps the original voice recording shortcut guidance in the interface tab', () => {
    const source = fs.readFileSync(
      path.join(root, 'desktop/src/react/settings/tabs/InterfaceTab.tsx'),
      'utf-8',
    );

    expect(source).toContain('settings.interface.voiceRecordingShortcut');
    expect(source).toContain('settings.interface.voiceRecordingShortcutHint');
    expect(source).toContain("styles['shortcut-keycaps']");
  });
});
