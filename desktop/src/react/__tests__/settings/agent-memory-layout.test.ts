import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function readSettingsCss(): string {
  return fs.readFileSync(
    path.join(process.cwd(), 'desktop/src/react/settings/Settings.module.css'),
    'utf8',
  );
}

function readComponentsCss(): string {
  return fs.readFileSync(
    path.join(process.cwd(), 'desktop/src/react/settings/components/settings-components.module.css'),
    'utf8',
  );
}

function cssRule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{(?<body>[^}]*)\\}`))?.groups?.body || '';
}

describe('Agent memory settings layout', () => {
  it('keeps memory controls on the shared settings section edge spacing', () => {
    const css = readSettingsCss();
    const componentsCss = readComponentsCss();
    const content = cssRule(css, '.memory-settings-content');
    const subsection = cssRule(css, '.memory-settings-content > .settings-subsection');
    const sectionBody = cssRule(componentsCss, '.sectionBody');
    const row = cssRule(componentsCss, '.row');
    const note = cssRule(componentsCss, '.sectionNote');
    const warning = cssRule(componentsCss, '.sectionWarning');
    const footer = cssRule(componentsCss, '.sectionFooter');

    expect(sectionBody).toMatch(/--settings-section-edge-y:\s*var\(--space-sm\)/);
    expect(sectionBody).toMatch(/--settings-section-edge-x:\s*var\(--space-md\)/);
    expect(row).toMatch(/padding:\s*var\(--settings-section-edge-y\)\s+var\(--settings-section-edge-x\)/);
    expect(note).toMatch(/padding:\s*var\(--settings-section-edge-y\)\s+var\(--settings-section-edge-x\)/);
    expect(warning).toMatch(/padding:\s*var\(--settings-section-edge-y\)\s+var\(--settings-section-edge-x\)/);
    expect(footer).toMatch(/padding:\s*var\(--settings-section-edge-y\)\s+var\(--settings-section-edge-x\)/);
    expect(content).toMatch(/display:\s*flex/);
    expect(content).toMatch(/flex-direction:\s*column/);
    expect(content).toMatch(/gap:\s*var\(--space-md\)/);
    expect(content).toMatch(/padding:\s*var\(--settings-section-edge-y,\s*var\(--space-sm\)\)\s+var\(--settings-section-edge-x,\s*var\(--space-md\)\)/);
    expect(subsection).toMatch(/margin-bottom:\s*0/);
  });
});
