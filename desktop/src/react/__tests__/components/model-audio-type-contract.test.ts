import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const REACT_ROOT = path.join(ROOT, 'react');

function read(...parts: string[]) {
  return fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
}

describe('model audio type contract', () => {
  it('keeps runtime diagnostics and E2E model snapshots aligned with audio-capable models', () => {
    const globalTypes = read('global.d.ts');
    const reactTypes = fs.readFileSync(path.join(REACT_ROOT, 'types.ts'), 'utf8');
    const diagnosticsTab = fs.readFileSync(path.join(REACT_ROOT, 'settings/tabs/DiagnosticsTab.tsx'), 'utf8');

    for (const [label, source] of [
      ['global.d.ts', globalTypes],
      ['react/types.ts', reactTypes],
      ['DiagnosticsTab.tsx', diagnosticsTab],
    ] as const) {
      expect(source, label).toContain("'text' | 'image' | 'video' | 'audio'");
      expect(source, label).not.toContain("'text' | 'image' | 'video')[]");
    }
  });
});
