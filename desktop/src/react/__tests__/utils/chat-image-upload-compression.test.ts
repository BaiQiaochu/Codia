// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareChatImageUpload } from '../../utils/chat-image-upload-compression';

function installImageCompressionMocks() {
  const close = vi.fn();
  const drawImage = vi.fn();
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({
    width: 4000,
    height: 3000,
    close,
  })));
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage,
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function toBlob(
    callback: BlobCallback,
    type?: string,
  ) {
    callback(new Blob([new Uint8Array([4, 5, 6])], { type: type || 'image/jpeg' }));
  });
  return { close, drawImage };
}

describe('chat image upload compression', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('keeps images below the upload budget unchanged', async () => {
    const result = await prepareChatImageUpload({
      file: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
      name: 'pasted.png',
      mimeType: 'image/png',
      base64Data: 'AQID',
    });

    expect(result).toEqual({
      name: 'pasted.png',
      mimeType: 'image/png',
      base64Data: 'AQID',
      compressed: false,
    });
  });

  it('compresses oversized pasted images before upload', async () => {
    const { close, drawImage } = installImageCompressionMocks();
    const result = await prepareChatImageUpload({
      file: new Blob([new Uint8Array(900 * 1024)], { type: 'image/png' }),
      name: 'input.pastedImage.png',
      mimeType: 'image/png',
      base64Data: 'x'.repeat(900 * 1024),
    });

    expect(result).toEqual({
      name: 'input.pastedImage.jpg',
      mimeType: 'image/jpeg',
      base64Data: 'BAUG',
      compressed: true,
    });
    expect(drawImage).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
  });
});
