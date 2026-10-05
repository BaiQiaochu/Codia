import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');

function read(rel: string) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

describe('skill bundle theme styles', () => {
  it('uses a dedicated theme-aware icon style for the remove button', () => {
    const tree = read('settings/tabs/skills/SkillBundleTree.tsx');
    const css = read('settings/Settings.module.css');

    expect(tree).toContain("styles['skill-bundle-remove-button']");
    expect(tree).toContain('aria-hidden="true"');
    expect(tree).not.toContain('>\n                            移出\n                          </button>');
    expect(css).toContain('.skill-bundle-remove-button');

    const match = css.match(/\.skill-bundle-remove-button\s*\{(?<body>[^}]+)\}/);
    expect(match?.groups?.body).toContain('var(--overlay-subtle');
    expect(match?.groups?.body).not.toContain('width: auto');
    expect(match?.groups?.body).not.toContain('min-width');
    expect(match?.groups?.body).not.toContain('var(--bg-card)');
  });
});
