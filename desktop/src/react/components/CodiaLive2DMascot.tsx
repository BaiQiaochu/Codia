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
  /** @deprecated Static fallback is no longer rendered; retained for caller compatibility. */
  fallback?: ReactNode;
  className?: string;
}

export function CodiaLive2DMascot({
  assets, enabled = false, gpuSafeMode = false, hardwareAccelerationEnabled = true, className,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<'disabled' | 'loading' | 'live2d' | 'error'>('disabled');
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const modelUrl = assets?.modelUrl;
  const shaderPath = assets?.shaderPath;

  useEffect(() => {
    const canvas = canvasRef.current;
    // Respect Electron's existing graphics setup. Software WebGL2 may still be
    // available in safe mode; the runtime reports failed initialization.
    if (!canvas || !enabled) {
      setState('disabled');
      setError('');
      return;
    }
    if (!modelUrl || !shaderPath) {
      setState('error');
      setError('Live2D 模型资源未配置');
      return;
    }
    const controller = new AbortController();
    let handle: CodiaLive2DHandle | null = null;
    let active = true;
    let failed = false;
    let inView = true;
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const disposeHandle = () => {
      const current = handle;
      handle = null;
      current?.dispose();
    };
    const fail = (reason: unknown) => {
      if (!active || failed || controller.signal.aborted) return;
      failed = true;
      setError((reason instanceof Error ? reason.message : String(reason)) || '未知错误');
      setState('error');
      controller.abort();
      disposeHandle();
    };
    const visibility = () => handle?.setVisible(inView && !document.hidden);
    const motion = () => handle?.setReducedMotion(media.matches);
    const resize = new ResizeObserver(() => handle?.resize());
    const intersection = new IntersectionObserver(([entry]) => { inView = entry.isIntersecting; visibility(); });
    const contextLost = (event: Event) => {
      event.preventDefault();
      fail(new Error('WebGL context lost'));
    };
    const contextRestored = () => { if (active) setAttempt(value => value + 1); };
    canvas.addEventListener('webglcontextlost', contextLost);
    canvas.addEventListener('webglcontextrestored', contextRestored);
    resize.observe(canvas);
    intersection.observe(canvas);
    media.addEventListener('change', motion);
    document.addEventListener('visibilitychange', visibility);
    setError('');
    setState('loading');
    void (async () => {
      try {
        const loaded = await loadCodiaLive2D(canvas, {
          modelUrl, shaderPath, signal: controller.signal, reducedMotion: media.matches, onError: fail,
        });
        if (!active || controller.signal.aborted || failed) { loaded.dispose(); return; }
        handle = loaded;
        motion();
        if (!failed) visibility();
        if (!failed) setState('live2d');
      } catch (reason) { fail(reason); }
    })();
    return () => {
      active = false;
      controller.abort();
      disposeHandle();
      resize.disconnect();
      intersection.disconnect();
      media.removeEventListener('change', motion);
      document.removeEventListener('visibilitychange', visibility);
      canvas.removeEventListener('webglcontextlost', contextLost);
      canvas.removeEventListener('webglcontextrestored', contextRestored);
    };
  }, [enabled, modelUrl, shaderPath, gpuSafeMode, hardwareAccelerationEnabled, attempt]);

  return (
    <div className={`${styles.mascot}${className ? ` ${className}` : ''}`} data-codia-renderer={state} data-codia-load-error={error || undefined}>
      <canvas key={attempt} ref={canvasRef} className={styles.canvas} style={{ visibility: state === 'live2d' ? 'visible' : 'hidden' }}
        role="img" aria-label="Codia 吉祥物" aria-hidden={state !== 'live2d'} />
      {state !== 'live2d' && <span className={styles.status} role={state === 'error' ? 'alert' : 'status'}>
        {error ? `Live2D 加载或渲染失败：${error}` : state === 'loading' ? '正在加载 Live2D…' : 'Live2D 未启用'}
      </span>}
      {state === 'error' && <button className={styles.retry} type="button" onClick={() => setAttempt(value => value + 1)}>重试 Live2D</button>}
    </div>
  );
}
