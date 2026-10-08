import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../../stores';
import { isMediaKind } from '../../../utils/file-kind';
import { fileRefVersionToken } from '../../../services/resource-url';
import { ImageStage } from './ImageStage';
import { VideoStage } from './VideoStage';
import { AudioStage } from './AudioStage';
import { OcrPanel } from './OcrPanel';
import styles from './MediaViewer.module.css';

export function MediaViewer() {
  const state = useStore(s => s.mediaViewer);
  const closeMediaViewer = useStore(s => s.closeMediaViewer);
  const setMediaViewerCurrent = useStore(s => s.setMediaViewerCurrent);

  const containerRef = useRef<HTMLDivElement>(null);
  const [chromeVisible, setChromeVisible] = useState(true);
  const idleTimerRef = useRef<number | null>(null);
  const [viewport, setViewport] = useState({ width: 800, height: 600 });
  const [zoomCmd, setZoomCmd] = useState({ in: 0, out: 0, reset: 0 });
  const isOpen = !!state;

  useEffect(() => {
    if (!isOpen) return;
    const update = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [isOpen]);

  const kickIdleTimer = useCallback(() => {
    setChromeVisible(true);
    if (idleTimerRef.current) window.clearTimeout(idleTimerRef.current);
    idleTimerRef.current = window.setTimeout(() => setChromeVisible(false), 2500);
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    kickIdleTimer();
    const onMove = () => kickIdleTimer();
    window.addEventListener('mousemove', onMove);
    return () => {
      window.removeEventListener('mousemove', onMove);
      if (idleTimerRef.current) window.clearTimeout(idleTimerRef.current);
    };
  }, [isOpen, kickIdleTimer]);

  const currentIndex = useMemo(() => {
    if (!state) return -1;
    return state.files.findIndex(f => f.id === state.currentId);
  }, [state]);

  const canPrev = currentIndex > 0;
  const canNext = state ? currentIndex >= 0 && currentIndex < state.files.length - 1 : false;

  const goPrev = useCallback(() => {
    if (!state || !canPrev) return;
    setMediaViewerCurrent(state.files[currentIndex - 1].id);
  }, [state, canPrev, currentIndex, setMediaViewerCurrent]);

  const goNext = useCallback(() => {
    if (!state || !canNext) return;
    setMediaViewerCurrent(state.files[currentIndex + 1].id);
  }, [state, canNext, currentIndex, setMediaViewerCurrent]);

  useEffect(() => {
    if (!state) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === ' ' && document.activeElement instanceof HTMLVideoElement) return;
      switch (e.key) {
        case 'Escape':
          e.preventDefault();
          closeMediaViewer();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          goPrev();
          break;
        case 'ArrowRight':
          e.preventDefault();
          goNext();
          break;
        case '+':
        case '=':
          e.preventDefault();
          setZoomCmd(c => ({ ...c, in: c.in + 1 }));
          break;
        case '-':
          e.preventDefault();
          setZoomCmd(c => ({ ...c, out: c.out + 1 }));
          break;
        case '0':
          e.preventDefault();
          setZoomCmd(c => ({ ...c, reset: c.reset + 1 }));
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state, closeMediaViewer, goPrev, goNext]);

  useEffect(() => {
    if (!state) return;
    const current = state.files.find(f => f.id === state.currentId);
    if (!current || !isMediaKind(current.kind)) {
      closeMediaViewer();
    }
  }, [state, closeMediaViewer]);

  if (!state) return null;

  const current = state.files[currentIndex];
  if (!current || !isMediaKind(current.kind)) return null;

  const prev = canPrev ? state.files[currentIndex - 1] : undefined;
  const next = canNext ? state.files[currentIndex + 1] : undefined;
  const multi = state.files.length > 1;

  const handleSave = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (!current.path) return;
    if (window.platform?.saveFileAs) {
      window.platform.saveFileAs(current.path, current.name);
      return;
    }
    window.platform?.showInFinder?.(current.path);
  };

  const onOverlayClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) closeMediaViewer();
  };

  return (
    <div
      ref={containerRef}
      className={styles.overlay}
      role="dialog"
      aria-modal="true"
      aria-label="Media preview"
      data-testid="media-viewer-overlay"
      onClick={onOverlayClick}
    >
      <div className={`${styles.topbar} ${chromeVisible ? '' : styles.hidden}`}>
        {multi && (
          <span className={styles.index} data-testid="media-viewer-index">
            {currentIndex + 1} / {state.files.length}
          </span>
        )}
        {current.path && (
          <button
            type="button"
            className={styles.topbarBtn}
            data-testid="media-viewer-save"
            aria-label="Save"
            onClick={handleSave}
          >
            保存
          </button>
        )}
        {current.kind === 'image' && (
          <OcrPanel file={current} />
        )}
        <button
          type="button"
          className={styles.closeBtn}
          data-testid="media-viewer-close"
          aria-label="Close"
          onClick={(e) => {
            e.stopPropagation();
            closeMediaViewer();
          }}
        >
          ×
        </button>
      </div>

      {multi && (
        <>
          <button
            type="button"
            className={`${styles.navBtn} ${styles.navPrev}`}
            data-testid="media-viewer-prev"
            aria-label="Previous"
            disabled={!canPrev}
            onClick={(e) => {
              e.stopPropagation();
              goPrev();
            }}
          >
            ‹
          </button>
          <button
            type="button"
            className={`${styles.navBtn} ${styles.navNext}`}
            data-testid="media-viewer-next"
            aria-label="Next"
            disabled={!canNext}
            onClick={(e) => {
              e.stopPropagation();
              goNext();
            }}
          >
            ›
          </button>
        </>
      )}

      {current.kind === 'image' && (
        <div className={`${styles.zoomToolbar} ${chromeVisible ? '' : styles.hidden}`} aria-label="Image zoom tools">
          <button
            type="button"
            aria-label="Zoom out"
            onClick={(e) => {
              e.stopPropagation();
              setZoomCmd(c => ({ ...c, out: c.out + 1 }));
            }}
          >
            -
          </button>
          <button
            type="button"
            aria-label="Reset zoom"
            onClick={(e) => {
              e.stopPropagation();
              setZoomCmd(c => ({ ...c, reset: c.reset + 1 }));
            }}
          >
            100%
          </button>
          <button
            type="button"
            aria-label="Zoom in"
            onClick={(e) => {
              e.stopPropagation();
              setZoomCmd(c => ({ ...c, in: c.in + 1 }));
            }}
          >
            +
          </button>
        </div>
      )}

      <div
        className={styles.stageWrap}
        data-testid="media-viewer-stage-wrap"
        onClick={(e) => {
          if (e.target === e.currentTarget) closeMediaViewer();
        }}
      >
        {current.kind === 'audio' ? (
          <AudioStage file={current} key={current.id} />
        ) : current.kind === 'video' ? (
          <VideoStage file={current} viewport={viewport} />
        ) : (
          <ImageStage
            file={current}
            viewport={viewport}
            neighbors={{ prev, next }}
            zoomCmd={zoomCmd}
            key={`${current.id}:${fileRefVersionToken(current) || ''}`}
          />
        )}
      </div>

      <div
        className={`${styles.captionBar} ${chromeVisible ? '' : styles.hidden}`}
        data-testid="media-viewer-caption"
      >
        <span className={styles.name} data-testid="media-viewer-name">{current.name}</span>
      </div>
    </div>
  );
}
