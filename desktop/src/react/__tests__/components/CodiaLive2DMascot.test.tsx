// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodiaLive2DMascot } from '../../components/CodiaLive2DMascot';
import { loadCodiaLive2D } from '../../live2d/loader';
import type { CodiaLive2DHandle } from '../../live2d/runtime';

vi.mock('../../live2d/loader', () => ({ loadCodiaLive2D: vi.fn() }));
const assets = { modelUrl: 'http://127.0.0.1:5000/desktop/assets/codia/live2d/model/Codia.model3.json', shaderPath: 'http://127.0.0.1:5000/desktop/assets/codia/live2d/shaders/' };
let handle: CodiaLive2DHandle;
let media: { matches: boolean; addEventListener: ReturnType<typeof vi.fn>; removeEventListener: ReturnType<typeof vi.fn> };
let intersectionCallback: (entries: { isIntersecting: boolean }[]) => void;
const disconnects: ReturnType<typeof vi.fn>[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  handle = { dispose: vi.fn(), resize: vi.fn(), setVisible: vi.fn(), setReducedMotion: vi.fn() };
  media = { matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() };
  vi.stubGlobal('matchMedia', vi.fn(() => media));
  vi.stubGlobal('ResizeObserver', class { observe = vi.fn(); disconnect = vi.fn(); constructor() { disconnects.push(this.disconnect); } });
  vi.stubGlobal('IntersectionObserver', class {
    observe = vi.fn(); disconnect = vi.fn();
    constructor(callback: typeof intersectionCallback) { intersectionCallback = callback; disconnects.push(this.disconnect); }
  });
  vi.mocked(loadCodiaLive2D).mockResolvedValue(handle);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); disconnects.length = 0; });

describe('CodiaLive2DMascot lifecycle', () => {
  it('does not start by default, without an accepted export, or in GPU safe mode', () => {
    const { rerender } = render(<CodiaLive2DMascot fallback={<span>Fallback mascot</span>} assets={assets} />);
    rerender(<CodiaLive2DMascot fallback={<span>Fallback mascot</span>} enabled />);
    rerender(<CodiaLive2DMascot fallback={<span>Fallback mascot</span>} enabled assets={assets} gpuSafeMode />);
    rerender(<CodiaLive2DMascot fallback={<span>Fallback mascot</span>} enabled assets={assets} hardwareAccelerationEnabled={false} />);
    expect(loadCodiaLive2D).not.toHaveBeenCalled();
    expect(screen.getByText('Fallback mascot')).toBeVisible();
  });
  it('only labels a successful render live2d, pauses off-screen and releases on unmount', async () => {
    const { container, unmount } = render(<CodiaLive2DMascot fallback={<span>Fallback mascot</span>} enabled assets={assets} />);
    await waitFor(() => expect(container.firstChild).toHaveAttribute('data-codia-renderer', 'live2d'));
    expect(screen.getByText('Fallback mascot')).not.toBeVisible();
    expect(handle.setReducedMotion).toHaveBeenCalledWith(false);
    act(() => intersectionCallback([{ isIntersecting: false }]));
    expect(handle.setVisible).toHaveBeenLastCalledWith(false);
    const options = vi.mocked(loadCodiaLive2D).mock.calls[0][1];
    unmount();
    expect(options.signal.aborted).toBe(true);
    expect(handle.dispose).toHaveBeenCalledOnce();
    disconnects.forEach(disconnect => expect(disconnect).toHaveBeenCalledOnce());
    expect(media.removeEventListener).toHaveBeenCalled();
  });
  it('keeps the fallback after a missing or invalid model and discards late loads', async () => {
    vi.mocked(loadCodiaLive2D).mockRejectedValueOnce(new Error('Cubism rejected the exported .moc3'));
    const first = render(<CodiaLive2DMascot fallback={<span>Fallback mascot</span>} enabled assets={assets} />);
    await waitFor(() => expect(first.container.firstChild).toHaveAttribute('data-codia-load-error', 'Cubism rejected the exported .moc3'));
    expect(screen.getByText('Fallback mascot')).toBeVisible();
    first.unmount();
    let finish!: (value: CodiaLive2DHandle) => void;
    vi.mocked(loadCodiaLive2D).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const second = render(<CodiaLive2DMascot fallback={<span>Fallback mascot</span>} enabled assets={assets} />);
    second.unmount();
    await act(async () => { finish(handle); });
    expect(handle.dispose).toHaveBeenCalledOnce();
  });
  it('uses reduced motion and recovers context without reloading the app', async () => {
    media.matches = true;
    const { container } = render(<CodiaLive2DMascot fallback={<span>Fallback mascot</span>} enabled assets={assets} />);
    await waitFor(() => expect(container.firstChild).toHaveAttribute('data-codia-renderer', 'live2d'));
    expect(handle.setReducedMotion).toHaveBeenCalledWith(true);
    const canvas = container.querySelector('canvas')!;
    fireEvent(canvas, new Event('webglcontextlost', { cancelable: true }));
    expect(container.firstChild).toHaveAttribute('data-codia-renderer', 'fallback');
    expect(handle.dispose).toHaveBeenCalled();
    fireEvent(canvas, new Event('webglcontextrestored'));
    await waitFor(() => expect(loadCodiaLive2D).toHaveBeenCalledTimes(2));
  });
  it.each(['setReducedMotion', 'setVisible'] as const)('keeps fallback when initial %s drawing fails after loading', async (method) => {
    vi.mocked(loadCodiaLive2D).mockImplementationOnce(async (_canvas, options) => {
      handle[method] = vi.fn(() => options.onError(new Error('initial pose drawing failed')));
      return handle;
    });
    const { container } = render(<CodiaLive2DMascot fallback={<span>Fallback mascot</span>} enabled assets={assets} />);
    await waitFor(() => expect(container.firstChild).toHaveAttribute('data-codia-load-error', 'initial pose drawing failed'));
    expect(container.firstChild).toHaveAttribute('data-codia-renderer', 'fallback');
    expect(screen.getByText('Fallback mascot')).toBeVisible();
    expect(container.querySelector('canvas')).not.toBeVisible();
    expect(handle.dispose).toHaveBeenCalledOnce();
  });
  it('reports string exceptions from Core instead of showing an empty error', async () => {
    vi.mocked(loadCodiaLive2D).mockRejectedValueOnce('Unable to grow wasm table');
    const { container } = render(<CodiaLive2DMascot fallback={<span>Fallback mascot</span>} enabled assets={assets} />);
    await waitFor(() => expect(container.firstChild).toHaveAttribute('data-codia-load-error', 'Unable to grow wasm table'));
    expect(container.firstChild).toHaveAttribute('data-codia-renderer', 'fallback');
    expect(screen.getByText('Fallback mascot')).toBeVisible();
  });
});
