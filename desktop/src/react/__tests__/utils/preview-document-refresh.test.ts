import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore, type StoreState } from '../../stores';
import type { Artifact, RemoteWorkbenchContentRef } from '../../types';

const mocks = vi.hoisted(() => ({
  refreshPreviewItemsFromFile: vi.fn(async () => undefined),
  refreshPreviewItemsFromRemoteWorkbenchTarget: vi.fn(async () => undefined),
}));

vi.mock('../../utils/preview-file-refresh', () => ({
  PREVIEW_FILE_CHANGE_REFRESH_OPTIONS: Object.freeze({
    retryMissing: true,
    retryUnchanged: true,
  }),
  PREVIEW_FILE_CATCH_UP_REFRESH_OPTIONS: Object.freeze({
    retryMissing: true,
  }),
  refreshPreviewItemsFromFile: mocks.refreshPreviewItemsFromFile,
}));

vi.mock('../../utils/remote-file-preview', () => ({
  isRemoteWorkbenchContentRef: (value: unknown) => {
    if (!value || typeof value !== 'object') return false;
    const ref = value as Record<string, unknown>;
    return (ref.kind === 'workbench-file' || ref.kind === 'mobile-workbench')
      && (typeof ref.mountId === 'string' || typeof ref.rootId === 'string')
      && typeof ref.subdir === 'string'
      && typeof ref.name === 'string';
  },
  normalizeWorkbenchContentRef: (ref: RemoteWorkbenchContentRef) => {
    const mountId = ref.mountId || ref.rootId || 'default';
    return {
      ...ref,
      kind: 'workbench-file',
      mountId,
      rootId: ref.rootId || mountId,
      subdir: ref.subdir || '',
    };
  },
  refreshPreviewItemsFromRemoteWorkbenchTarget: mocks.refreshPreviewItemsFromRemoteWorkbenchTarget,
}));

function localArtifact(id: string, filePath: string): Artifact {
  return {
    id,
    type: 'markdown',
    title: `${id}.md`,
    content: '# Demo',
    filePath,
  };
}

function remoteRef(name: string, mountId = 'mount_docs'): RemoteWorkbenchContentRef {
  return {
    kind: 'workbench-file',
    mountId,
    subdir: 'notes',
    name,
    contentPath: `/api/workbench/content?mountId=${mountId}&subdir=notes&name=${name}`,
  };
}

function remoteArtifact(id: string, ref: RemoteWorkbenchContentRef): Artifact {
  return {
    id,
    type: 'markdown',
    title: ref.name,
    content: '# Remote',
    storageKind: 'remote-content',
    remoteContentRef: ref,
  };
}

describe('preview document refresh', () => {
  beforeEach(() => {
    mocks.refreshPreviewItemsFromFile.mockClear();
    mocks.refreshPreviewItemsFromRemoteWorkbenchTarget.mockClear();
    useStore.setState({
      previewByOwner: {},
    } as Partial<StoreState>);
  });

  it('routes local and remote document targets through the same refresh contract', async () => {
    const {
      PREVIEW_DOCUMENT_CHANGE_REFRESH_OPTIONS,
      refreshPreviewDocumentTarget,
    } = await import('../../utils/preview-document-refresh');
    const target = remoteRef('remote.md');

    await refreshPreviewDocumentTarget({ kind: 'local-file', filePath: '/tmp/note.md' });
    await refreshPreviewDocumentTarget({ kind: 'workbench-file', target });

    expect(mocks.refreshPreviewItemsFromFile).toHaveBeenCalledWith(
      '/tmp/note.md',
      PREVIEW_DOCUMENT_CHANGE_REFRESH_OPTIONS,
    );
    expect(mocks.refreshPreviewItemsFromRemoteWorkbenchTarget).toHaveBeenCalledWith(
      target,
      PREVIEW_DOCUMENT_CHANGE_REFRESH_OPTIONS,
    );
  });

  it('refreshes only open owner-keyed preview documents across local files and remote workbench targets', async () => {
    const sharedRemote = remoteRef('remote.md');
    useStore.setState({
      previewByOwner: {
        desk: {
          artifacts: [
            localArtifact('open-local', '/tmp/open.md'),
            localArtifact('duplicate-local', '/tmp/open.md'),
            localArtifact('closed-local', '/tmp/closed.md'),
          ],
          openTabs: ['open-local', 'duplicate-local'],
          activeTabId: 'open-local',
          markdownPreviewIds: [],
          previewReadingPositions: {},
        },
        '/sessions/a.jsonl': {
          artifacts: [
            remoteArtifact('open-remote', sharedRemote),
            remoteArtifact('duplicate-remote', { ...sharedRemote, rootId: sharedRemote.mountId }),
            remoteArtifact('closed-remote', remoteRef('closed.md')),
          ],
          openTabs: ['open-remote', 'duplicate-remote'],
          activeTabId: 'open-remote',
          markdownPreviewIds: [],
          previewReadingPositions: {},
        },
      },
    } as Partial<StoreState>);
    const {
      PREVIEW_DOCUMENT_CATCH_UP_REFRESH_OPTIONS,
      refreshOpenPreviewDocuments,
    } = await import('../../utils/preview-document-refresh');

    await refreshOpenPreviewDocuments();

    expect(mocks.refreshPreviewItemsFromFile).toHaveBeenCalledTimes(1);
    expect(mocks.refreshPreviewItemsFromFile).toHaveBeenCalledWith(
      '/tmp/open.md',
      PREVIEW_DOCUMENT_CATCH_UP_REFRESH_OPTIONS,
    );
    expect(mocks.refreshPreviewItemsFromRemoteWorkbenchTarget).toHaveBeenCalledTimes(1);
    expect(mocks.refreshPreviewItemsFromRemoteWorkbenchTarget).toHaveBeenCalledWith(
      sharedRemote,
      PREVIEW_DOCUMENT_CATCH_UP_REFRESH_OPTIONS,
    );
  });

  it('refreshes open preview documents that match a changed workspace file path', async () => {
    const remote = remoteRef('remote.md', 'default');
    useStore.setState({
      deskBasePath: 'C:/work',
      deskWorkspaceMountId: null,
      previewByOwner: {
        desk: {
          artifacts: [
            localArtifact('local-open', 'C:/work/src/local.md'),
            localArtifact('local-closed', 'C:/work/src/closed.md'),
            remoteArtifact('remote-open', remote),
            remoteArtifact('remote-other-mount', remoteRef('remote.md', 'secondary')),
          ],
          openTabs: ['local-open', 'remote-open', 'remote-other-mount'],
          activeTabId: 'remote-open',
          markdownPreviewIds: [],
          previewReadingPositions: {},
        },
      },
    } as Partial<StoreState>);
    const {
      PREVIEW_DOCUMENT_CHANGE_REFRESH_OPTIONS,
      refreshOpenPreviewDocumentsForFilePath,
    } = await import('../../utils/preview-document-refresh');

    await refreshOpenPreviewDocumentsForFilePath('C:\\work\\notes\\remote.md');
    await refreshOpenPreviewDocumentsForFilePath('C:\\work\\src\\local.md');

    expect(mocks.refreshPreviewItemsFromRemoteWorkbenchTarget).toHaveBeenCalledTimes(1);
    expect(mocks.refreshPreviewItemsFromRemoteWorkbenchTarget).toHaveBeenCalledWith(
      remote,
      PREVIEW_DOCUMENT_CHANGE_REFRESH_OPTIONS,
    );
    expect(mocks.refreshPreviewItemsFromFile).toHaveBeenCalledTimes(1);
    expect(mocks.refreshPreviewItemsFromFile).toHaveBeenCalledWith(
      'C:/work/src/local.md',
      PREVIEW_DOCUMENT_CHANGE_REFRESH_OPTIONS,
    );
  });

  it('uses native workspace roots when resolving mounted preview document watch paths', async () => {
    const remote = remoteRef('remote.md', 'mount_docs');
    useStore.setState({
      deskBasePath: '/virtual/mount',
      deskWorkspaceMountId: 'mount_docs',
      deskWorkspaceNativeRoot: 'D:/real/work',
      previewByOwner: {
        desk: {
          artifacts: [
            remoteArtifact('remote-open', remote),
          ],
          openTabs: ['remote-open'],
          activeTabId: 'remote-open',
          markdownPreviewIds: [],
          previewReadingPositions: {},
        },
      },
    } as Partial<StoreState>);
    const {
      openPreviewDocumentWatchFilePaths,
      refreshOpenPreviewDocumentsForFilePath,
    } = await import('../../utils/preview-document-refresh');

    expect(openPreviewDocumentWatchFilePaths()).toEqual(['D:/real/work/notes/remote.md']);

    await refreshOpenPreviewDocumentsForFilePath('D:/real/work/notes/remote.md');

    expect(mocks.refreshPreviewItemsFromRemoteWorkbenchTarget).toHaveBeenCalledWith(
      remote,
      expect.any(Object),
    );
  });

  it('subscribes mounted workbench preview documents through ResourceIO mount refs', async () => {
    const remote = remoteRef('remote.md', 'mount_docs');
    useStore.setState({
      deskBasePath: 'studio:mount_other',
      deskWorkspaceMountId: 'mount_other',
      deskWorkspaceNativeRoot: 'D:/other/work',
      studioWorkspaces: [
        {
          workspaceId: 'mount_docs',
          mountId: 'mount_docs',
          label: 'Docs',
          sourceKind: 'local',
          provider: 'local_fs',
          presentation: null,
          capabilities: [],
          isDefault: false,
          nativeRootPath: 'D:/real/work',
        },
        {
          workspaceId: 'mount_other',
          mountId: 'mount_other',
          label: 'Other',
          sourceKind: 'local',
          provider: 'local_fs',
          presentation: null,
          capabilities: [],
          isDefault: false,
          nativeRootPath: 'D:/other/work',
        },
      ],
      previewByOwner: {
        desk: {
          artifacts: [
            remoteArtifact('remote-open', remote),
          ],
          openTabs: ['remote-open'],
          activeTabId: 'remote-open',
          markdownPreviewIds: [],
          previewReadingPositions: {},
        },
      },
    } as Partial<StoreState>);
    const { openPreviewDocumentWatchResources } = await import('../../utils/preview-document-refresh');

    expect(openPreviewDocumentWatchResources().map(item => item.ref)).toEqual([
      { kind: 'mount', mountId: 'mount_docs', path: 'notes/remote.md' },
    ]);
  });

  it('refreshes matching open documents from ResourceIO local, delete, and rename events', async () => {
    useStore.setState({
      previewByOwner: {
        desk: {
          artifacts: [
            localArtifact('changed-local', '/workspace/notes/changed.md'),
            localArtifact('deleted-local', '/workspace/notes/deleted.md'),
            localArtifact('old-local', '/workspace/notes/old.md'),
            localArtifact('new-local', '/workspace/notes/new.md'),
          ],
          openTabs: ['changed-local', 'deleted-local', 'old-local', 'new-local'],
          activeTabId: 'changed-local',
          markdownPreviewIds: [],
          previewReadingPositions: {},
        },
      },
    } as Partial<StoreState>);
    const {
      PREVIEW_DOCUMENT_CHANGE_REFRESH_OPTIONS,
      refreshOpenPreviewDocumentsForResourceChange,
    } = await import('../../utils/preview-document-refresh');

    await refreshOpenPreviewDocumentsForResourceChange({
      resource: {
        kind: 'local-file',
        provider: 'local_fs',
        path: '/workspace/notes/changed.md',
      },
    });
    await refreshOpenPreviewDocumentsForResourceChange({
      resource: {
        kind: 'local-file',
        provider: 'local_fs',
        path: '/workspace/notes/deleted.md',
      },
    });
    await refreshOpenPreviewDocumentsForResourceChange({
      oldResource: {
        kind: 'local-file',
        provider: 'local_fs',
        path: '/workspace/notes/old.md',
      },
      newResource: {
        kind: 'local-file',
        provider: 'local_fs',
        path: '/workspace/notes/new.md',
      },
    });

    expect(mocks.refreshPreviewItemsFromFile).toHaveBeenCalledTimes(4);
    for (const filePath of [
      '/workspace/notes/changed.md',
      '/workspace/notes/deleted.md',
      '/workspace/notes/old.md',
      '/workspace/notes/new.md',
    ]) {
      expect(mocks.refreshPreviewItemsFromFile).toHaveBeenCalledWith(
        filePath,
        PREVIEW_DOCUMENT_CHANGE_REFRESH_OPTIONS,
      );
    }
  });

  it('refreshes mounted workbench preview documents from ResourceIO mount events with native file projections', async () => {
    const remote = remoteRef('remote.md', 'mount_docs');
    useStore.setState({
      deskBasePath: 'studio:mount_docs',
      deskWorkspaceMountId: 'mount_docs',
      deskWorkspaceNativeRoot: 'D:/real/work',
      previewByOwner: {
        desk: {
          artifacts: [
            remoteArtifact('remote-open', remote),
          ],
          openTabs: ['remote-open'],
          activeTabId: 'remote-open',
          markdownPreviewIds: [],
          previewReadingPositions: {},
        },
      },
    } as Partial<StoreState>);
    const {
      PREVIEW_DOCUMENT_CHANGE_REFRESH_OPTIONS,
      refreshOpenPreviewDocumentsForResourceChange,
      workspaceSubdirsFromResourceChange,
    } = await import('../../utils/preview-document-refresh');
    const event = {
      resource: {
        kind: 'mount',
        provider: 'mount',
        mountId: 'mount_docs',
        path: 'notes/remote.md',
        filePath: 'D:/real/work/notes/remote.md',
      },
    };

    expect(workspaceSubdirsFromResourceChange(event)).toEqual(['notes']);
    await refreshOpenPreviewDocumentsForResourceChange(event);

    expect(mocks.refreshPreviewItemsFromFile).not.toHaveBeenCalled();
    expect(mocks.refreshPreviewItemsFromRemoteWorkbenchTarget).toHaveBeenCalledTimes(1);
    expect(mocks.refreshPreviewItemsFromRemoteWorkbenchTarget).toHaveBeenCalledWith(
      remote,
      PREVIEW_DOCUMENT_CHANGE_REFRESH_OPTIONS,
    );
  });
});
