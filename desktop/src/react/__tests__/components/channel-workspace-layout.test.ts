import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');

function read(relPath: string) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

describe('channel workspace layout', () => {
  it('keeps channel company metadata and member controls from clipping in the inspector rail', () => {
    const css = read('components/channels/Channels.module.css');

    expect(css).toMatch(/\.channelWorkspaceDescription\s*\{[\s\S]*overflow-wrap:\s*anywhere;/);
    expect(css).toMatch(/\.channelRoleSummary\s*\{[\s\S]*flex-wrap:\s*wrap;/);
    expect(css).toMatch(/\.channelWorkspaceMemberRow\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\);/);
    expect(css).toMatch(/\.channelWorkspaceMemberText\s*\{[\s\S]*min-width:\s*0;/);
    expect(css).toMatch(/\.channelRoleSelect\s*\{[\s\S]*min-width:\s*0;/);
    expect(css).toMatch(/\.channelSectionHeaderRow\s*\{[\s\S]*flex-wrap:\s*wrap;/);
    expect(css).toMatch(/\.channelSecondaryAction\s*\{[\s\S]*white-space:\s*nowrap;/);
    expect(css).toMatch(/\.channelWorkspaceMemberRow\s*\{[\s\S]*align-items:\s*start;/);
    expect(css).toMatch(/\.channelWorkspaceMembers\s*\{[\s\S]*scrollbar-gutter:\s*stable;/);
    expect(css).toMatch(/\.channelRoleSelect\s*\{[\s\S]*min-height:\s*30px;/);
    expect(css).toMatch(/\.channelRoleSelect\s*\{[\s\S]*width:\s*100%;/);
    expect(css).toMatch(/\.channelWorkspaceMemberText\s*\{[\s\S]*overflow-wrap:\s*anywhere;/);
    expect(css).toMatch(/\.channelWorkspaceMemberId\s*\{[\s\S]*white-space:\s*normal;/);
    expect(css).toMatch(/\.channelWorkspaceMemberText\s+\.channelMemberName\s*\{[\s\S]*white-space:\s*normal;/);
    expect(css).toMatch(/\.channelWorkspaceMemberText\s+\.channelMemberName\s*\{[\s\S]*overflow-wrap:\s*anywhere;/);
    expect(css).toMatch(/\.channelWorkspaceCard\s*\{[\s\S]*overflow:\s*visible;/);
    expect(css).toMatch(/\.channelWorkspaceCard\s*\{[\s\S]*max-width:\s*100%;/);
    expect(css).toMatch(/\.channelInfoNameWrap\s*\{[\s\S]*overflow-wrap:\s*anywhere;/);
    expect(css).toMatch(/\.channelInfoNameWrap\s*\{[\s\S]*white-space:\s*normal;/);

    const panel = read('components/channels/ChannelWorkspacePanel.tsx');
    expect(panel).toContain('styles.channelWorkspaceCard');
    expect(panel).toContain('styles.channelInfoNameWrap');
  });

  it('keeps channel mention completion readable and inside the input surface', () => {
    const css = read('components/channels/Channels.module.css');
    const panel = read('components/ChannelsPanel.tsx');
    const list = read('components/channels/ChannelList.tsx');

    expect(css).toMatch(/\.channelMentionDropdown\s*\{[\s\S]*left:\s*0;/);
    expect(css).toMatch(/\.channelMentionDropdown\s*\{[\s\S]*right:\s*0;/);
    expect(css).toMatch(/\.channelMentionDropdown\s*\{[\s\S]*max-width:\s*100%;/);
    expect(css).toMatch(/\.channelMentionDropdown\s*\{[\s\S]*overscroll-behavior:\s*contain;/);
    expect(css).toMatch(/\.channelMentionDropdown\s*\{[\s\S]*z-index:\s*1200;/);
    expect(css).toMatch(/\.channelMentionText\s*\{[\s\S]*min-width:\s*0;/);
    expect(css).toMatch(/\.channelMentionName\s*\{[\s\S]*overflow:\s*hidden;/);
    expect(css).toMatch(/\.channelMentionMeta\s*\{[\s\S]*text-overflow:\s*ellipsis;/);
    expect(panel).toContain('styles.channelMentionText');
    expect(panel).toContain('styles.channelMentionName');
    expect(panel).toContain('styles.channelMentionMeta');
    expect(list).toContain('`${selfInfo.displayName} 与 ${channel.peerName || channel.name}`');
  });
});
