import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const shellPath = path.resolve(__dirname, '../../components/SettingsModalShell.tsx');
const shellCssPath = path.resolve(__dirname, '../../components/SettingsModalShell.module.css');

function readShell() {
  return fs.readFileSync(shellPath, 'utf8');
}

function readShellCss() {
  return fs.readFileSync(shellCssPath, 'utf8');
}

describe('settings modal wide tabs', () => {
  it('uses the same wide tab set as settings content for dense pages', () => {
    const source = readShell();

    expect(source).toContain('WIDE_SETTINGS_MODAL_TABS');
    expect(source).toContain("'providers'");
    expect(source).toContain("'media'");
    expect(source).toContain("'plugin-marketplace'");
    expect(source).toContain('WIDE_SETTINGS_MODAL_TABS.has(settingsModal.activeTab)');
  });

  it('gives dense settings pages enough modal width and height', () => {
    const css = readShellCss();

    expect(css).toContain('width: min(960px');
    expect(css).toContain('height: min(880px');
    expect(css).toContain('width: min(1280px');
  });

  it('lets the modal content scroller fill the card width instead of leaving a blank right gutter', () => {
    const css = fs.readFileSync(path.resolve(__dirname, '../../settings/Settings.module.css'), 'utf8');

    expect(css).toContain('.settings-panel-modal .settings-main');
    expect(css).toContain('max-width: none');
    expect(css).toContain('grid-template-columns: calc(var(--settings-nav-width, 160px) + var(--settings-main-x-padding, var(--space-xl))) minmax(0, 1fr)');
  });

  it('keeps provider and media dense pages on the styled two-column shell', () => {
    const providers = fs.readFileSync(path.resolve(__dirname, '../../settings/tabs/ProvidersTab.tsx'), 'utf8');
    const media = fs.readFileSync(path.resolve(__dirname, '../../settings/tabs/MediaTab.tsx'), 'utf8');
    const css = fs.readFileSync(path.resolve(__dirname, '../../settings/Settings.module.css'), 'utf8');

    expect(providers).toContain("css('pv-layout')");
    expect(providers).toContain("css('pv-list-item'");
    expect(media).toContain("css('pv-layout')");
    expect(media).toContain("css('media-module-button'");
    expect(css).toContain('.pv-layout');
    expect(css).toContain(':global(.pv-layout)');
    expect(css).toContain('.pv-list-item');
    expect(css).toContain(':global(.pv-list-item)');
    expect(css).toContain('.media-module-button-selected');
  });
});
