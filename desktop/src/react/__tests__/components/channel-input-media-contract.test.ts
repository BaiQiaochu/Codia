import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');

function read(relPath: string) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

describe('ChannelInput media attachment contract', () => {
  it('exposes the same non-text attachment entry points as chat input', () => {
    const source = read('components/ChannelsPanel.tsx');
    const css = read('components/channels/Channels.module.css');

    expect(source).toContain('const attachLabel =');
    expect(source).toContain('const handleAttachFiles = useCallback');
    expect(source).toContain('const handleDropFiles = useCallback');
    expect(source).toContain('const handlePasteFiles = useCallback');
    expect(source).toContain("gsapFetch('/api/upload-blob'");
    expect(source).toContain('notifyPasteUploadFailure(t');
    expect(source).toContain('addAttachedFile({');
    expect(source).toContain('onDrop={handleDropFiles}');
    expect(source).toContain('onDragOver={handleDragOverFiles}');
    expect(source).toContain('onPaste={handlePasteFiles}');
    expect(source).toContain('attachFilesFromPaths(paths, nameMap, { channelId: currentChannel })');
    expect(source).toContain("resourceScope: 'channel'");
    expect(source).toContain('channelId: currentChannel');
    expect(source).toContain('resource: file.resource');
    expect(source).toContain('resourceId: file.resource?.resourceId');
    expect(source).toContain('mergeChannelRichBlocks(msg.blocks, msg.resources)');
    expect(source).toContain('function channelResourceToBlock');
    expect(source).toContain('data-testid="channel-attach-files"');
    expect(source).toContain('aria-label={attachLabel}');
    expect(css).toMatch(/\.channelAttachBtn\s*\{[\s\S]*display:\s*inline-flex/);
    expect(css).toContain('.channelInputWrapperDrag');
  });

  it('links slash skill selection into channel messages', () => {
    const source = read('components/ChannelsPanel.tsx');
    const hook = read('hooks/use-slash-items.ts');
    const slashTypes = read('components/input/slash-commands.ts');
    const css = read('components/channels/Channels.module.css');

    expect(hook).toContain('filePath: s.filePath');
    expect(slashTypes).toContain('filePath?: string');
    expect(source).toContain("import { SlashCommandMenu } from './input/SlashCommandMenu';");
    expect(source).toContain("import { buildSlashDraftText, getSlashMatches, parseSlashInput");
    expect(source).toContain('const skillItems = useSkillSlashItems');
    expect(source).toContain("import skillBadgeStyles from './input/SkillBadgeView.module.css';");
    expect(source).toContain('function buildChannelSkillLink');
    expect(source).toContain('[$${item.name}](${item.filePath})');
    expect(source).toContain('const [selectedSkill, setSelectedSkill]');
    expect(source).toContain('const resolveChannelInputText = useCallback');
    expect(source).toContain('return [buildChannelSkillLink(selectedSkill), inputValue.trim()]');
    expect(source).toContain('const handleSlashSkillPick = useCallback');
    expect(source).toContain('setSelectedSkill(item)');
    expect(source).toContain('data-testid="channel-selected-skill"');
    expect(source).toContain('aria-label={`移除技能 ${selectedSkill.name}`}');
    expect(source).not.toContain('? [buildChannelSkillLink(item), args].filter(Boolean).join(\' \')');
    expect(source).toContain('data-testid="channel-skill-menu"');
    expect(source).toContain('<SlashCommandMenu');
    expect(css).toContain('.channelSkillMenuAnchor');
    expect(css).toContain('.channelSkillBtn');
  });
});
