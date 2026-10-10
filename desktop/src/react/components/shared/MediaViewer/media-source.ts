import type { FileRef } from '../../../types/file-ref';
import { useStore } from '../../../stores';
import { resolveServerConnection } from '../../../services/server-connection';
import { resolveFileRefUrls } from '../../../services/resource-url';
import { codiaUrl } from '../../../hooks/use-codia-fetch';

export interface MediaSource {
  url: string;
  cleanup?: () => void;
}

export async function loadMediaSource(ref: FileRef): Promise<MediaSource> {
  const [first] = await loadMediaSources(ref);
  if (!first) {
    throw new Error('no usable media source');
  }
  return first;
}

export async function loadMediaSources(ref: FileRef): Promise<MediaSource[]> {
  if (ref.kind !== 'image' && ref.kind !== 'svg' && ref.kind !== 'video' && ref.kind !== 'audio') {
    throw new Error(`unsupported media kind: ${ref.kind}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- window.platform is only available in the desktop shell.
  const platform = (window as any).platform;
  const connection = resolveServerConnection(useStore.getState());
  return resolveFileRefUrls(ref, { connection, platform, resourceContentUrl: codiaUrl })
    .map(source => ({ url: source.url }));
}
