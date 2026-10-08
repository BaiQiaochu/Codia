import { isImageFile } from './format';
import type { AttachedFile } from '../stores/input-slice';

const IMAGE_EXTENSION_TO_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
};

const MIME_TO_IMAGE_EXTENSION: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
};

export const VISION_IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

export function guessImageMimeType(fileName: string): string | null {
  const ext = (fileName || '').toLowerCase().replace(/^.*\./, '');
  return IMAGE_EXTENSION_TO_MIME[ext] || null;
}

export function getImageExtensionFromMimeType(mimeType: string): string {
  return MIME_TO_IMAGE_EXTENSION[mimeType] || 'png';
}

export function isVisionMimeTypeSupported(mimeType: string | undefined | null): boolean {
  return !!mimeType && VISION_IMAGE_MIME_TYPES.has(mimeType);
}

export function containsImageAttachments(files: Array<Pick<AttachedFile, 'name' | 'isDirectory'>>): boolean {
  return files.some((file) => !file.isDirectory && isImageFile(file.name));
}

function dataUrlFromBase64(base64Data: string, mimeType: string): string {
  return `data:${mimeType};base64,${base64Data}`;
}

function loadImageElement(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('image decode failed'));
    image.src = dataUrl;
  });
}

async function convertUnsupportedImageToPng(base64Data: string, mimeType: string): Promise<{ base64Data: string; mimeType: string }> {
  if (typeof document === 'undefined') {
    return { base64Data, mimeType };
  }

  const image = await loadImageElement(dataUrlFromBase64(base64Data, mimeType));

  const canvas = document.createElement('canvas');
  canvas.width = image.width || 1;
  canvas.height = image.height || 1;

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return { base64Data, mimeType };
  }

  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  const pngDataUrl = canvas.toDataURL('image/png');
  const match = pngDataUrl.match(/^data:image\/png;base64,(.+)$/);
  if (!match) {
    return { base64Data, mimeType };
  }

  return {
    base64Data: match[1],
    mimeType: 'image/png',
  };
}

export async function prepareImageAttachmentForVision(
  file: AttachedFile,
  readFileBase64?: (filePath: string) => Promise<string | null>,
): Promise<AttachedFile> {
  if (file.isDirectory || !isImageFile(file.name)) return file;

  let base64Data = file.base64Data;
  let mimeType = file.mimeType || guessImageMimeType(file.name) || 'image/png';

  if (!base64Data && readFileBase64) {
    base64Data = (await readFileBase64(file.path)) || undefined;
  }

  if (!base64Data) {
    return { ...file, mimeType };
  }

  if (!isVisionMimeTypeSupported(mimeType)) {
    try {
      const normalized = await convertUnsupportedImageToPng(base64Data, mimeType);
      base64Data = normalized.base64Data;
      mimeType = normalized.mimeType;
    } catch {
      return { ...file, base64Data, mimeType };
    }
  }

  return {
    ...file,
    base64Data,
    mimeType,
  };
}
