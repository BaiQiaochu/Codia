/** Respect the browser/Electron GPU policy; never force software acceleration. */
export function getCodiaWebGLContext(canvas: HTMLCanvasElement): WebGL2RenderingContext {
  const gl = canvas.getContext('webgl2', {
    alpha: true, premultipliedAlpha: true, antialias: true, failIfMajorPerformanceCaveat: true,
  });
  if (!gl) throw new Error('WebGL 2 unavailable; using the static mascot');
  return gl;
}
