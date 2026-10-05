import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');

function read(rel: string) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

describe('settings dynamic tab wiring', () => {
  it('routes the standalone settings window through SettingsContent so native plugin tabs render', () => {
    const app = read('settings/SettingsApp.tsx');

    expect(app).toContain("import { SettingsContent } from './SettingsContent'");
    expect(app).toContain('<SettingsContent variant="window" listenToWindowTabSwitch />');
    expect(app).not.toContain('const TAB_COMPONENTS');
  });
});
