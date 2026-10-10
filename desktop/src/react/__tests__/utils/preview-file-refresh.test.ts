/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../stores';
import type { PlatformApi } from '../../types';
import {
  __resetPreviewFileRefreshStateForTests,
  refreshPreviewItemsFromFile,
} from '../../utils/preview-file-refresh';

describe('preview-file-refresh', () => {
  beforeEach(() => {
    __resetPreviewFileRefreshStateForTests();
    window.t = ((key: string) => key) as typeof window.t;
    window.platform = {
      readFileSnapshot: vi.fn(async () => ({
        content: '# after',
        version: { mtimeMs: 2, size: 7 },
      })),
      readFile: vi.fn(async () => null),
    } as unknown as PlatformApi;
    useStore.setState({
      previewByOwner: {
        desk: {
          artifacts: [{
            id: 'file-note',
            type: 'markdown',
            title: 'note.md',
            content: '# before',
            filePath: '/tmp/note.md',
            fileVersion: { mtimeMs: 1, size: 8 },
          }],
          openTabs: ['file-note'],
          activeTabId: 'file-note',
          markdownPreviewIds: [],
          previewReadingPositions: {},
        },
      },
    });
  });

  it('refreshes owner-keyed preview artifacts from the current file snapshot', async () => {
    await refreshPreviewItemsFromFile('/tmp/note.md');

    const artifact = useStore.getState().previewByOwner.desk.artifacts[0];
    expect(artifact.content).toBe('# after');
    expect(artifact.fileVersion).toEqual({ mtimeMs: 2, size: 7 });
    expect(artifact.status).toBe('available');
    expect(artifact.missingAt).toBeNull();
  });

  it('marks an artifact missing when the backing file cannot be read', async () => {
    window.platform = {
      readFileSnapshot: vi.fn(async () => null),
      readFile: vi.fn(async () => null),
    } as unknown as PlatformApi;
    const notice = vi.fn();
    window.addEventListener('codia-inline-notice', notice);

    await refreshPreviewItemsFromFile('/tmp/note.md');

    const artifact = useStore.getState().previewByOwner.desk.artifacts[0];
    expect(artifact.status).toBe('missing');
    expect(typeof artifact.missingAt).toBe('number');
    expect(notice).not.toHaveBeenCalled();
    window.removeEventListener('codia-inline-notice', notice);
  });
});
