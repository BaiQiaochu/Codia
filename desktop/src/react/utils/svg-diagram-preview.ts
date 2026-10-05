import { useStore } from '../stores';
import { resolveServerConnection } from '../services/server-connection';
import { resolveFileRefUrl } from '../services/resource-url';
import type { FileRef } from '../types/file-ref';
import { openMarkdownVisualFullscreen } from './markdown-visual-controls';
import { showError } from './ui-helpers';

export function openSvgDiagramPreviewForRef(ref: FileRef): boolean {
  if (ref.kind !== 'svg') return false;

  try {
    const connection = resolveServerConnection(useStore.getState());
    const resolved = resolveFileRefUrl(ref, {
      connection,
      platform: window.platform,
      preferLocalFile: true,
    });
    const title = ref.name || ref.path.split(/[\\/]/).pop() || 'diagram.svg';
    openMarkdownVisualFullscreen({ src: resolved.url, title });
    return true;
  } catch (err) {
    console.error('[svg-preview] open svg diagram preview failed:', err);
    showError(err instanceof Error ? err.message : String(err));
    return true;
  }
}

export function openSvgDiagramPreviewFromUrl({
  title,
  url,
}: {
  id: string;
  title: string;
  url: string;
  ext?: string;
  storageKind?: string;
}): void {
  openMarkdownVisualFullscreen({ src: url, title });
}
