import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');

function read(relPath: string) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

describe('Skills panel wiring', () => {
  it('opens the Skills panel from the composer sparkle button', () => {
    const app = read('App.tsx');
    const types = read('types.ts');
    const buttons = read('components/input/InputUtilityButtons.tsx');

    expect(types).toContain("'skills'");
    expect(app).toContain('SkillsPanel');
    expect(app).not.toContain("togglePanel('skills')");
    expect(buttons).toContain("setActivePanel('skills')");
    expect(buttons).toContain("'skills.panel.title'");
    expect(buttons).toContain('<Sparkle');
    expect(app).toContain("activePanel === 'skills'");
  });
});
