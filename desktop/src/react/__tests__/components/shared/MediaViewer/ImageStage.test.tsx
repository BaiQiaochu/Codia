/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { ImageStage } from '../../../../components/shared/MediaViewer/ImageStage';
import type { FileRef } from '../../../../types/file-ref';

describe('ImageStage', () => {
  const file: FileRef = { id: '1', kind: 'image', source: 'desk', name: 'a.png', path: '/a.png', ext: 'png' };
  let getFileUrlMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    getFileUrlMock = vi.fn((p: string) => `file:///MOCK${p}`);
    Object.defineProperty(window, 'platform', {
      configurable: true,
      value: { getFileUrl: getFileUrlMock } as Partial<Window['platform']> as Window['platform'],
    });
  });

  afterEach(() => {
    cleanup();
    Reflect.deleteProperty(window, 'platform');
  });

  it('renders image refs through preload file URLs', async () => {
    const { container } = render(<ImageStage file={file} viewport={{ width: 800, height: 600 }} />);

    await waitFor(() => {
      const img = container.querySelector('img');
      expect(img).toBeTruthy();
      expect(img!.getAttribute('src')).toBe('file:///MOCK/a.png');
    });
    expect(getFileUrlMock).toHaveBeenCalledWith('/a.png');
  });

  it('zooms images with plain wheel and touchpad ctrl+wheel gestures', async () => {
    const { container } = render(<ImageStage file={file} viewport={{ width: 800, height: 600 }} />);
    await waitFor(() => expect(container.querySelector('img')?.getAttribute('src')).toBeTruthy());

    const img = container.querySelector('img')!;
    Object.defineProperty(img, 'naturalWidth', { value: 400, configurable: true });
    Object.defineProperty(img, 'naturalHeight', { value: 300, configurable: true });
    fireEvent.load(img);

    const stage = container.querySelector('[data-testid="image-stage"]') as HTMLElement;
    const before = stage.style.transform || '';
    fireEvent.wheel(stage, { deltaY: -100, clientX: 400, clientY: 300 });
    expect(stage.style.transform || '').not.toBe(before);
    const afterPlainWheel = stage.style.transform || '';

    fireEvent.wheel(stage, { deltaY: -100, clientX: 400, clientY: 300, ctrlKey: true });
    expect(stage.style.transform || '').not.toBe(afterPlainWheel);
    const afterCtrlWheel = stage.style.transform || '';

    fireEvent.wheel(stage, { deltaY: -100, clientX: 400, clientY: 300, shiftKey: true });
    fireEvent.wheel(stage, { deltaY: -100, clientX: 400, clientY: 300, altKey: true, metaKey: true });
    expect(stage.style.transform || '').toBe(afterCtrlWheel);

    fireEvent.wheel(stage, { deltaY: -100, clientX: 400, clientY: 300, altKey: true });
    expect(stage.style.transform || '').not.toBe(afterCtrlWheel);
  });

  it('centers the image at fit scale once natural size is known', async () => {
    const { container } = render(<ImageStage file={file} viewport={{ width: 1000, height: 800 }} />);
    await waitFor(() => expect(container.querySelector('img')?.getAttribute('src')).toBeTruthy());

    const img = container.querySelector('img')!;
    Object.defineProperty(img, 'naturalWidth', { value: 500, configurable: true });
    Object.defineProperty(img, 'naturalHeight', { value: 400, configurable: true });
    fireEvent.load(img);

    await waitFor(() => {
      const transform = (container.querySelector('[data-testid="image-stage"]') as HTMLElement).style.transform;
      expect(transform).toBe('translate(50px, 40px) scale(1.8)');
    });
  });

  it('uses dragging state and pointer cancel cleanup for zoomed images', async () => {
    const { container } = render(<ImageStage file={file} viewport={{ width: 800, height: 600 }} />);
    await waitFor(() => expect(container.querySelector('img')?.getAttribute('src')).toBeTruthy());

    const img = container.querySelector('img')!;
    Object.defineProperty(img, 'naturalWidth', { value: 400, configurable: true });
    Object.defineProperty(img, 'naturalHeight', { value: 300, configurable: true });
    fireEvent.load(img);

    const stage = container.querySelector('[data-testid="image-stage"]') as HTMLElement;
    stage.setPointerCapture = vi.fn();
    stage.releasePointerCapture = vi.fn();
    stage.hasPointerCapture = vi.fn(() => true);

    fireEvent.wheel(stage, { deltaY: -100, clientX: 400, clientY: 300 });
    fireEvent.pointerDown(stage, { pointerId: 1, button: 0, clientX: 120, clientY: 140 });
    expect(stage.style.cursor).toBe('grabbing');
    fireEvent.pointerCancel(stage, { pointerId: 1 });
    expect(stage.releasePointerCapture).toHaveBeenCalledWith(1);
    expect(stage.style.cursor).toBe('grab');
  });
});
