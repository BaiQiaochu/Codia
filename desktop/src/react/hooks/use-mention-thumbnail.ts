import { useEffect, useState } from 'react';
import { gsapFetch } from './use-gsap-fetch';

/** Desktop file URLs and authenticated browser previews share the same badge UI. */
export function useMentionThumbnail(path: string | null, mimeType?: string): string | null {
  const directUrl = path ? window.platform?.getFileUrl?.(path) || null : null;
  const [preview, setPreview] = useState<{ path: string; url: string } | null>(null);

  useEffect(() => {
    if (!path || directUrl) return;
    const controller = new AbortController();
    void gsapFetch(`/api/fs/read-base64?path=${encodeURIComponent(path)}`, { signal: controller.signal })
      .then(response => response.text())
      .then(base64 => {
        if (!base64 || controller.signal.aborted) return;
        const mime = mimeType?.startsWith('image/') ? mimeType : /\.svg$/i.test(path) ? 'image/svg+xml' : 'image/png';
        setPreview({ path, url: `data:${mime};base64,${base64}` });
      })
      .catch(() => { /* Unavailable files keep their ordinary file icon. */ });
    return () => controller.abort();
  }, [path, directUrl, mimeType]);

  return directUrl || (preview?.path === path ? preview.url : null);
}
