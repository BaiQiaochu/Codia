import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');

function read(relPath: string) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

describe('SessionResourceLibraryPanel contract', () => {
  it('can clear the visible library without deleting the conversation', () => {
    const source = read('components/right-workspace/SessionResourceLibraryPanel.tsx');
    const chatSlice = read('stores/chat-slice.ts');
    const selector = read('stores/selectors/file-refs.ts');

    expect(source).toContain('hideSessionResources');
    expect(source).toContain('clearLibrary');
    expect(source).toContain('cleared:');
    expect(chatSlice).toContain('hiddenSessionResourceIdsByPath');
    expect(chatSlice).toContain('hideSessionResources');
    expect(selector).toContain('hiddenSessionResourceIdsByPath');
    expect(selector).toContain('!hiddenIds.includes(file.id)');
  });

  it('keeps send-to-channel and add-to-workflow clickable from chat mode', () => {
    const source = read('components/right-workspace/SessionResourceLibraryPanel.tsx');
    const header = read('components/channels/ChannelHeader.tsx');
    const workflow = read('components/channels/ChannelWorkflowWindow.tsx');

    expect(source).toContain('pickChannelTarget');
    expect(source).toContain("setCurrentTab('channels')");
    expect(source).toContain("import { openChannel } from '../../stores/channel-actions';");
    expect(source).toContain('void activateChannel(channelTarget)');
    expect(source).toContain('disabled={!channelTarget || !canReuse(file)}');
    expect(source).toContain('title={!channelTarget ? ui.noChannelForInput : undefined}');
    expect(source).toContain('title={!channelTarget ? ui.noChannelForWorkflow : undefined}');
    expect(source).toContain('resource: file.resource');
    expect(header).toContain('detail.channelId && detail.channelId !== currentChannel');
    expect(workflow).toContain('channelId?: string');
    expect(workflow).toContain('detail.channelId && detail.channelId !== workflowChannelId');
  });
});
