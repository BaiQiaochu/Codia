import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';
import { ArtifactEditor } from './react/components/PreviewEditor';
import { retainViewerLocalFileResourceWatch } from './viewer-resource-events';

type ViewerMode = 'markdown' | 'code' | 'csv';

interface ViewerLoadPayload {
  filePath: string;
  title: string;
  type: string;
  language?: string | null;
  windowId: number;
}

interface ViewerPlatform {
  getServerPort?(): Promise<string | number | null | undefined>;
  getServerToken?(): Promise<string | null | undefined>;
  readFile(path: string): Promise<string | null>;
  onViewerLoad?(callback: (data: ViewerLoadPayload) => void): void;
  viewerClose?(): void;
}

function typeToMode(type: string): ViewerMode {
  if (type === 'markdown') return 'markdown';
  if (type === 'csv') return 'csv';
  return 'code';
}

function getPlatform(): ViewerPlatform | null {
  return (window as unknown as { platform?: ViewerPlatform }).platform ?? null;
}

function fileUnavailableError(payload: ViewerLoadPayload): Error {
  return new Error(`File is no longer available: ${payload.title || payload.filePath}`);
}

function ViewerApp() {
  const [payload, setPayload] = useState<ViewerLoadPayload | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    const platform = getPlatform();
    if (!platform?.onViewerLoad) return;
    platform.onViewerLoad((data) => {
      setPayload(data);
      setContent(null);
      setLoadError(null);
      document.title = data.title || 'Viewer';
    });
  }, []);

  useEffect(() => {
    if (!payload?.filePath) return;
    const platform = getPlatform();
    if (!platform) return;

    let cancelled = false;

    const fail = (err: unknown) => {
      if (cancelled) return;
      const message = err instanceof Error ? err.message : String(err);
      console.error('[viewer] live file load failed:', err);
      setLoadError(message);
    };

    const loadFile = () => {
      platform.readFile(payload.filePath)
        .then((value) => {
          if (cancelled) return;
          if (value == null) {
            fail(fileUnavailableError(payload));
            return;
          }
          setLoadError(null);
          setContent(value);
        })
        .catch(fail);
    };

    loadFile();
    const watch = retainViewerLocalFileResourceWatch(payload.filePath, platform, {
      onChanged: loadFile,
    });
    watch.ready.catch((err) => {
      if (cancelled) return;
      console.warn('[viewer] ResourceIO live reload unavailable:', err);
    });

    return () => {
      cancelled = true;
      watch.release();
    };
  }, [payload?.filePath]);

  const handleClose = () => getPlatform()?.viewerClose?.();

  if (!payload) {
    return (
      <div style={{ padding: 20, color: 'var(--text-muted)', fontSize: 13 }}>
        Loading...
      </div>
    );
  }

  if (loadError) {
    return (
      <div style={{ padding: 20, color: 'var(--text-muted)', fontSize: 13 }}>
        Failed to load file: {loadError}
      </div>
    );
  }

  const mode = typeToMode(payload.type);

  return (
    <>
      <div className="viewer-toolbar">
        <div className="viewer-title">{payload.title}</div>
        <button className="viewer-close-btn" onClick={handleClose} title="Close">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
      <div className="viewer-body">
        {content != null && (
          <ArtifactEditor
            content={content}
            filePath={payload.filePath}
            mode={mode}
            language={payload.language}
            readOnly
          />
        )}
      </div>
      <div className="viewer-readonly-badge">只读 - live</div>
    </>
  );
}

const rootEl = document.getElementById('react-root');
if (rootEl) {
  createRoot(rootEl).render(<ViewerApp />);
}
