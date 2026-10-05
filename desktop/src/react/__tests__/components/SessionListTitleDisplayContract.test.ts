import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');

function read(relPath: string) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

describe('SessionList title display contract', () => {
  it('uses the shared display-title filter instead of raw title fallback chains', () => {
    const source = read('components/SessionList.tsx');

    expect(source).toContain("import { getSessionDisplayTitle } from '../utils/session-title-display';");
    expect(source).toContain('getSessionDisplayTitle(result, t(\'session.untitled\'))');
    expect(source).toContain('getSessionDisplayTitle(s, t(\'session.untitled\'))');
    expect(source).not.toContain("{s.title || s.firstMessage || t('session.untitled')}");
    expect(source).not.toContain("{result.title || result.firstMessage || t('session.untitled')}");
  });
});
