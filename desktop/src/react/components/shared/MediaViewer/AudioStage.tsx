import { useEffect, useState } from 'react';
import type { FileRef } from '../../../types/file-ref';
import { loadMediaSource } from './media-source';
import styles from './MediaViewer.module.css';

interface Props {
  file: FileRef;
  onReady?: () => void;
  onError?: (e: unknown) => void;
}

export function AudioStage({ file, onReady, onError }: Props) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSrc(null);
    loadMediaSource(file)
      .then((s) => { if (!cancelled) setSrc(s.url); })
      .catch((err) => { if (!cancelled) onError?.(err); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.id]);

  return (
    <div className={styles.audioWrap}>
      {!src && <div className={styles.spinner} data-testid="audio-stage-spinner" />}
      {src && (
        <audio
          src={src}
          controls
          autoPlay={false}
          onLoadedData={onReady}
          className={styles.audioEl}
          data-testid="audio-stage-audio"
        />
      )}
    </div>
  );
}
