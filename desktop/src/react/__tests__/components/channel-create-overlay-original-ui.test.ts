import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');

function read(relPath: string) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

describe('ChannelCreateOverlay original UI contract', () => {
  it('uses the original overlay/avatar structure and keeps roles out of the create dialog', () => {
    const source = read('components/channels/ChannelCreateOverlay.tsx');

    expect(source).toContain("import { Overlay } from '../../ui'");
    expect(source).toContain('AgentAvatar');
    expect(source).toContain('resolveAgentDisplayInfo');
    expect(source).toContain('<Overlay');
    expect(source).toContain('createChannel(name.trim(), selectedMembers, intro.trim() || undefined)');
    expect(source).not.toContain('channelRoleTable');
    expect(source).not.toContain('handleRoleChange');
  });
});
