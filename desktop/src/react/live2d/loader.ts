import coreUrl from '../../assets/codia/live2d/core/live2dcubismcore.js?url';
import type { CodiaLive2DHandle, CodiaLive2DOptions } from './runtime';

type Core = { Version: { csmGetVersion(): number } };
type CoreWindow = Window & { Live2DCubismCore?: Core };
let corePromise: Promise<void> | null = null;

function loadCore(): Promise<void> {
  if (corePromise) return corePromise;
  corePromise = new Promise<void>((resolve, reject) => {
    const existing = (window as CoreWindow).Live2DCubismCore;
    if (existing) { resolve(); return; }
    const script = document.createElement('script');
    script.src = coreUrl;
    script.async = true;
    const timer = setTimeout(() => finish(new Error('Cubism Core loading timed out')), 15_000);
    function finish(error?: Error) {
      clearTimeout(timer);
      script.onload = script.onerror = null;
      if (error) { script.remove(); reject(error); } else resolve();
    }
    script.onload = () => finish((window as CoreWindow).Live2DCubismCore ? undefined : new Error('Cubism Core is unavailable'));
    script.onerror = () => finish(new Error('Cubism Core could not be loaded'));
    document.head.append(script);
  }).catch(error => { corePromise = null; throw error; });
  return corePromise;
}

export async function loadCodiaLive2D(canvas: HTMLCanvasElement, options: CodiaLive2DOptions): Promise<CodiaLive2DHandle> {
  options.signal.throwIfAborted();
  await loadCore();
  options.signal.throwIfAborted();
  // Framework reads the Core global at initialization, so its chunk loads second.
  const runtime = await import('./runtime');
  options.signal.throwIfAborted();
  return runtime.createCodiaLive2D(canvas, options);
}
