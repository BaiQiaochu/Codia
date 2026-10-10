// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileRef } from '../../../types/file-ref';

const codiaUrlMock = vi.fn((path: string) => `https://pwa.local${path}`);

vi.mock('../../../hooks/use-codia-fetch', () => ({
  codiaUrl: (path: string) => codiaUrlMock(path),
}));

function remoteImageRef(): FileRef {
  return {
    id: 'session-registry:/workspace/image.png',
    fileId: 'sf_image',
    kind: 'image',
    source: 'session-registry',
    name: 'image.png',
    path: '',
    ext: 'png',
    resource: {
      resourceId: 'res_sf_image',
      studioId: 'studio_local',
      links: {
        self: '/api/resources/res_sf_image',
        content: '/api/resources/res_sf_image/content',
      },
    },
  };
}

describe('media source remote resources', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (window as unknown as { platform?: unknown }).platform = undefined;
  });

  it('loads media from resource content links without requiring desktop platform APIs', async () => {
    const { loadMediaSource } = await import('../../../components/shared/MediaViewer/media-source');

    await expect(loadMediaSource(remoteImageRef())).resolves.toEqual({
      url: 'https://pwa.local/api/resources/res_sf_image/content',
    });
  });
});
