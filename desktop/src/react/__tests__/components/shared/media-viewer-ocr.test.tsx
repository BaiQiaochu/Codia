// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MediaViewer } from '../../../components/shared/MediaViewer/MediaViewer';
import { OCR_PANEL_TIMEOUT_MS } from '../../../components/shared/MediaViewer/OcrPanel';

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
const recognizeMock = vi.hoisted(() => vi.fn(async () => '识别文本'));

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

vi.mock('../../../components/shared/MediaViewer/offline-ocr', () => ({
  recognizeImageWithOfflineOcr: recognizeMock,
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

describe('MediaViewer OCR action', () => {
  beforeEach(() => {
    recognizeMock.mockClear();
    setViewerFile({
      id: 'img',
      kind: 'image',
      source: 'desk',
      name: 'receipt.png',
      path: 'E:/receipt.png',
      ext: 'png',
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('shows OCR action for bitmap images', () => {
    render(<MediaViewer />);
    expect(screen.getByTestId('media-viewer-ocr')).toBeTruthy();
  });

  it('hides OCR action for videos', () => {
    setViewerFile({
      id: 'vid',
      kind: 'video',
      source: 'desk',
      name: 'clip.mp4',
      path: 'E:/clip.mp4',
      ext: 'mp4',
    });

    render(<MediaViewer />);

    expect(screen.queryByTestId('media-viewer-ocr')).toBeNull();
  });

  it('hides OCR action for SVG images', () => {
    setViewerFile({
      id: 'svg',
      kind: 'svg',
      source: 'desk',
      name: 'diagram.svg',
      path: 'E:/diagram.svg',
      ext: 'svg',
    });

    render(<MediaViewer />);

    expect(screen.queryByTestId('media-viewer-ocr')).toBeNull();
  });

  it('recognizes the current image through the offline runtime', async () => {
    render(<MediaViewer />);

    fireEvent.click(screen.getByTestId('media-viewer-ocr'));

    await waitFor(() => expect(screen.getByTestId('media-viewer-ocr-result').textContent).toContain('识别文本'));
    expect(recognizeMock).toHaveBeenCalledWith(expect.objectContaining({
      path: 'E:/receipt.png',
      name: 'receipt.png',
    }));
  });

  it('stops showing the running state when the OCR runtime stalls', async () => {
    vi.useFakeTimers();
    recognizeMock.mockImplementationOnce(() => new Promise(() => undefined));

    render(<MediaViewer />);

    fireEvent.click(screen.getByTestId('media-viewer-ocr'));
    expect(screen.getByTestId('media-viewer-ocr-result').textContent).toContain('正在识别');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(OCR_PANEL_TIMEOUT_MS);
    });

    expect(screen.getByTestId('media-viewer-ocr-result').textContent).toMatch(/超时|timed out/i);
    expect(screen.getByTestId('media-viewer-ocr').getAttribute('disabled')).toBeNull();
  });
  it('cancels the running OCR request when the panel is closed', async () => {
    let resolveOcr: (value: string) => void = () => {};
    recognizeMock.mockImplementationOnce(() => new Promise<string>((resolve) => {
      resolveOcr = resolve;
    }));

    render(<MediaViewer />);

    fireEvent.click(screen.getByTestId('media-viewer-ocr'));
    expect(screen.getByTestId('media-viewer-ocr-panel')).toBeTruthy();
    expect(screen.getByTestId('media-viewer-ocr').getAttribute('disabled')).not.toBeNull();

    const closeButton = screen.getByTestId('media-viewer-ocr-panel').querySelector('button') as HTMLButtonElement;
    fireEvent.click(closeButton);

    expect(screen.queryByTestId('media-viewer-ocr-panel')).toBeNull();
    expect(screen.getByTestId('media-viewer-ocr').getAttribute('disabled')).toBeNull();

    await act(async () => {
      resolveOcr('late OCR text');
    });

    expect(screen.queryByText('late OCR text')).toBeNull();
  });
});
