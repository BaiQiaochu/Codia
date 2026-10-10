import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');

function read(relPath: string) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

describe('channel agent create wiring', () => {
  it('auto-fills a suggested agent name when opening the group-agent form', () => {
    const source = read('components/channels/ChannelWorkspacePanel.tsx');

    expect(source).toContain('function suggestAgentName');
    expect(source).toContain('setAgentName(suggestAgentName(agentRole, existingNames))');
    expect(source).toContain('agentNameEdited');
    expect(source).toContain('createAgentNameRequired');
  });

  it('keeps the main quick-create assistant while avoiding duplicate group member cards', () => {
    const app = read('App.tsx');
    const channelsPanel = read('components/ChannelsPanel.tsx');
    const workspace = read('components/channels/ChannelWorkspacePanel.tsx');

    expect(app).toContain('ChannelMembers');
    expect(app).toContain('ChannelAgentSettingsPanel');
    expect(app).toContain('ChannelAgentActivityPanel');
    expect(app).toContain('<ChannelWorkspacePanel />');
    expect(app).toMatch(/if \(isDM\)[\s\S]*<ChannelMembers \/>/);
    expect(app).not.toMatch(/<ChannelWorkspacePanel \/>[\s\S]*<div className="jian-card">[\s\S]*<ChannelMembers \/>/);
    expect(app).toContain('className="channel-page"');
    expect(app).toContain('className="channel-inspector-rail"');
    expect(app).toContain('id="channelInspector"');
    expect(app).toMatch(/currentTab === 'chat' \|\| isPluginTab \|\| currentTab === 'channels'/);

    expect(channelsPanel).toContain('export function ChannelMembers');
    expect(channelsPanel).toContain('export function ChannelAgentSettingsPanel');
    expect(channelsPanel).toContain('export function ChannelAgentActivityPanel');
    expect(channelsPanel).toContain('addChannelMember');
    expect(channelsPanel).toContain('removeChannelMember');

    expect(workspace).toContain('createChannelAgent');
    expect(workspace).toContain('codia-channel-open-agent-create');
  });

  it('keeps the group-agent create controls inside narrow inspector cards', () => {
    const css = read('components/channels/Channels.module.css');

    expect(css).toContain('grid-template-columns: repeat(auto-fit, minmax(min(120px, 100%), 1fr))');
    expect(css).toContain('.channelAgentCreateGrid .channelRoleSelect');
    expect(css).toMatch(/\.channelAgentCreateGrid \.channelRoleSelect \{[\s\S]*?min-width: 0;/);
    expect(css).toMatch(/\.channelAgentCreateGrid \.channelRoleSelect \{[\s\S]*?width: 100%;/);
    expect(css).toMatch(/\.channelAgentCreateForm \.createInput \{[\s\S]*?box-sizing: border-box;/);
  });

  it('uses Chinese channel workspace fallbacks and protects narrow member rows', () => {
    const workspace = read('components/channels/ChannelWorkspacePanel.tsx');
    const roleUtils = read('components/channels/channel-role-utils.ts');
    const css = read('components/channels/Channels.module.css');

    expect(workspace).toContain("'工作群'");
    expect(workspace).toContain("'群内新建助手'");
    expect(workspace).toContain("'创建并加入'");
    expect(workspace).toContain('function yuanTypeDisplayName');
    expect(workspace).toContain("window.t?.(`yuan.types.${key}.name`)");
    expect(roleUtils).toContain('CHANNEL_ROLE_LABELS');
    expect(roleUtils).toContain("project_manager: '项目经理'");
    expect(roleUtils).toContain("admin: '管理员'");
    expect(roleUtils).toContain("worker: '工人'");
    expect(css).toMatch(/\.channelWorkspaceMemberIdentity \{[\s\S]*?flex: 1 1 auto;/);
    expect(css).toMatch(/\.channelWorkspaceMemberId \{[\s\S]*?text-overflow: ellipsis;/);
    expect(css).toMatch(/\.channelRoleSelect \{[\s\S]*?max-width: 100%;/);
  });
});
