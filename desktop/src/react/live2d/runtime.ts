import {
  CubismFramework, LogLevel, Option, CubismModelSettingJson, CubismUserModel,
  CubismMatrix44, CubismShaderManager_WebGL, CubismWebGLOffscreenManager,
} from '../../assets/codia/live2d/framework.js';
import { resolveModelAsset, validateModelManifest, type CodiaLive2DAssets } from './assets';
import { CODIA_LOOP_SECONDS, CODIA_PARAMETER_IDS, sampleCodiaTimeline } from './timeline';

export interface CodiaLive2DOptions extends CodiaLive2DAssets {
  signal: AbortSignal;
  reducedMotion: boolean;
  onError(error: Error): void;
}
export interface CodiaLive2DHandle {
  resize(): void;
  setVisible(visible: boolean): void;
  setReducedMotion(reduced: boolean): void;
  dispose(): void;
}
let frameworkUsers = 0;
function retainFramework(): () => void {
  if (!CubismFramework.isStarted()) {
    const options = new Option();
    options.loggingLevel = LogLevel.LogLevel_Warning;
    options.logFunction = message => console.info('[Codia Live2D]', message);
    if (!CubismFramework.startUp(options)) throw new Error('Cubism Core initialization failed');
  }
  if (!CubismFramework.isInitialized()) CubismFramework.initialize();
  frameworkUsers++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--frameworkUsers !== 0) return;
    CubismFramework.dispose();
    // Core registers a WASM callback during startUp. Keep that one registration
    // for the page lifetime: cleanUp + startUp allocates another function-table
    // slot in Core 6.0.1. dispose + initialize still releases/recreates resources.
  };
}
async function fetchBuffer(url: string, signal: AbortSignal): Promise<ArrayBuffer> {
  const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]), cache: 'no-cache' });
  if (!response.ok) throw new Error(`Live2D asset HTTP ${response.status}`);
  return response.arrayBuffer();
}

export async function createCodiaLive2D(canvas: HTMLCanvasElement, options: CodiaLive2DOptions): Promise<CodiaLive2DHandle> {
  const { signal } = options;
  signal.throwIfAborted();
  // Safe/software renderers may reject this request. Do not retry WebGL 1 or
  // override Electron's GPU recovery policy: 5.3 offscreen groups require WebGL 2.
  const gl = canvas.getContext('webgl2', {
    alpha: true, premultipliedAlpha: true, antialias: true, failIfMajorPerformanceCaveat: true,
  });
  if (!gl) throw new Error('WebGL 2 unavailable; using the mascot fallback');
  const releaseFramework = retainFramework();
  let userModel: CubismUserModel | null = null;
  let setting: CubismModelSettingJson | null = null;
  let registeredContext = false;
  const textures: WebGLTexture[] = [];
  const parameters = new Map<string, number>();
  let frame = 0;
  let resizeFrame = 0;
  let clock = 0;
  let previous = 0;
  let visible = true;
  let reduced = options.reducedMotion;
  let disposed = false;

  function dispose() {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(frame);
    cancelAnimationFrame(resizeFrame);
    signal.removeEventListener('abort', dispose);
    userModel?.release();
    userModel = null;
    setting?.release();
    setting = null;
    textures.forEach(texture => gl!.deleteTexture(texture));
    if (registeredContext) {
      CubismShaderManager_WebGL.getInstance().releaseGlContext(gl!);
      // Renderer.release destroys its offscreen FBOs but 5-r.5's context pool
      // still retains their containers. Evict this context before it is reused.
      CubismWebGLOffscreenManager.getInstance().removeContext(gl!);
    }
    releaseFramework();
    if (!gl!.isContextLost()) { gl!.clearColor(0, 0, 0, 0); gl!.clear(gl!.COLOR_BUFFER_BIT); }
  }
  function fail(error: unknown) {
    dispose();
    if (!signal.aborted) options.onError(error instanceof Error ? error : new Error(String(error)));
  }
  function draw() {
    if (disposed || !userModel || gl!.isContextLost()) return;
    const model = userModel.getModel();
    model.loadParameters();
    for (const [id, value] of Object.entries(sampleCodiaTimeline(clock, reduced))) {
      const index = parameters.get(id);
      if (index !== undefined) model.setParameterValueByIndex(index, value);
    }
    model.update();
    gl!.viewport(0, 0, canvas.width, canvas.height);
    gl!.clearColor(0, 0, 0, 0);
    gl!.clear(gl!.COLOR_BUFFER_BIT | gl!.DEPTH_BUFFER_BIT);
    const matrix = new CubismMatrix44();
    matrix.multiplyByMatrix(userModel.getModelMatrix());
    const renderer = userModel.getRenderer();
    renderer.setMvpMatrix(matrix);
    renderer.setRenderState(null, [0, 0, canvas.width, canvas.height]);
    const offscreen = CubismWebGLOffscreenManager.getInstance();
    offscreen.beginFrameProcess(gl!);
    try { renderer.drawModel(options.shaderPath); }
    finally { offscreen.endFrameProcess(gl!); }
    if (gl!.getError() !== gl!.NO_ERROR) throw new Error('Cubism drawing failed');
  }
  function resize() {
    if (disposed) return;
    const bounds = canvas.getBoundingClientRect();
    const size = Math.max(1, Math.round(Math.min(bounds.width, bounds.height) * Math.min(window.devicePixelRatio || 1, 2)));
    if (canvas.width !== size || canvas.height !== size) {
      canvas.width = canvas.height = size;
      userModel?.setRenderTargetSize(size, size);
      // Cubism offscreen groups recreate their buffers at the new size. Settle
      // that target on a second frame even while holding a reduced-motion pose.
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = 0;
        if (!disposed && visible) { try { draw(); } catch (error) { fail(error); } }
      });
    }
    if (visible) { try { draw(); } catch (error) { fail(error); } }
  }
  function updatePlayback() {
    cancelAnimationFrame(frame);
    frame = previous = 0;
    if (disposed || !visible) return;
    try { draw(); } catch (error) { fail(error); return; }
    if (reduced) return;
    const tick = (now: number) => {
      if (disposed || !visible) return;
      if (previous) clock = (clock + Math.min((now - previous) / 1000, .1)) % CODIA_LOOP_SECONDS;
      previous = now;
      try { draw(); } catch (error) { fail(error); return; }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
  }
  signal.addEventListener('abort', dispose, { once: true });
  try {
    const json = await fetchBuffer(options.modelUrl, signal);
    signal.throwIfAborted();
    const manifest = validateModelManifest(JSON.parse(new TextDecoder().decode(json)));
    const mocUrl = resolveModelAsset(manifest.moc, options.modelUrl);
    const textureUrls = manifest.textures.map(reference => resolveModelAsset(reference, options.modelUrl));
    setting = new CubismModelSettingJson(json, json.byteLength);
    const moc = await fetchBuffer(mocUrl, signal);
    signal.throwIfAborted();
    userModel = new CubismUserModel();
    userModel.loadModel(moc, true);
    const model = userModel.getModel();
    if (!model) throw new Error('Cubism rejected the exported .moc3');
    for (let index = 0; index < model.getParameterCount(); index++) parameters.set(model.getParameterId(index).getString(), index);
    const missing = CODIA_PARAMETER_IDS.filter(id => !parameters.has(id));
    if (missing.length) throw new Error(`Codia model is missing parameters: ${missing.join(', ')}`);
    model.saveParameters();
    const layout = new Map<string, number>();
    setting.getLayoutMap(layout);
    userModel.getModelMatrix().setupFromLayout(layout);
    userModel.createRenderer(canvas.width, canvas.height);
    const renderer = userModel.getRenderer();
    renderer.startUp(gl);
    registeredContext = true;
    renderer.setIsPremultipliedAlpha(true);
    for (let index = 0; index < textureUrls.length; index++) {
      const buffer = await fetchBuffer(textureUrls[index], signal);
      signal.throwIfAborted();
      const image = await createImageBitmap(new Blob([buffer]), { premultiplyAlpha: 'premultiply' });
      try {
        signal.throwIfAborted();
        const texture = gl.createTexture();
        if (!texture) throw new Error('Could not create a Live2D texture');
        textures.push(texture);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
        // Match the Cubism sample when reducing the atlas to a small mascot.
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.bindTexture(gl.TEXTURE_2D, null);
        renderer.bindTexture(index, texture);
      } finally { image.close(); }
    }
    renderer.loadShaders(options.shaderPath);
    const shader = CubismShaderManager_WebGL.getInstance().getShader(gl);
    const deadline = performance.now() + 15_000;
    while (!shader._isShaderLoaded) {
      signal.throwIfAborted();
      if (shader.codiaLoadError) throw shader.codiaLoadError;
      if (performance.now() > deadline) throw new Error('Cubism shaders loading timed out');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    signal.throwIfAborted();
    setting.release();
    setting = null;
    resize();
    if (disposed) throw new Error('Live2D initialization did not produce a frame');
    updatePlayback();
    if (disposed) throw new Error('Live2D initialization did not produce a frame');
    return {
      resize, dispose,
      setVisible(value) { visible = value; updatePlayback(); },
      setReducedMotion(value) { reduced = value; updatePlayback(); },
    };
  } catch (error) { dispose(); throw error; }
}
