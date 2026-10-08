/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { VideoStage } from '../../../../components/shared/MediaViewer/VideoStage';
import type { FileRef } from '../../../../types/file-ref';

describe('VideoStage', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'platform', {
      configurable: true,
      value: {
        getFileUrl: (path: string) => `file:///preview${path}`,
      },
    });
  });

  afterEach(() => {
    cleanup();
    Reflect.deleteProperty(window, 'platform');
  });

  it('renders native video controls from the media source', async () => {
    const file: FileRef = {
      id: 'v',
      kind: 'video',
      source: 'desk',
      name: 'clip.mp4',
      path: '/clip.mp4',
      ext: 'mp4',
    };

    const { container } = render(<VideoStage file={file} viewport={{ width: 800, height: 600 }} />);

    await waitFor(() => {
      const video = container.querySelector('video');
      expect(video).toBeTruthy();
      expect(video!.hasAttribute('controls')).toBe(true);
      expect(video!.getAttribute('src')).toBe('file:///preview/clip.mp4');
    });
  });

  it('reloads when the same video id receives a new file version', async () => {
    const first: FileRef = {
      id: 'v',
      kind: 'video',
      source: 'desk',
      name: 'clip.mp4',
      path: '/clip.mp4',
      ext: 'mp4',
      version: { mtimeMs: 1, size: 100 },
    };
    const second: FileRef = {
      ...first,
      version: { mtimeMs: 2, size: 200, sha256: 'next' },
    };

    const { container, rerender } = render(<VideoStage file={first} viewport={{ width: 800, height: 600 }} />);

    await waitFor(() => {
      expect(container.querySelector('video')?.getAttribute('src')).toContain('v=1-100');
    });

    rerender(<VideoStage file={second} viewport={{ width: 800, height: 600 }} />);

    await waitFor(() => {
      expect(container.querySelector('video')?.getAttribute('src')).toContain('v=2-200-next');
    });
  });
});
