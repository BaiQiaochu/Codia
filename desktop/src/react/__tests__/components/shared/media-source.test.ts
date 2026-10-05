// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadMediaSource } from '../../../components/shared/MediaViewer/media-source';
import type { FileRef } from '../../../types/file-ref';

function makeRef(path: string, kind: FileRef['kind'] = 'image'): FileRef {
  return {
    id: `ref:${path}`,
    kind,
    source: 'desk',
    name: `preview-${kind}`,
    path,
  };
}

describe('loadMediaSource', () => {
  const getFileUrl = vi.fn((filePath: string) => `file://${filePath}`);

  beforeEach(() => {
    getFileUrl.mockClear();
    (window as unknown as { platform?: { getFileUrl?: (filePath: string) => string } }).platform = {
      getFileUrl,
    };
  });

  it('keeps direct media URLs unchanged', async () => {
    const result = await loadMediaSource(makeRef('https://example.com/image.png'));

    expect(result.url).toBe('https://example.com/image.png');
    expect(getFileUrl).not.toHaveBeenCalled();
  });

  it('still converts local file paths through preload', async () => {
    const result = await loadMediaSource(makeRef('E:\\images\\photo.png'));

    expect(result.url).toBe('file://E:\\images\\photo.png');
    expect(getFileUrl).toHaveBeenCalledWith('E:\\images\\photo.png');
  });

  it('supports audio refs used by AudioStage', async () => {
    const result = await loadMediaSource(makeRef('E:\\audio\\sample.mp3', 'audio'));

    expect(result.url).toBe('file://E:\\audio\\sample.mp3');
    expect(getFileUrl).toHaveBeenCalledWith('E:\\audio\\sample.mp3');
  });
});
