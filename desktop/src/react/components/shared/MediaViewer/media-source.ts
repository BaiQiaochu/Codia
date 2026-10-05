import type { FileRef } from '../../../types/file-ref';
import { useStore } from '../../../stores';
import { resolveServerConnection } from '../../../services/server-connection';
import { resolveFileRefUrl } from '../../../services/resource-url';
import { gsapUrl } from '../../../hooks/use-gsap-fetch';

export interface MediaSource {
  url: string;
  cleanup?: () => void;
}

export async function loadMediaSource(ref: FileRef): Promise<MediaSource> {
  if (ref.kind !== 'image' && ref.kind !== 'svg' && ref.kind !== 'video' && ref.kind !== 'audio') {
    throw new Error(`unsupported media kind: ${ref.kind}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- window.platform is only available in the desktop shell.
  const platform = (window as any).platform;
  const connection = resolveServerConnection(useStore.getState());
  const source = resolveFileRefUrl(ref, { connection, platform, resourceContentUrl: gsapUrl });
  return { url: source.url };
}
