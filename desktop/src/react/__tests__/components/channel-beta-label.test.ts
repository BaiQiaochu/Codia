import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');

function read(relPath: string) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

describe('channel sidebar stable label', () => {
  it('does not render the old beta badge in the channel tab title', () => {
    const source = read('components/channels/ChannelList.tsx');
    const styles = fs.readFileSync(path.join(ROOT, '../styles.css'), 'utf8');

    expect(source).toContain("className=\"sidebar-title\">{t('channel.tab')}</span>");
    expect(source).not.toContain('beta-badge');
    expect(source).not.toContain('Beta');
    expect(styles).not.toContain('.beta-badge');
  });
});
