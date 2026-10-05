// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  containsImageAttachments,
  getImageExtensionFromMimeType,
  isVisionMimeTypeSupported,
  prepareImageAttachmentForVision,
} from '../../utils/image-attachments';

describe('image attachment helpers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('hydrates supported raster images from file reads without changing mime type', async () => {
    const readFileBase64 = vi.fn(async () => 'png-base64');

    const prepared = await prepareImageAttachmentForVision({
      path: 'E:/images/photo.png',
      name: 'photo.png',
    }, readFileBase64);

    expect(readFileBase64).toHaveBeenCalledWith('E:/images/photo.png');
    expect(prepared.base64Data).toBe('png-base64');
    expect(prepared.mimeType).toBe('image/png');
  });

  it('converts unsupported image formats to png for vision upload', async () => {
    const originalCreateElement = document.createElement.bind(document);
    const drawImage = vi.fn();
    const toDataURL = vi.fn(() => 'data:image/png;base64,converted-png');

    vi.spyOn(document, 'createElement').mockImplementation((tagName: string) => {
      if (tagName === 'canvas') {
        return {
          width: 0,
          height: 0,
          getContext: () => ({ drawImage }),
          toDataURL,
        } as unknown as HTMLCanvasElement;
      }
      return originalCreateElement(tagName);
    });

    class FakeImage {
      width = 640;
      height = 480;
      onload: null | (() => void) = null;
      onerror: null | (() => void) = null;

      set src(_value: string) {
        queueMicrotask(() => this.onload?.());
      }
    }

    vi.stubGlobal('Image', FakeImage as unknown as typeof Image);

    const prepared = await prepareImageAttachmentForVision({
      path: 'E:/images/diagram.svg',
      name: 'diagram.svg',
      base64Data: 'svg-base64',
      mimeType: 'image/svg+xml',
    });

    expect(drawImage).toHaveBeenCalledTimes(1);
    expect(toDataURL).toHaveBeenCalledWith('image/png');
    expect(prepared.mimeType).toBe('image/png');
    expect(prepared.base64Data).toBe('converted-png');
  });

  it('detects image attachments and supported vision mime types', () => {
    expect(containsImageAttachments([
      { name: 'a.txt' },
      { name: 'pic.webp' },
    ])).toBe(true);
    expect(containsImageAttachments([
      { name: 'notes.md' },
    ])).toBe(false);

    expect(isVisionMimeTypeSupported('image/png')).toBe(true);
    expect(isVisionMimeTypeSupported('image/svg+xml')).toBe(false);
    expect(getImageExtensionFromMimeType('image/webp')).toBe('webp');
  });
});
