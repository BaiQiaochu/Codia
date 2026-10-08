import { describe, expect, it } from 'vitest';
import { selectSessionFiles } from '../../../stores/selectors/file-refs';
import type { ChatListItem } from '../../../stores/chat-types';

type SessionFilesState = Parameters<typeof selectSessionFiles>[0];

function sessionState(items: ChatListItem[], path = '/s/resource', sessionFiles: unknown[] = []) {
  return {
    deskFiles: [],
    deskBasePath: '',
    deskCurrentPath: '',
    chatSessions: { [path]: { items, hasMore: false, loadingMore: false } },
    sessionRegistryFilesByPath: sessionFiles.length ? { [path]: sessionFiles } : {},
  } as SessionFilesState;
}

describe('selectSessionFiles remote resources', () => {
  it('includes session registry resources before legacy message file blocks', () => {
    const items: ChatListItem[] = [{
      type: 'message',
      data: {
        id: 'm-file',
        role: 'assistant',
        blocks: [
          { type: 'file', fileId: 'sf_same', filePath: '/workspace/out.md', label: 'out.md', ext: 'md' },
        ],
      },
    }];
    const refs = selectSessionFiles(sessionState(items, '/s/resource', [{
      fileId: 'sf_same',
      filePath: '/workspace/out.md',
      label: 'out.md',
      ext: 'md',
      mime: 'text/markdown',
      origin: 'agent_write',
      operations: ['created'],
      createdAt: 1234,
      status: 'available',
      resource: {
        schemaVersion: 1,
        resourceId: 'res_sf_same',
        name: 'studios/studio_local/resources/res_sf_same',
        studioId: 'studio_local',
        type: 'file',
        source: 'session_file',
        fileId: 'sf_same',
        displayName: 'out.md',
        lifecycle: { status: 'available', missingAt: null },
        storage: { provider: 'session_file', localOnly: true },
        links: {
          self: '/api/resources/res_sf_same',
          content: '/api/resources/res_sf_same/content',
        },
      },
    }]), '/s/resource');

    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      fileId: 'sf_same',
      source: 'session-registry',
      name: 'out.md',
      path: '/workspace/out.md',
      kind: 'markdown',
      origin: 'agent_write',
      operations: ['created'],
      timestamp: 1234,
      resource: {
        resourceId: 'res_sf_same',
        studioId: 'studio_local',
        links: {
          self: '/api/resources/res_sf_same',
          content: '/api/resources/res_sf_same/content',
        },
      },
    });
  });

  it('reads session registry files from the stable session id key', () => {
    const refs = selectSessionFiles({
      ...sessionState([], '/s/moved'),
      sessions: [{ path: '/s/moved', sessionId: 'sess-files' }],
      sessionLocatorsById: { 'sess-files': { path: '/s/moved' } },
      sessionRegistryFilesByPath: {
        'sess-files': [{
          fileId: 'sf_moved',
          filePath: '/workspace/moved.md',
          label: 'moved.md',
          ext: 'md',
          status: 'available',
        }],
      },
    } as SessionFilesState, '/s/moved');

    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      fileId: 'sf_moved',
      source: 'session-registry',
      path: '/workspace/moved.md',
    });
  });

  it('preserves resource links from live session file blocks', () => {
    const items: ChatListItem[] = [{
      type: 'message',
      data: {
        id: 'm-live-file',
        role: 'assistant',
        blocks: [
          {
            type: 'file',
            fileId: 'sf_live',
            filePath: '/workspace/live.png',
            label: 'live.png',
            ext: 'png',
            mime: 'image/png',
            kind: 'image',
            resource: {
              schemaVersion: 1,
              resourceId: 'res_sf_live',
              name: 'studios/studio_local/resources/res_sf_live',
              studioId: 'studio_local',
              type: 'file',
              source: 'session_file',
              fileId: 'sf_live',
              lifecycle: { status: 'available', missingAt: null },
              storage: { provider: 'session_file', localOnly: true },
              links: {
                self: '/api/resources/res_sf_live',
                content: '/api/resources/res_sf_live/content',
              },
            },
          },
        ],
      },
    }];

    const refs = selectSessionFiles(sessionState(items, '/s/live'), '/s/live');

    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      fileId: 'sf_live',
      source: 'session-block-file',
      path: '/workspace/live.png',
      resource: {
        resourceId: 'res_sf_live',
        studioId: 'studio_local',
        links: {
          self: '/api/resources/res_sf_live',
          content: '/api/resources/res_sf_live/content',
        },
      },
    });
  });
});
