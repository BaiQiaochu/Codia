import { describe, expect, it } from 'vitest';
import { useStore } from '../../stores';

describe('screenshot slice', () => {
  it('tracks screenshot task progress and clears after completion', () => {
    useStore.setState({
      screenshotTaskCount: 0,
      screenshotProgress: null,
    } as never);

    useStore.getState().beginScreenshotTask({
      completedBlocks: 0,
      totalBlocks: 4,
      currentPage: 1,
      totalPages: 2,
    });

    expect(useStore.getState().screenshotTaskCount).toBe(1);
    expect(useStore.getState().screenshotProgress).toEqual({
      completedBlocks: 0,
      totalBlocks: 4,
      currentPage: 1,
      totalPages: 2,
    });

    useStore.getState().updateScreenshotProgress({ completedBlocks: 3, currentPage: 2 });
    expect(useStore.getState().screenshotProgress).toMatchObject({
      completedBlocks: 3,
      currentPage: 2,
    });

    useStore.getState().endScreenshotTask();
    expect(useStore.getState().screenshotTaskCount).toBe(0);
    expect(useStore.getState().screenshotProgress).toBeNull();
  });
});
