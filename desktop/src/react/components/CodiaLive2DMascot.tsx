import { useEffect, useRef, useState, type ReactNode } from 'react';
import { loadCodiaLive2D } from '../live2d/loader';
import type { CodiaLive2DAssets } from '../live2d/assets';
import type { CodiaLive2DHandle } from '../live2d/runtime';
import styles from './CodiaLive2DMascot.module.css';

interface Props {
  /** Local Cubism export used by the mascot. */
  assets?: CodiaLive2DAssets | null;
  enabled?: boolean;
  gpuSafeMode?: boolean;
  hardwareAccelerationEnabled?: boolean;
  /** Optional non-animated fallback for fixtures or non-welcome surfaces. */
  fallback?: ReactNode;
  className?: string;
}

export function CodiaLive2DMascot({
  assets, enabled = false, gpuSafeMode = false, hardwareAccelerationEnabled = true, fallback = null, className,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<'fallback' | 'loading' | 'live2d'>('fallback');
  const [error, setError] = useState('');
  const [restored, setRestored] = useState(0);
  const modelUrl = assets?.modelUrl;
  const shaderPath = assets?.shaderPath;

  useEffect(() => {
    const canvas = canvasRef.current;
    // Attempt the real model even when Electron is running in software-safe
    // mode. WebGL2 can still be available through WARP; the runtime itself
    // reports a load error when it is genuinely unavailable. Falling back here
    // based only on the startup policy was what kept the old sprite animation
    // visible on affected machines.
    if (!canvas || !enabled || !modelUrl || !shaderPath) {
      setState('fallback');
      return;
    }
    const controller = new AbortController();
    let handle: CodiaLive2DHandle | null = null;
    let active = true;
    let failed = false;
    let inView = true;
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const fail = (reason: unknown) => {
      if (!active || controller.signal.aborted) return;
      failed = true;
      setError(reason instanceof Error ? reason.message : String(reason));
      setState('fallback');
    };
    const visibility = () => handle?.setVisible(inView && !document.hidden);
    const motion = () => handle?.setReducedMotion(media.matches);
    const resize = new ResizeObserver(() => handle?.resize());
    const intersection = new IntersectionObserver(([entry]) => { inView = entry.isIntersecting; visibility(); });
    const contextLost = (event: Event) => {
      event.preventDefault();
      fail(new Error('WebGL context lost'));
      controller.abort();
      handle?.dispose();
      handle = null;
    };
    const contextRestored = () => { if (active) setRestored(value => value + 1); };
    canvas.addEventListener('webglcontextlost', contextLost);
    canvas.addEventListener('webglcontextrestored', contextRestored);
    resize.observe(canvas);
    intersection.observe(canvas);
    media.addEventListener('change', motion);
    document.addEventListener('visibilitychange', visibility);
    setError('');
    setState('loading');
    void loadCodiaLive2D(canvas, {
      modelUrl, shaderPath, signal: controller.signal, reducedMotion: media.matches, onError: fail,
    }).then(loaded => {
      if (!active || controller.signal.aborted || failed) { loaded.dispose(); return; }
      handle = loaded;
      motion();
      if (!failed) visibility();
      if (failed) { loaded.dispose(); handle = null; return; }
      setState('live2d');
    }).catch(fail);
    return () => {
      active = false;
      controller.abort();
      handle?.dispose();
      resize.disconnect();
      intersection.disconnect();
      media.removeEventListener('change', motion);
      document.removeEventListener('visibilitychange', visibility);
      canvas.removeEventListener('webglcontextlost', contextLost);
      canvas.removeEventListener('webglcontextrestored', contextRestored);
    };
  }, [enabled, modelUrl, shaderPath, gpuSafeMode, hardwareAccelerationEnabled, restored]);

  return (
    <div className={`${styles.mascot}${className ? ` ${className}` : ''}`} data-codia-renderer={state} data-codia-load-error={error || undefined}>
      <div className={styles.fallback} aria-hidden={state === 'live2d'} hidden={state === 'live2d'}>{fallback}</div>
      <canvas ref={canvasRef} className={styles.canvas} style={{ visibility: state === 'live2d' ? 'visible' : 'hidden' }}
        role="img" aria-label="Codia 吉祥物" aria-hidden={state !== 'live2d'} />
    </div>
  );
}
