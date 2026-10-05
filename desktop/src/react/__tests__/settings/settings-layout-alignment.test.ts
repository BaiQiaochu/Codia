import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

function read(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function cssRule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{(?<body>[^}]*)\\}`))?.groups?.body || '';
}

describe('settings layout alignment contracts', () => {
  it('keeps theme tuning controls padded away from the section border', () => {
    const css = read('desktop/src/react/settings/Settings.module.css');
    const source = read('desktop/src/react/settings/tabs/InterfaceTab.tsx');
    const rule = cssRule(css, '.theme-advanced-settings');

    expect(source).toContain("styles['theme-advanced-settings']");
    expect(source).toContain('data-testid="theme-advanced-settings"');
    expect(rule).toMatch(/display:\s*flex/);
    expect(rule).toMatch(/flex-direction:\s*column/);
    expect(rule).toMatch(/gap:\s*var\(--space-md\)/);
    expect(rule).toMatch(/padding:\s*var\(--settings-section-edge-y,\s*var\(--space-sm\)\)\s+var\(--settings-section-edge-x,\s*var\(--space-md\)\)/);
  });

  it('lets embedded desktop pet settings fill the experiments content width', () => {
    const css = read('desktop/src/react/settings/Settings.module.css');
    const rule = cssRule(css, '.settings-main > .settings-embedded-tab-content');

    expect(rule).toMatch(/width:\s*100%/);
    expect(rule).toMatch(/max-width:\s*none/);
  });

  it('lets language and timezone selects fill their two-column fields', () => {
    const css = read('desktop/src/react/settings/Settings.module.css');
    const source = read('desktop/src/react/settings/tabs/InterfaceTab.tsx');
    const rule = cssRule(css, '.settings-locale-select');

    expect(source).toContain("styles['settings-locale-select']");
    expect(rule).toMatch(/width:\s*100%/);
    expect(rule).toMatch(/max-width:\s*none/);
  });

  it('lets modal settings tab content fill the modal content column', () => {
    const css = read('desktop/src/react/settings/Settings.module.css');
    const rule = cssRule(css, '.settings-panel-modal .settings-main > .settings-tab-content');

    expect(rule).toMatch(/width:\s*100%/);
    expect(rule).toMatch(/max-width:\s*none/);
  });
});
