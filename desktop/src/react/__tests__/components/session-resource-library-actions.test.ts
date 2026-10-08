import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');

function read(relPath: string) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

describe('SessionResourceLibraryPanel actions', () => {
  it('uses explicit channel resource actions instead of deferred DOM events', () => {
    const source = read('components/right-workspace/SessionResourceLibraryPanel.tsx');

    expect(source).toContain('setPendingChannelResourceAction');
    expect(source).toContain("target: 'input'");
    expect(source).toContain("target: 'workflow'");
    expect(source).toContain("setCurrentTab('channels')");
    expect(source).not.toContain('gsap-channel-workflow-add-resource');
    expect(source).not.toContain('requestAnimationFrame');
  });
});
