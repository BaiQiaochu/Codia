import type { FileKind, FileRef } from '../types/file-ref';
import { extOfName, inferKindByExt } from './file-kind';
import { openMediaViewerForRef } from './open-media-viewer';

const DIRECT_MEDIA_URL_RE = /^(?:https?:|data:|blob:|file:)/i;

function stripQueryAndHash(value: string): string {
  const queryIdx = value.indexOf('?');
  const hashIdx = value.indexOf('#');
  let end = value.length;
  if (queryIdx >= 0) end = Math.min(end, queryIdx);
  if (hashIdx >= 0) end = Math.min(end, hashIdx);
  return value.slice(0, end);
}

function resolveImageSrc(img: HTMLImageElement): string {
  const raw = (img.currentSrc || img.src || img.getAttribute('src') || '').trim();
  if (!raw) return '';
  if (DIRECT_MEDIA_URL_RE.test(raw)) return raw;
  try {
    return new URL(raw, window.location.href).href;
  } catch {
    return raw;
  }
}

function inferImageKind(src: string): FileKind {
  if (/^data:image\/svg\+xml/i.test(src)) return 'svg';
  const ext = extOfName(stripQueryAndHash(src));
  const kind = inferKindByExt(ext);
  return kind === 'svg' ? 'svg' : 'image';
}

function deriveImageName(img: HTMLImageElement, src: string, kind: FileKind): string {
  const alt = img.getAttribute('alt')?.trim();
  if (alt) return alt;

  try {
    const url = new URL(src);
    const base = url.pathname.split('/').pop();
    if (base) return decodeURIComponent(base);
  } catch {
    // ignore invalid URLs and fall through to plain path parsing
  }

  const base = stripQueryAndHash(src).split(/[\\/]/).pop();
  if (base) return base;
  return kind === 'svg' ? 'image.svg' : 'image';
}

function buildImageRef(img: HTMLImageElement, src: string): FileRef {
  const kind = inferImageKind(src);
  return {
    id: `markdown-image:${src}`,
    kind,
    source: 'desk',
    name: deriveImageName(img, src, kind),
    path: src,
    mime: kind === 'svg' ? 'image/svg+xml' : undefined,
  };
}

export function bindMarkdownImagePreview(container: HTMLElement): () => void {
  const cleanups: Array<() => void> = [];
  const images = Array.from(container.querySelectorAll('img'));

  for (const img of images) {
    const src = resolveImageSrc(img);
    if (!src) continue;
    if (inferImageKind(src) === 'svg') continue;

    const openPreview = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent && event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      event.stopPropagation();
      openMediaViewerForRef(buildImageRef(img, src), { origin: 'desk' });
    };

    if (!img.hasAttribute('tabindex')) img.tabIndex = 0;
    img.setAttribute('role', 'button');
    img.addEventListener('click', openPreview as EventListener);
    img.addEventListener('keydown', openPreview as EventListener);

    cleanups.push(() => {
      img.removeEventListener('click', openPreview as EventListener);
      img.removeEventListener('keydown', openPreview as EventListener);
    });
  }

  return () => {
    for (const dispose of cleanups) dispose();
  };
}
