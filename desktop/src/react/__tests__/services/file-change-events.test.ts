/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformApi } from '../../types';

describe('file-change-events', () => {
  let fileChangedHandler: ((filePath: string) => void) | null;
  let platform: Pick<PlatformApi, 'watchFile' | 'unwatchFile' | 'onFileChanged'>;

  beforeEach(() => {
    vi.resetModules();
    fileChangedHandler = null;
    platform = {
      watchFile: vi.fn(async () => true),
      unwatchFile: vi.fn(async () => true),
      onFileChanged: vi.fn((handler: (filePath: string) => void) => {
        fileChangedHandler = handler;
      }),
    };
    window.platform = platform as PlatformApi;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('shares one platform watcher per file and releases it only after the last subscriber leaves', async () => {
    const { watchFileChanges } = await import('../../services/file-change-events');
    const first = vi.fn();
    const second = vi.fn();

    const unwatchFirst = watchFileChanges('/tmp/note.md', first);
    const unwatchSecond = watchFileChanges('/tmp/note.md', second);

    expect(platform.watchFile).toHaveBeenCalledTimes(1);
    expect(platform.watchFile).toHaveBeenCalledWith('/tmp/note.md');
    expect(platform.onFileChanged).toHaveBeenCalledTimes(1);

    fileChangedHandler?.('/tmp/note.md');
    expect(first).toHaveBeenCalledWith('/tmp/note.md');
    expect(second).toHaveBeenCalledWith('/tmp/note.md');

    unwatchFirst();
    fileChangedHandler?.('/tmp/note.md');
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
    expect(platform.unwatchFile).not.toHaveBeenCalled();

    unwatchSecond();
    unwatchSecond();
    await Promise.resolve();
    expect(platform.unwatchFile).toHaveBeenCalledTimes(1);
    expect(platform.unwatchFile).toHaveBeenCalledWith('/tmp/note.md');
  });

  it('retries platform watcher creation when the first attempt reports failure', async () => {
    vi.useFakeTimers();
    vi.mocked(platform.watchFile!).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const { watchFileChanges } = await import('../../services/file-change-events');

    const unwatch = watchFileChanges('/tmp/note.md', vi.fn());

    expect(platform.watchFile).toHaveBeenCalledTimes(1);
    expect(platform.watchFile).toHaveBeenLastCalledWith('/tmp/note.md');

    await vi.advanceTimersByTimeAsync(1000);

    expect(platform.watchFile).toHaveBeenCalledTimes(2);
    expect(platform.watchFile).toHaveBeenLastCalledWith('/tmp/note.md');

    unwatch();
  });

  it('matches Windows change events across slash and drive-letter casing differences', async () => {
    const { watchFileChanges } = await import('../../services/file-change-events');
    const handler = vi.fn();

    const unwatch = watchFileChanges('C:\\Users\\Me\\Desk\\Note.md', handler);

    fileChangedHandler?.('c:/users/me/desk/note.md');

    expect(handler).toHaveBeenCalledWith('C:\\Users\\Me\\Desk\\Note.md');

    unwatch();
  });
});
