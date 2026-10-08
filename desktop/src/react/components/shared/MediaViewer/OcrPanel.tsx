import { useEffect, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import type { FileRef } from '../../../types/file-ref';
import { recognizeImageWithOfflineOcr } from './offline-ocr';
import styles from './MediaViewer.module.css';

interface Props {
  file: FileRef;
}

export const OCR_PANEL_TIMEOUT_MS = 60_000;

function withOcrPanelTimeout<T>(promise: Promise<T>): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error('OCR 识别超时，请确认本地 OCR 资源已加载后重试。'));
    }, OCR_PANEL_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId);
  });
}

export function OcrPanel({ file }: Props) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [text, setText] = useState('');
  const requestIdRef = useRef(0);

  useEffect(() => {
    requestIdRef.current += 1;
    setOpen(false);
    setStatus('idle');
    setText('');
  }, [file.id]);

  useEffect(() => () => {
    requestIdRef.current += 1;
  }, []);

  const cancelOcr = (event?: MouseEvent<HTMLButtonElement>) => {
    event?.stopPropagation();
    requestIdRef.current += 1;
    setOpen(false);
    setStatus('idle');
    setText('');
  };

  const runOcr = async (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (status === 'running') return;
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setOpen(true);
    setStatus('running');
    setText('');
    try {
      const result = await withOcrPanelTimeout(recognizeImageWithOfflineOcr(file));
      if (requestIdRef.current !== requestId) return;
      setText(result || '未识别到文本');
      setStatus('done');
    } catch (err) {
      if (requestIdRef.current !== requestId) return;
      const message = err instanceof Error ? err.message : String(err);
      setText(message || 'OCR 识别失败');
      setStatus('error');
    }
  };

  return (
    <>
      <button
        type="button"
        className={styles.topbarBtn}
        data-testid="media-viewer-ocr"
        aria-label="OCR"
        onClick={runOcr}
        disabled={status === 'running'}
      >
        OCR
      </button>
      {open && (
        <aside
          className={styles.ocrPanel}
          data-testid="media-viewer-ocr-panel"
          onClick={(event) => event.stopPropagation()}
        >
          <div className={styles.ocrPanelHeader}>
            <span>OCR</span>
            <button
              type="button"
              className={styles.ocrPanelClose}
              aria-label="关闭 OCR"
              onClick={cancelOcr}
            >
              ×
            </button>
          </div>
          <pre
            className={`${styles.ocrResult} ${status === 'error' ? styles.ocrError : ''}`}
            data-testid="media-viewer-ocr-result"
          >
            {status === 'running' ? '正在识别...' : text}
          </pre>
        </aside>
      )}
    </>
  );
}
