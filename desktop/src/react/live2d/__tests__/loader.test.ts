// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadCodiaLive2D } from '../loader';
import { CODIA_BUNDLED_ASSETS } from '../assets';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('Codia capability detection', () => {
  const options = () => ({ ...CODIA_BUNDLED_ASSETS, signal: new AbortController().signal, reducedMotion: true, onError: vi.fn() });
  it('rejects unavailable WebAssembly before inserting the SDK script', async () => {
    vi.stubGlobal('WebAssembly', undefined);
    const append = vi.spyOn(document.head, 'append');
    await expect(loadCodiaLive2D(document.createElement('canvas'), options())).rejects.toThrow('runtime unavailable');
    expect(append).not.toHaveBeenCalled();
  });
  it('honors blocked WebGL before loading Core or the model chunk', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn());
    const canvas = document.createElement('canvas');
    vi.spyOn(canvas, 'getContext').mockReturnValue(null);
    const append = vi.spyOn(document.head, 'append');
    await expect(loadCodiaLive2D(canvas, options())).rejects.toThrow('WebGL 2 unavailable');
    expect(append).not.toHaveBeenCalled();
    expect(canvas.getContext).toHaveBeenCalledWith('webgl2', expect.objectContaining({ failIfMajorPerformanceCaveat: true }));
  });
});
