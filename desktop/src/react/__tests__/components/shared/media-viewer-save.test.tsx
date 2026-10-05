// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MediaViewer } from '../../../components/shared/MediaViewer/MediaViewer';

type MockStoreState = {
  mediaViewer: {
    files: Array<{
      id: string;
      kind: 'video';
      source: 'desk';
      name: string;
      path: string;
      ext: string;
    }>;
    currentId: string;
    origin: 'desk';
  } | null;
  closeMediaViewer: ReturnType<typeof vi.fn>;
  setMediaViewerCurrent: ReturnType<typeof vi.fn>;
};

let storeState: MockStoreState;

const storeMock = vi.hoisted(() => ({
  state: null as MockStoreState | null,
}));

vi.mock('../../../stores', () => ({
  useStore: <T,>(selector: (state: MockStoreState) => T): T => selector(storeMock.state as MockStoreState),
}));

vi.mock('../../../components/shared/MediaViewer/VideoStage', () => ({
  VideoStage: () => <div data-testid="video-stage" />,
}));

vi.mock('../../../components/shared/MediaViewer/ImageStage', () => ({
  ImageStage: () => <div data-testid="image-stage" />,
}));

vi.mock('../../../components/shared/MediaViewer/AudioStage', () => ({
  AudioStage: () => <div data-testid="audio-stage" />,
}));

describe('MediaViewer save action', () => {
  beforeEach(() => {
    storeState = {
      mediaViewer: {
        files: [{
          id: 'video:demo',
          kind: 'video',
          source: 'desk',
          name: 'demo.mp4',
          path: 'E:/generated/demo.mp4',
          ext: 'mp4',
        }],
        currentId: 'video:demo',
        origin: 'desk',
      },
      closeMediaViewer: vi.fn(),
      setMediaViewerCurrent: vi.fn(),
    };
    storeMock.state = storeState;

    Object.assign(window, {
      platform: {
        saveFileAs: vi.fn(),
        showInFinder: vi.fn(),
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('saves the current video from the viewer toolbar', () => {
    const { getByTestId } = render(<MediaViewer />);

    fireEvent.click(getByTestId('media-viewer-save'));

    expect(window.platform.saveFileAs).toHaveBeenCalledWith('E:/generated/demo.mp4', 'demo.mp4');
  });
});
