import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const STYLE_FILES = [
  'desktop/src/styles.css',
  'desktop/src/react/settings/Settings.module.css',
  'desktop/src/react/ui/SelectWidget.module.css',
  'desktop/src/settings.html',
];

const CARD_TEXTURE_FILES = [
  'desktop/src/styles.css',
  'desktop/src/react/settings/Settings.module.css',
  'desktop/src/react/ui/SelectWidget.module.css',
];

const SETTINGS_TEXTURE_FILES = [
  'desktop/src/react/settings/Settings.module.css',
  'desktop/src/settings.html',
];

const SETTINGS_MODAL_CSS = 'desktop/src/react/components/SettingsModalShell.module.css';

describe('paper texture contract', () => {
  it.each(STYLE_FILES)('%s opts into texture with body.paper-texture', (rel) => {
    const content = fs.readFileSync(path.join(ROOT, rel), 'utf8');

    expect(content).toContain('body.paper-texture');
    expect(content).not.toContain('body:not(.no-paper-texture)');
  });

  it('turns off card texture brightness compensation in both dark themes', () => {
    const styles = fs.readFileSync(path.join(ROOT, 'desktop/src/styles.css'), 'utf8');

    expect(styles).toContain('--paper-texture-card-blend-mode: lighten;');
    expect(styles).toContain('html[data-theme="midnight"],\nhtml[data-theme="midnight-contrast"]');
    expect(styles).toContain('--paper-texture-card-blend-mode: normal;');
  });

  it.each(CARD_TEXTURE_FILES)('%s uses the shared card blend token', (rel) => {
    const content = fs.readFileSync(path.join(ROOT, rel), 'utf8');

    expect(content).toContain('background-blend-mode: var(--paper-texture-card-blend-mode);');
  });

  it.each(SETTINGS_TEXTURE_FILES)('%s keeps settings paper textures scroll-bound', (rel) => {
    const content = fs.readFileSync(path.join(ROOT, rel), 'utf8');

    expect(content).not.toMatch(/background-attachment:\s*fixed\b/);
  });

  it('lets the settings window override shared select texture attachment', () => {
    const settingsHtml = fs.readFileSync(path.join(ROOT, 'desktop/src/settings.html'), 'utf8');
    const selectCss = fs.readFileSync(path.join(ROOT, 'desktop/src/react/ui/SelectWidget.module.css'), 'utf8');

    expect(settingsHtml).toContain('--paper-texture-attachment: scroll;');
    expect(selectCss).toContain('background-attachment: var(--paper-texture-attachment, fixed);');
  });

  it('keeps the settings modal backdrop out of the animated path on Windows', () => {
    const content = fs.readFileSync(path.join(ROOT, SETTINGS_MODAL_CSS), 'utf8');

    expect(content).not.toMatch(/transition:[^;]*(?:-webkit-)?backdrop-filter/s);
    expect(content).toContain(':global(html[data-platform="win32"]) .overlay.open');
    expect(content).toMatch(/:global\(html\[data-platform="win32"\]\) \.overlay\.open\s*{[^}]*backdrop-filter:\s*none;/s);
    expect(content).toMatch(/:global\(html\[data-platform="win32"\]\) \.overlay\.open\s*{[^}]*-webkit-backdrop-filter:\s*none;/s);
  });
});
