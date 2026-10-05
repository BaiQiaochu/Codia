// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MediaViewer } from '../../../components/shared/MediaViewer/MediaViewer';

type MockFile = {
  id: string;
  kind: 'image' | 'svg' | 'video' | 'audio';
  source: 'desk';
  name: string;
  path: string;
  ext?: string;
};

type MockStoreState = {
  mediaViewer: {
    files: MockFile[];
    currentId: string;
    origin: 'desk';
  } | null;
  closeMediaViewer: ReturnType<typeof vi.fn>;
  setMediaViewerCurrent: ReturnType<typeof vi.fn>;
};

const storeMock = vi.hoisted(() => ({ state: null as MockStoreState | null }));

vi.mock('../../../stores', () => ({
  useStore: <T,>(selector: (state: MockStoreState) => T): T => selector(storeMock.state as MockStoreState),
}));

vi.mock('../../../components/shared/MediaViewer/ImageStage', () => ({
  ImageStage: () => <div data-testid="image-stage" />,
}));

vi.mock('../../../components/shared/MediaViewer/VideoStage', () => ({
  VideoStage: () => <div data-testid="video-stage" />,
}));

vi.mock('../../../components/shared/MediaViewer/AudioStage', () => ({
  AudioStage: () => <div data-testid="audio-stage" />,
}));

function setViewerFile(file: MockFile): void {
  storeMock.state = {
    mediaViewer: {
      files: [file],
      currentId: file.id,
      origin: 'desk',
    },
    closeMediaViewer: vi.fn(),
    setMediaViewerCurrent: vi.fn(),
  };
}

describe('MediaViewer original chrome parity', () => {
  beforeEach(() => {
    setViewerFile({
      id: 'img',
      kind: 'image',
      source: 'desk',
      name: 'receipt.png',
      path: 'E:/receipt.png',
      ext: 'png',
    });
    Object.assign(window, {
      platform: {
        saveFileAs: vi.fn(),
        showInFinder: vi.fn(),
      },
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('keeps the original bottom caption while preserving enhanced toolbar actions', () => {
    render(<MediaViewer />);

    const caption = screen.getByTestId('media-viewer-caption');
    expect(caption).toContainElement(screen.getByTestId('media-viewer-name'));
    expect(caption.textContent).toContain('receipt.png');
    expect(screen.getByTestId('media-viewer-save')).toBeTruthy();
    expect(screen.getByTestId('media-viewer-ocr')).toBeTruthy();
  });
});
