import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');

function read(relPath: string) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

describe('Composer add menu wiring', () => {
  it('opens skills inside the composer add menu', () => {
    const app = read('App.tsx');
    const input = read('components/InputArea.tsx');
    const buttons = read('components/input/InputUtilityButtons.tsx');
    const addMenu = read('components/input/ComposerAddMenu.tsx');

    expect(app).toContain('SkillsPanel');
    expect(buttons).toContain('<StarFour');
    expect(buttons).toContain("t('input.addMenu')");
    expect(input).toContain('<ComposerAddMenu');
    expect(input).toContain('onSelectSkill={handleAddSkill}');
    expect(addMenu).toContain("openView('skills')");
    expect(buttons).not.toContain("setActivePanel('skills')");
  });
});
