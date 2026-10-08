// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCodiaLive2D } from '../runtime';
import { CODIA_PARAMETER_IDS } from '../timeline';

const sdk = vi.hoisted(() => ({
  start: vi.fn(() => true), initialize: vi.fn(), dispose: vi.fn(), cleanup: vi.fn(),
  started: false, initialized: false,
  releaseContext: vi.fn(), update: vi.fn(), loadParameters: vi.fn(), saveParameters: vi.fn(),
  removeOffscreenContext: vi.fn(),
  beginOffscreenFrame: vi.fn(), endOffscreenFrame: vi.fn(),
  offscreenContexts: new Map<unknown, { deleted: boolean }>(),
  setParameter: vi.fn(), modelRelease: vi.fn(), render: vi.fn(), target: vi.fn(),
  ids: [] as string[],
}));
vi.mock('../../../assets/codia/live2d/framework.js', () => ({
  Option: class {}, LogLevel: { LogLevel_Warning: 2 },
  CubismFramework: {
    isStarted: () => sdk.started, isInitialized: () => sdk.initialized,
    startUp: sdk.start, initialize: sdk.initialize, dispose: sdk.dispose, cleanUp: sdk.cleanup,
  },
  CubismMatrix44: class { multiplyByMatrix() {} },
  CubismModelSettingJson: class { getLayoutMap() {} release() {} },
  CubismUserModel: class {
    context: unknown = null;
    loadModel() {} createRenderer() {}
    release() {
      sdk.modelRelease();
      // Mirrors the SDK: the renderer deletes the FBO without evicting the pool.
      const target = sdk.offscreenContexts.get(this.context);
      if (target) target.deleted = true;
    }
    setRenderTargetSize = sdk.target;
    getModelMatrix() { return { setupFromLayout() {} }; }
    getModel() { return {
      getParameterCount: () => sdk.ids.length,
      getParameterId: (index: number) => ({ getString: () => sdk.ids[index] }),
      saveParameters: sdk.saveParameters, loadParameters: sdk.loadParameters,
      setParameterValueByIndex: sdk.setParameter, update: sdk.update,
    }; }
    getRenderer() { return {
      startUp: (gl: unknown) => { this.context = gl; },
      setIsPremultipliedAlpha() {}, bindTexture() {}, loadShaders() {},
      setMvpMatrix() {}, setRenderState() {},
      drawModel: (path: string) => {
        if (!sdk.offscreenContexts.has(this.context)) sdk.offscreenContexts.set(this.context, { deleted: false });
        if (sdk.offscreenContexts.get(this.context)!.deleted) throw new Error('Deleted framebuffer reused');
        sdk.render(path);
      },
    }; }
  },
  CubismShaderManager_WebGL: { getInstance: () => ({
    getShader: () => ({ _isShaderLoaded: true, codiaLoadError: null }), releaseGlContext: sdk.releaseContext,
  }) },
  CubismWebGLOffscreenManager: { getInstance: () => ({
    removeContext: sdk.removeOffscreenContext,
    beginFrameProcess: sdk.beginOffscreenFrame, endFrameProcess: sdk.endOffscreenFrame,
  }) },
}));
let gl: Record<string, unknown>;
let canvas: HTMLCanvasElement;
let bitmapClose: ReturnType<typeof vi.fn<() => void>>;
let frames: Map<number, FrameRequestCallback>;
const assets = {
  modelUrl: 'http://127.0.0.1:5000/desktop/assets/codia/live2d/model/Codia.model3.json',
  shaderPath: 'http://127.0.0.1:5000/desktop/assets/codia/live2d/shaders/',
};
beforeEach(() => {
  vi.clearAllMocks();
  sdk.started = sdk.initialized = false;
  sdk.start.mockImplementation(() => { sdk.started = true; return true; });
  sdk.initialize.mockImplementation(() => { sdk.initialized = true; });
  sdk.dispose.mockImplementation(() => { sdk.initialized = false; });
  sdk.cleanup.mockImplementation(() => { sdk.started = sdk.initialized = false; });
  sdk.render.mockReset();
  sdk.offscreenContexts.clear();
  sdk.removeOffscreenContext.mockImplementation(context => { sdk.offscreenContexts.delete(context); });
  sdk.ids = [...CODIA_PARAMETER_IDS];
  gl = Object.fromEntries(['bindTexture', 'texParameteri', 'texImage2D', 'generateMipmap', 'deleteTexture', 'clearColor', 'clear', 'viewport'].map(key => [key, vi.fn()]));
  Object.assign(gl, { TEXTURE_2D: 0x0DE1, TEXTURE_MIN_FILTER: 0x2801, TEXTURE_MAG_FILTER: 0x2800, LINEAR: 0x2601, LINEAR_MIPMAP_LINEAR: 0x2703 });
  Object.assign(gl, { createTexture: vi.fn(() => ({})), isContextLost: () => false, getError: () => 0, NO_ERROR: 0 });
  canvas = document.createElement('canvas');
  vi.spyOn(canvas, 'getContext').mockReturnValue(gl as unknown as WebGL2RenderingContext);
  vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ width: 180, height: 180 } as DOMRect);
  frames = new Map();
  let next = 1;
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => { frames.set(next, callback); return next++; }));
  vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => frames.delete(id)));
  bitmapClose = vi.fn<() => void>();
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ close: bitmapClose })));
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
    ok: true,
    arrayBuffer: async () => url.endsWith('.model3.json')
      ? new TextEncoder().encode(JSON.stringify({ Version: 3, FileReferences: { Moc: 'Codia.moc3', Textures: ['atlas.png'] } })).buffer
      : new ArrayBuffer(8),
  })));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('Codia Cubism runtime resource lifetime', () => {
  it('uploads premultiplied textures and generates mipmaps before drawing the small mascot', async () => {
    const handle = await createCodiaLive2D(canvas, { ...assets, signal: new AbortController().signal, reducedMotion: true, onError: vi.fn() });
    expect(createImageBitmap).toHaveBeenCalledWith(expect.any(Blob), { premultiplyAlpha: 'premultiply' });
    expect(gl.texParameteri).toHaveBeenCalledWith(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    expect(gl.texParameteri).toHaveBeenCalledWith(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    expect(gl.generateMipmap).toHaveBeenCalledExactlyOnceWith(gl.TEXTURE_2D);
    const upload = vi.mocked(gl.texImage2D as (...args: unknown[]) => void);
    const mipmaps = vi.mocked(gl.generateMipmap as (...args: unknown[]) => void);
    expect(upload.mock.invocationCallOrder[0]).toBeLessThan(mipmaps.mock.invocationCallOrder[0]);
    expect(mipmaps.mock.invocationCallOrder[0]).toBeLessThan(sdk.render.mock.invocationCallOrder[0]);
    handle.dispose();
  });
  it('updates geometry after resize and settles offscreen targets while reduced motion is still static', async () => {
    const controller = new AbortController();
    const handle = await createCodiaLive2D(canvas, { ...assets, signal: controller.signal, reducedMotion: true, onError: vi.fn() });
    expect(canvas.getContext).toHaveBeenCalledWith('webgl2', expect.objectContaining({ failIfMajorPerformanceCaveat: true }));
    expect(sdk.target).toHaveBeenCalledWith(180, 180);
    expect(sdk.update).toHaveBeenCalled();
    expect(sdk.render).toHaveBeenCalledWith(assets.shaderPath);
    expect(sdk.beginOffscreenFrame).toHaveBeenCalledWith(gl);
    expect(sdk.endOffscreenFrame).toHaveBeenCalledTimes(sdk.render.mock.calls.length);
    expect(frames.size).toBe(1); // one settle frame, no animation loop
    const pending = [...frames.values()][0];
    frames.clear();
    const before = sdk.render.mock.calls.length;
    pending(16);
    expect(sdk.render).toHaveBeenCalledTimes(before + 1);
    expect(frames.size).toBe(0);
    handle.dispose();
    handle.dispose();
    expect(sdk.modelRelease).toHaveBeenCalledOnce();
    expect(sdk.releaseContext).toHaveBeenCalledOnce();
    expect(sdk.removeOffscreenContext).toHaveBeenCalledExactlyOnceWith(gl);
    expect(sdk.modelRelease.mock.invocationCallOrder[0]).toBeLessThan(sdk.releaseContext.mock.invocationCallOrder[0]);
    expect(sdk.releaseContext.mock.invocationCallOrder[0]).toBeLessThan(sdk.removeOffscreenContext.mock.invocationCallOrder[0]);
    expect(sdk.dispose).toHaveBeenCalledOnce();
    expect(gl.deleteTexture).toHaveBeenCalledOnce();
    expect(bitmapClose).toHaveBeenCalledOnce();
  });
  it('recreates the offscreen container when the same canvas/context is enabled again', async () => {
    const options = { ...assets, signal: new AbortController().signal, reducedMotion: true, onError: vi.fn() };
    const first = await createCodiaLive2D(canvas, options);
    const oldTarget = sdk.offscreenContexts.get(gl)!;
    expect(oldTarget.deleted).toBe(false);
    first.dispose();
    expect(oldTarget.deleted).toBe(true);
    expect(sdk.offscreenContexts.has(gl)).toBe(false);
    const second = await createCodiaLive2D(canvas, options);
    expect(sdk.offscreenContexts.get(gl)).not.toBe(oldTarget);
    expect(sdk.offscreenContexts.get(gl)?.deleted).toBe(false);
    expect(options.onError).not.toHaveBeenCalled();
    second.dispose();
    expect(sdk.removeOffscreenContext).toHaveBeenCalledTimes(2);
  });
  it('keeps one Core startup across five dispose/reinitialize cycles on the same page', async () => {
    const options = { ...assets, signal: new AbortController().signal, reducedMotion: true, onError: vi.fn() };
    sdk.start.mockImplementation(() => {
      if (sdk.start.mock.calls.length > 1) throw 'Unable to grow wasm table';
      sdk.started = true;
      return true;
    });
    for (let cycle = 0; cycle < 5; cycle++) {
      const handle = await createCodiaLive2D(canvas, options);
      expect(sdk.offscreenContexts.get(gl)?.deleted).toBe(false);
      handle.dispose();
      expect(sdk.offscreenContexts.size).toBe(0);
    }
    expect(sdk.start).toHaveBeenCalledOnce();
    expect(sdk.initialize).toHaveBeenCalledTimes(5);
    expect(sdk.dispose).toHaveBeenCalledTimes(5);
    expect(sdk.cleanup).not.toHaveBeenCalled();
    expect(options.onError).not.toHaveBeenCalled();
  });
  it('removes only the disposed context while another mascot keeps its offscreen target', async () => {
    const options = { ...assets, signal: new AbortController().signal, reducedMotion: true, onError: vi.fn() };
    const peerCanvas = document.createElement('canvas');
    const peerGl = { ...gl };
    vi.spyOn(peerCanvas, 'getContext').mockReturnValue(peerGl as unknown as WebGL2RenderingContext);
    vi.spyOn(peerCanvas, 'getBoundingClientRect').mockReturnValue({ width: 180, height: 180 } as DOMRect);
    const first = await createCodiaLive2D(canvas, options);
    const peer = await createCodiaLive2D(peerCanvas, options);
    const peerTarget = sdk.offscreenContexts.get(peerGl);
    first.dispose();
    expect(sdk.removeOffscreenContext).toHaveBeenCalledExactlyOnceWith(gl);
    expect(sdk.offscreenContexts.get(peerGl)).toBe(peerTarget);
    expect(peerTarget?.deleted).toBe(false);
    expect(sdk.dispose).not.toHaveBeenCalled();
    peer.resize();
    expect(options.onError).not.toHaveBeenCalled();
    peer.dispose();
    expect(sdk.removeOffscreenContext).toHaveBeenLastCalledWith(peerGl);
    expect(sdk.offscreenContexts.size).toBe(0);
    expect(sdk.dispose).toHaveBeenCalledOnce();
  });
  it('does not initialize Core or fetch model data when WebGL2 is unavailable', async () => {
    vi.mocked(canvas.getContext).mockReturnValue(null);
    await expect(createCodiaLive2D(canvas, { ...assets, signal: new AbortController().signal, reducedMotion: false, onError: vi.fn() })).rejects.toThrow('WebGL 2 unavailable');
    expect(sdk.start).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('ends the offscreen frame and evicts its pool when drawing throws', async () => {
    sdk.render.mockImplementationOnce(() => { throw new Error('draw failure'); });
    const onError = vi.fn();
    await expect(createCodiaLive2D(canvas, { ...assets, signal: new AbortController().signal, reducedMotion: true, onError })).rejects.toThrow();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'draw failure' }));
    expect(sdk.beginOffscreenFrame).toHaveBeenCalledExactlyOnceWith(gl);
    expect(sdk.endOffscreenFrame).toHaveBeenCalledExactlyOnceWith(gl);
    expect(sdk.endOffscreenFrame.mock.invocationCallOrder[0]).toBeGreaterThan(sdk.render.mock.invocationCallOrder[0]);
    expect(sdk.removeOffscreenContext).toHaveBeenCalledExactlyOnceWith(gl);
  });
  it('rejects incomplete parameter exports and releases the partial model', async () => {
    sdk.ids = sdk.ids.slice(1);
    await expect(createCodiaLive2D(canvas, { ...assets, signal: new AbortController().signal, reducedMotion: true, onError: vi.fn() })).rejects.toThrow('ParamBodyRise');
    expect(sdk.modelRelease).toHaveBeenCalledOnce();
    expect(sdk.dispose).toHaveBeenCalledOnce();
    expect(createImageBitmap).not.toHaveBeenCalled();
  });
  it('aborts during texture decoding without uploading late pixels or leaking the bitmap', async () => {
    let finish!: (value: ImageBitmap) => void;
    vi.mocked(createImageBitmap).mockReturnValue(new Promise<ImageBitmap>(resolve => { finish = resolve; }));
    const controller = new AbortController();
    const request = createCodiaLive2D(canvas, { ...assets, signal: controller.signal, reducedMotion: true, onError: vi.fn() });
    // Decode starts after the manifest, moc and texture fetches.
    for (let tick = 0; tick < 20 && !vi.mocked(createImageBitmap).mock.calls.length; tick++) await Promise.resolve();
    expect(createImageBitmap).toHaveBeenCalledOnce();
    controller.abort();
    finish({ close: bitmapClose, width: 1, height: 1 });
    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
    expect(bitmapClose).toHaveBeenCalledOnce();
    expect(gl.texImage2D).not.toHaveBeenCalled();
    expect(sdk.modelRelease).toHaveBeenCalledOnce();
    expect(sdk.dispose).toHaveBeenCalledOnce();
  });
});
