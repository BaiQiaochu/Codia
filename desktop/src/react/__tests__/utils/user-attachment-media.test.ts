import { describe, expect, it, vi } from 'vitest';
import { getUserAttachmentImageSrc } from '../../utils/user-attachment-media';

describe('getUserAttachmentImageSrc', () => {
  it('prefers inline base64 payloads', () => {
    const platform = { getFileUrl: vi.fn(() => 'file:///tmp/pic.png') };

    expect(getUserAttachmentImageSrc({
      path: '/tmp/pic.png',
      base64Data: 'BASE64',
      mimeType: 'image/png',
    }, platform)).toBe('data:image/png;base64,BASE64');
    expect(platform.getFileUrl).not.toHaveBeenCalled();
  });

  it('falls back to preload file URLs for local images', () => {
    const platform = { getFileUrl: vi.fn((p: string) => `file://${p}`) };

    expect(getUserAttachmentImageSrc({
      path: '/Users/test/.hanako/attachments/upload-abc.png',
    }, platform)).toBe('file:///Users/test/.hanako/attachments/upload-abc.png');
  });
});
