import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../stores';

const gsapFetchMock = vi.fn();
type WorkspacePreviewTestWindow = {
  t: (key: string) => string;
  platform: {
    readFileSnapshot: ReturnType<typeof vi.fn>;
  };
};

vi.mock('../../hooks/use-gsap-fetch', () => ({
  gsapFetch: gsapFetchMock,
}));

function jsonResponse(body: unknown): Response {
  return { json: async () => body } as unknown as Response;
}

describe('workspace preview state restore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gsapFetchMock.mockReset();
    (globalThis as unknown as { window: WorkspacePreviewTestWindow }).window = {
      t: (key: string) => key,
      platform: {
        readFileSnapshot: vi.fn(async (filePath: string) => ({
          content: `content:${filePath}`,
          version: { mtimeMs: 1, size: 10, sha256: 'hash' },
        })),
      },
    };
    useStore.setState({
      serverPort: 60204,
      deskBasePath: '',
      deskCurrentPath: '',
      deskFiles: [],
      deskTreeFilesByPath: {},
      deskExpandedPaths: [],
      deskSelectedPath: '',
      deskJianContent: null,
      cwdSkills: [],
      cwdSkillsOpen: false,
      workspaceDeskStateByRoot: {},
      previewOpen: false,
      previewByOwner: {},
      selectedFolder: '/home-folder',
      homeFolder: '/fallback-home',
      workspaceFolders: [],
      pendingNewSession: true,
      currentSessionPath: null,
    } as never);
  });

  it('hydrates persisted desk preview tabs with current file content', async () => {
    gsapFetchMock.mockResolvedValueOnce(jsonResponse({
      state: {
        deskExpandedPaths: ['src'],
        deskSelectedPath: 'src/App.tsx',
        previewOpen: true,
        openTabs: ['file-src/App.tsx'],
        activeTabId: 'file-src/App.tsx',
        previewTabs: [{
          id: 'file-src/App.tsx',
          relativePath: 'src/App.tsx',
          title: 'App.tsx',
          type: 'code',
          ext: 'tsx',
          language: 'tsx',
        }],
      },
    }));

    const { activateWorkspaceDesk } = await import('../../stores/desk-actions');
    await activateWorkspaceDesk('/workspace', { reload: false });

    const deskPreview = useStore.getState().previewByOwner.desk;
    expect(useStore.getState().previewOpen).toBe(true);
    expect(deskPreview.openTabs).toEqual(['file-src/App.tsx']);
    expect(deskPreview.activeTabId).toBe('file-src/App.tsx');
    expect(deskPreview.artifacts).toEqual([
      expect.objectContaining({
        id: 'file-src/App.tsx',
        filePath: '/workspace/src/App.tsx',
        title: 'App.tsx',
        content: 'content:/workspace/src/App.tsx',
        fileVersion: { mtimeMs: 1, size: 10, sha256: 'hash' },
      }),
    ]);
    expect(window.platform?.readFileSnapshot).toHaveBeenCalledWith('/workspace/src/App.tsx');
  });
});
