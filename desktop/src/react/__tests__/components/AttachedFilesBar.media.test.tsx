// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AttachedFilesBar } from '../../components/input/AttachedFilesBar';

describe('AttachedFilesBar media chips', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    delete (window as unknown as { platform?: unknown }).platform;
  });

  it('renders image attachments with rounded thumbnail previews', () => {
    const onRemove = vi.fn();
    window.platform = {
      getFileUrl: vi.fn((filePath: string) => `file://${filePath}`),
    } as unknown as typeof window.platform;

    const { container } = render(
      <AttachedFilesBar
        files={[{ path: '/tmp/pasted.png', name: 'pasted.png', mimeType: 'image/png' }]}
        onRemove={onRemove}
      />,
    );

    expect(screen.getByText('pasted.png')).toBeInTheDocument();
    expect(screen.getByText('@')).toBeInTheDocument();
    const image = container.querySelector('img');
    expect(image).toHaveAttribute('src', 'file:///tmp/pasted.png');
    expect(window.platform.getFileUrl).toHaveBeenCalledWith('/tmp/pasted.png');

    fireEvent.click(screen.getByLabelText('Remove pasted.png'));
    expect(onRemove).toHaveBeenCalledWith(0);
  });

  it('renders gif attachments as eager inline image previews so they animate without clicking', () => {
    window.platform = {
      getFileUrl: vi.fn((filePath: string) => `file://${filePath}`),
    } as unknown as typeof window.platform;

    const { container } = render(
      <AttachedFilesBar
        files={[{ path: '/tmp/loop.gif', name: 'loop.gif', mimeType: 'image/gif' }]}
        onRemove={vi.fn()}
      />,
    );

    const image = container.querySelector('img');
    expect(image).toHaveAttribute('src', 'file:///tmp/loop.gif');
    expect(image).toHaveAttribute('loading', 'eager');
    expect(image).toHaveAttribute('data-gif-preview', 'true');
  });

  it('renders audio attachments with a play control, waveform, and remove action', () => {
    const onRemove = vi.fn();
    const audioInstances: Array<{ src: string; play: ReturnType<typeof vi.fn>; pause: ReturnType<typeof vi.fn> }> = [];
    const AudioMock = vi.fn().mockImplementation(function MockAudio(this: {
      src: string;
      play: ReturnType<typeof vi.fn>;
      pause: ReturnType<typeof vi.fn>;
      onended: (() => void) | null;
      onerror: (() => void) | null;
    }, src: string) {
      this.src = src;
      this.play = vi.fn(() => Promise.resolve());
      this.pause = vi.fn();
      this.onended = null;
      this.onerror = null;
      audioInstances.push(this);
    });
    vi.stubGlobal('Audio', AudioMock);
    window.platform = {
      getFileUrl: vi.fn((filePath: string) => `file://${filePath}`),
    } as unknown as typeof window.platform;

    render(
      <AttachedFilesBar
        files={[{ path: '/tmp/clip.wav', name: 'clip.wav', mimeType: 'audio/wav' }]}
        onRemove={onRemove}
      />,
    );

    expect(screen.getByText('@')).toBeInTheDocument();
    expect(screen.getByTestId('audio-attachment-wave')).toBeInTheDocument();
    expect(screen.getByText('clip.wav')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Play clip.wav'));

    expect(AudioMock).toHaveBeenCalledWith('file:///tmp/clip.wav');
    expect(audioInstances[0].play).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByLabelText('Remove clip.wav'));

    expect(audioInstances[0].pause).toHaveBeenCalledTimes(1);
    expect(onRemove).toHaveBeenCalledWith(0);
  });
});
