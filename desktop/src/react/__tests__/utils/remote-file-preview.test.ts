// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileRef } from '../../types/file-ref';

const codiaFetchMock = vi.fn((..._args: unknown[]) => undefined);
const codiaUrlMock = vi.fn((path: string) => `https://pwa.local${path}`);
const openPreviewMock = vi.fn((..._args: unknown[]) => undefined);
const openMediaViewerForRefMock = vi.fn((..._args: unknown[]) => undefined);
const openFilePreviewMock = vi.fn((..._args: unknown[]) => undefined);

vi.mock('../../hooks/use-codia-fetch', () => ({
  codiaFetch: (...args: unknown[]) => codiaFetchMock(...args),
  codiaUrl: (path: string) => codiaUrlMock(path),
}));

vi.mock('../../stores/preview-actions', () => ({
  openPreview: (...args: unknown[]) => openPreviewMock(...args),
}));

vi.mock('../../utils/open-media-viewer', () => ({
  openMediaViewerForRef: (...args: unknown[]) => openMediaViewerForRefMock(...args),
}));

vi.mock('../../utils/file-preview', async () => {
  const actual = await vi.importActual<typeof import('../../utils/file-preview')>('../../utils/file-preview');
  return {
    ...actual,
    openFilePreview: (...args: unknown[]) => openFilePreviewMock(...args),
  };
});

function remoteMarkdownRef(): FileRef {
  return {
    id: 'session-registry:/workspace/out.md',
    fileId: 'sf_out',
    kind: 'markdown',
    source: 'session-registry',
    name: 'out.md',
    path: '',
    ext: 'md',
    status: 'available',
    resource: {
      resourceId: 'res_sf_out',
      studioId: 'studio_local',
      links: {
        self: '/api/resources/res_sf_out',
        content: '/api/resources/res_sf_out/content',
      },
    },
  };
}

function remoteSvgRef(): FileRef {
  return {
    id: 'session-registry:/workspace/diagram.svg',
    fileId: 'sf_svg',
    kind: 'svg',
    source: 'session-registry',
    name: 'diagram.svg',
    path: '',
    ext: 'svg',
    status: 'available',
    resource: {
      resourceId: 'res_sf_svg',
      studioId: 'studio_local',
      links: {
        self: '/api/resources/res_sf_svg',
        content: '/api/resources/res_sf_svg/content',
      },
    },
  };
}

describe('remote file preview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.documentElement.setAttribute('data-platform', 'web');
    codiaFetchMock.mockResolvedValue(new Response('# Remote file'));
  });

  afterEach(() => {
    document.documentElement.removeAttribute('data-platform');
    document.body.innerHTML = '';
  });

  it('opens a resource-backed markdown file in the preview panel on PWA', async () => {
    const { openFileRefPreview } = await import('../../utils/remote-file-preview');

    await openFileRefPreview(remoteMarkdownRef(), { origin: 'session', sessionPath: '/s/a.jsonl' });

    expect(codiaFetchMock).toHaveBeenCalledWith('/api/resources/res_sf_out/content');
    expect(openPreviewMock).toHaveBeenCalledWith(expect.objectContaining({
      id: 'resource-res_sf_out',
      type: 'markdown',
      title: 'out.md',
      content: '# Remote file',
      storageKind: 'remote-content',
    }));
    expect(openFilePreviewMock).not.toHaveBeenCalled();
  });

  it('builds a device download URL from the resource content link', async () => {
    const { fileRefDownloadUrl } = await import('../../utils/remote-file-preview');

    expect(fileRefDownloadUrl(remoteMarkdownRef())).toBe('https://pwa.local/api/resources/res_sf_out/content');
  });

  it('opens resource-backed SVG files as diagram previews instead of the media viewer', async () => {
    const { openFileRefPreview } = await import('../../utils/remote-file-preview');

    await openFileRefPreview(remoteSvgRef(), { origin: 'session', sessionPath: '/s/a.jsonl' });

    expect(openMediaViewerForRefMock).not.toHaveBeenCalled();
    expect(openPreviewMock).not.toHaveBeenCalled();
    const viewer = document.body.querySelector<HTMLElement>('.markdown-visual-diagram.is-expanded[data-fullscreen-hosted="true"]');
    expect(viewer).toBeTruthy();
    expect(viewer?.querySelector('img')?.getAttribute('src')).toContain('/api/resources/res_sf_svg/content');
    expect(Number(viewer?.dataset.markdownVisualScale)).toBeGreaterThan(1);
  });

  it('opens mobile workbench text with a versioned remote content reference', async () => {
    const { openMobileWorkbenchPreview } = await import('../../utils/remote-file-preview');
    const mtime = '2026-06-04T07:47:05.360Z';
    const mtimeMs = Date.parse(mtime);

    await openMobileWorkbenchPreview({
      rootId: 'root-a',
      subdir: 'docs',
      file: {
        name: 'note.md',
        isDir: false,
        size: 13,
        mtime,
      },
    });

    expect(codiaFetchMock).toHaveBeenCalledWith(
      `/api/workbench/content?mountId=root-a&subdir=docs&name=note.md&v=${encodeURIComponent(`${mtimeMs}-13`)}`,
    );
    expect(openPreviewMock).toHaveBeenCalledWith(expect.objectContaining({
      id: 'workbench-root-a%3Adocs%3Anote.md',
      type: 'markdown',
      title: 'note.md',
      storageKind: 'remote-content',
      fileVersion: { mtimeMs, size: 13 },
      remoteContentRef: expect.objectContaining({
        kind: 'workbench-file',
        mountId: 'root-a',
        rootId: 'root-a',
        subdir: 'docs',
        name: 'note.md',
        contentPath: '/api/workbench/content?mountId=root-a&subdir=docs&name=note.md',
        version: { mtimeMs, size: 13 },
      }),
    }));
  });

  it('saves mobile workbench text through the remote action route', async () => {
    codiaFetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      ok: true,
      version: { mtimeMs: 20, size: 7, sha256: 'next' },
    }), {
      headers: { 'Content-Type': 'application/json' },
    }));

    const { saveRemoteWorkbenchContent } = await import('../../utils/remote-file-preview');
    const result = await saveRemoteWorkbenchContent({
      kind: 'mobile-workbench',
      rootId: 'root-a',
      subdir: 'docs',
      name: 'note.md',
      contentPath: '/api/mobile/workbench/content?rootId=root-a&subdir=docs&name=note.md',
      version: { mtimeMs: 10, size: 5 },
    }, 'updated', { mtimeMs: 10, size: 5 });

    expect(codiaFetchMock).toHaveBeenCalledWith('/api/workbench/actions', expect.objectContaining({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'writeText',
        mountId: 'root-a',
        subdir: 'docs',
        name: 'note.md',
        content: 'updated',
        expectedVersion: { mtimeMs: 10, size: 5 },
      }),
    }));
    expect(result).toEqual({
      ok: true,
      conflict: false,
      version: { mtimeMs: 20, size: 7, sha256: 'next' },
    });
  });
});
