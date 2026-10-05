import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');

function read(relPath: string) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

describe('Skills panel wiring', () => {
  it('adds the Skills floating panel to the sidebar app shell', () => {
    const app = read('App.tsx');
    const types = read('types.ts');

    expect(types).toContain("'skills'");
    expect(app).toContain('SkillsPanel');
    expect(app).toContain("togglePanel('skills')");
    expect(app).toContain("t('skills.panel.title')");
    expect(app).toContain("activePanel === 'skills'");
  });
});
