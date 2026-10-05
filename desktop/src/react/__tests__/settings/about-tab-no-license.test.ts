import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');

function read(rel: string) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

describe('About tab license surface', () => {
  it('does not render or retain copyright and license blocks in About', () => {
    const source = read('settings/tabs/AboutTab.tsx');

    expect(source).not.toContain('APACHE_LICENSE_TEXT');
    expect(source).not.toContain('Apache License');
    expect(source).not.toContain('Copyright');
    expect(source).not.toContain('settings.about.license');
    expect(source).not.toContain('settings.about.copyright');
    expect(source).not.toContain('about-license-text');
  });
});
