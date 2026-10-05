import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');

function read(relPath: string) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

describe('channel task tree placement', () => {
  it('renders the task tree before the member management section', () => {
    const source = read('components/channels/ChannelWorkspacePanel.tsx');
    const treeIndex = source.indexOf("localText('channel.taskTree'");
    const membersIndex = source.indexOf("localText('channel.members'");

    expect(treeIndex).toBeGreaterThan(-1);
    expect(membersIndex).toBeGreaterThan(-1);
    expect(treeIndex).toBeLessThan(membersIndex);
    expect(source).toContain('channelTaskTreeList');
    expect(source).toContain('scopedTaskTrees.map');
  });
});
