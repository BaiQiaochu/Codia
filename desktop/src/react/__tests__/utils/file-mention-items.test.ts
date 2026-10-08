import { describe, expect, it } from 'vitest';
import { buildFileMentionItems, mergeEditorFileRefs } from '../../utils/file-mention-items';

describe('file mention items', () => {
  it('builds mention options from input attachments, session files, and workspace results without duplicates', () => {
    const items = buildFileMentionItems({
      query: 'read',
      attachedFiles: [{
        fileId: 'sf_readme',
        path: '/workspace/README.md',
        name: 'README.md',
      }],
      sessionFiles: [{
        id: 'ref-1',
        fileId: 'sf_readme',
        source: 'session-attachment',
        kind: 'markdown',
        path: '/workspace/README.md',
        name: 'README.md',
      }, {
        id: 'ref-2',
        source: 'session-block-file',
        kind: 'other',
        path: '/workspace/notes/read-later.txt',
        name: 'read-later.txt',
      }],
      deskFiles: [],
      deskBasePath: '/workspace',
      deskCurrentPath: '',
      searchResults: [{
        name: 'reader.ts',
        relativePath: 'src/reader.ts',
        parentSubdir: 'src',
        isDir: false,
      }],
    });

    expect(items.map(item => ({
      source: item.source,
      name: item.name,
      path: item.path,
      fileId: item.fileId,
    }))).toEqual([
      { source: 'attached', name: 'README.md', path: '/workspace/README.md', fileId: 'sf_readme' },
      { source: 'session', name: 'read-later.txt', path: '/workspace/notes/read-later.txt', fileId: undefined },
      { source: 'workspace', name: 'reader.ts', path: '/workspace/src/reader.ts', fileId: undefined },
    ]);
  });

  it('merges editor file refs into attachments without duplicating already attached files', () => {
    const merged = mergeEditorFileRefs(
      [{ fileId: 'sf_readme', path: '/workspace/README.md', name: 'README.md' }],
      [
        { fileId: 'sf_readme', path: '/workspace/README.md', name: 'README.md' },
        { path: '/workspace/src', name: 'src', isDirectory: true },
      ],
    );

    expect(merged).toEqual([
      { fileId: 'sf_readme', path: '/workspace/README.md', name: 'README.md' },
      { path: '/workspace/src', name: 'src', isDirectory: true },
    ]);
  });

  it('groups assistants and images ahead of regular files for @ mentions', () => {
    const items = buildFileMentionItems({
      query: '',
      agents: [{ id: 'agent-codia', name: '小豆蔻', yuan: 'codia', isPrimary: true }],
      attachedFiles: [
        { path: '/workspace/notes.txt', name: 'notes.txt' },
        { path: '/workspace/mockup.png', name: 'mockup.png', mimeType: 'image/png' },
      ],
      sessionFiles: [],
      deskFiles: [],
      deskBasePath: '/workspace',
      deskCurrentPath: '',
      searchResults: [],
    });

    expect(items.map(item => [item.kind, item.name])).toEqual([
      ['assistant', '小豆蔻'],
      ['image', 'mockup.png'],
      ['file', 'notes.txt'],
    ]);
    expect(items[0]).toMatchObject({ source: 'assistant', agentId: 'agent-codia' });
  });

  it('keeps inline media fields when merging attached files for send', () => {
    const merged = mergeEditorFileRefs(
      [{
        path: '/__e2e__/paste.png',
        name: 'paste.png',
        base64Data: 'PNG_BASE64',
        mimeType: 'image/png',
      }],
      [],
    );

    expect(merged).toEqual([{
      path: '/__e2e__/paste.png',
      name: 'paste.png',
      base64Data: 'PNG_BASE64',
      mimeType: 'image/png',
    }]);
  });

  it('does not list or send a registered file twice when it is also found in the workspace', () => {
    const attached = { fileId: 'image-1', path: 'C:\\Work\\cover.png', name: 'cover.png', base64Data: 'PIXELS' };
    const items = buildFileMentionItems({
      query: '', agents: [], attachedFiles: [attached], sessionFiles: [],
      deskFiles: [{ name: 'cover.png', isDir: false }, { name: 'icons.png', isDir: true }],
      deskBasePath: 'c:/work', deskCurrentPath: '', searchResults: [],
    });
    expect(items.map(item => [item.kind, item.name])).toEqual([
      ['image', 'cover.png'], ['file', 'icons.png'],
    ]);
    expect(mergeEditorFileRefs([attached], [{ path: 'c:/work/cover.png', name: 'cover.png' }])).toEqual([attached]);
  });
});
