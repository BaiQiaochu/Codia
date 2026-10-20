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
const createHandle = (): CodiaLive2DHandle => ({ dispose: vi.fn(), resize: vi.fn(), setVisible: vi.fn(), setReducedMotion: vi.fn() });
let handle: CodiaLive2DHandle;
let media: { matches: boolean; addEventListener: ReturnType<typeof vi.fn>; removeEventListener: ReturnType<typeof vi.fn> };
let intersectionCallback: (entries: { isIntersecting: boolean }[]) => void;
const disconnects: ReturnType<typeof vi.fn>[] = [];
const expectNoStaticMascot = (container: HTMLElement) => {
  expect(container.querySelector('img')).toBeNull();
  expect(screen.queryByText('Fallback mascot')).not.toBeInTheDocument();
  expect(container).not.toHaveTextContent('静态形象');
};
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  handle = createHandle();
  media = { matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() };
  vi.stubGlobal('matchMedia', vi.fn(() => media));
  vi.stubGlobal('ResizeObserver', class { observe = vi.fn(); disconnect = vi.fn(); constructor() { disconnects.push(this.disconnect); } });
  vi.stubGlobal('IntersectionObserver', class {
    observe = vi.fn(); disconnect = vi.fn();
    constructor(callback: typeof intersectionCallback) { intersectionCallback = callback; disconnects.push(this.disconnect); }
  });
  vi.mocked(loadCodiaLive2D).mockReset().mockResolvedValue(handle);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); disconnects.length = 0; });

describe('CodiaLive2DMascot lifecycle', () => {
  it('does not start by default or without an export, but still attempts Live2D with the existing GPU policy', async () => {
    const { container, rerender } = render(<CodiaLive2DMascot fallback={<span>Fallback mascot</span>} assets={assets} />);
    expect(container.firstChild).toHaveAttribute('data-codia-renderer', 'disabled');
    expect(loadCodiaLive2D).not.toHaveBeenCalled();
    expectNoStaticMascot(container);
    rerender(<CodiaLive2DMascot fallback={<span>Fallback mascot</span>} enabled />);
    expect(container.firstChild).toHaveAttribute('data-codia-renderer', 'error');
    expect(screen.getByRole('alert')).toHaveTextContent('Live2D 模型资源未配置');
    expect(loadCodiaLive2D).not.toHaveBeenCalled();
    expectNoStaticMascot(container);
    rerender(<CodiaLive2DMascot fallback={<span>Fallback mascot</span>} enabled assets={assets} gpuSafeMode />);
    await waitFor(() => expect(container.firstChild).toHaveAttribute('data-codia-renderer', 'live2d'));
    rerender(<CodiaLive2DMascot fallback={<span>Fallback mascot</span>} enabled assets={assets} hardwareAccelerationEnabled={false} />);
    await waitFor(() => expect(loadCodiaLive2D).toHaveBeenCalledTimes(2));
    expectNoStaticMascot(container);
  });
  it('shows a loading status without a static image until the dynamic renderer is ready', async () => {
    let finish!: (value: CodiaLive2DHandle) => void;
    vi.mocked(loadCodiaLive2D).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const { container } = render(<CodiaLive2DMascot fallback={<span>Fallback mascot</span>} enabled assets={assets} />);
    expect(container.firstChild).toHaveAttribute('data-codia-renderer', 'loading');
    expect(screen.getByRole('status')).toHaveTextContent('正在加载 Live2D');
    expect(container.querySelector('canvas')).not.toBeVisible();
    expectNoStaticMascot(container);
    await act(async () => { finish(handle); });
    expect(container.firstChild).toHaveAttribute('data-codia-renderer', 'live2d');
    expect(screen.getByRole('img', { name: 'Codia 吉祥物' })).toBeVisible();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expectNoStaticMascot(container);
  });
  it('only labels a successful render live2d, pauses off-screen and releases on unmount', async () => {
    const { container, unmount } = render(<CodiaLive2DMascot fallback={<span>Fallback mascot</span>} enabled assets={assets} />);
    await waitFor(() => expect(container.firstChild).toHaveAttribute('data-codia-renderer', 'live2d'));
    expectNoStaticMascot(container);
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
  it.each(['WebGL2 unavailable', 'Cubism rejected the exported .moc3', 'Live2D asset HTTP 404'])('reports %s without any static fallback', async (reason) => {
    vi.mocked(loadCodiaLive2D).mockRejectedValueOnce(new Error(reason));
    const { container } = render(<CodiaLive2DMascot fallback={<span>Fallback mascot</span>} enabled assets={assets} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(`Live2D 加载或渲染失败：${reason}`);
    expect(container.firstChild).toHaveAttribute('data-codia-renderer', 'error');
    expect(container.firstChild).toHaveAttribute('data-codia-load-error', reason);
    expect(container.querySelector('canvas')).not.toBeVisible();
    expect(screen.getByRole('button', { name: '重试 Live2D' })).toBeVisible();
    expectNoStaticMascot(container);
  });
  it('reports synchronous initialization exceptions and aborts the failed attempt', async () => {
    vi.mocked(loadCodiaLive2D).mockImplementationOnce(() => { throw new Error('Cubism Core initialization failed'); });
    const { container } = render(<CodiaLive2DMascot enabled assets={assets} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Cubism Core initialization failed');
    expect(vi.mocked(loadCodiaLive2D).mock.calls[0][1].signal.aborted).toBe(true);
    expectNoStaticMascot(container);
  });
  it('preserves an error reported synchronously before the loader resolves', async () => {
    vi.mocked(loadCodiaLive2D).mockImplementationOnce(async (_canvas, options) => {
      options.onError(new Error('initial frame failed'));
      return handle;
    });
    const { container } = render(<CodiaLive2DMascot enabled assets={assets} />);
    await waitFor(() => expect(handle.dispose).toHaveBeenCalledOnce());
    expect(screen.getByRole('alert')).toHaveTextContent('initial frame failed');
    expect(container.firstChild).toHaveAttribute('data-codia-renderer', 'error');
    expectNoStaticMascot(container);
  });
  it('retries with a fresh canvas and load signal, then restores the dynamic renderer', async () => {
    vi.mocked(loadCodiaLive2D).mockRejectedValueOnce(new Error('WebGL2 unavailable'));
    const { container } = render(<CodiaLive2DMascot fallback={<span>Fallback mascot</span>} enabled assets={assets} />);
    await screen.findByRole('alert');
    const oldCanvas = container.querySelector('canvas');
    const oldOptions = vi.mocked(loadCodiaLive2D).mock.calls[0][1];
    let finish!: (value: CodiaLive2DHandle) => void;
    vi.mocked(loadCodiaLive2D).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const retry = screen.getByRole('button', { name: '重试 Live2D' });
    fireEvent.click(retry);
    fireEvent.click(retry);
    expect(loadCodiaLive2D).toHaveBeenCalledTimes(2);
    expect(container.firstChild).toHaveAttribute('data-codia-renderer', 'loading');
    expect(container.querySelector('canvas')).not.toBe(oldCanvas);
    const newOptions = vi.mocked(loadCodiaLive2D).mock.calls[1][1];
    expect(oldOptions.signal.aborted).toBe(true);
    expect(newOptions.signal).not.toBe(oldOptions.signal);
    expect(newOptions.signal.aborted).toBe(false);
    expectNoStaticMascot(container);
    await act(async () => { finish(handle); });
    expect(container.firstChild).toHaveAttribute('data-codia-renderer', 'live2d');
    expect(container.firstChild).not.toHaveAttribute('data-codia-load-error');
    expect(screen.getByRole('img', { name: 'Codia 吉祥物' })).toBeVisible();
    act(() => oldOptions.onError(new Error('late old error')));
    expect(container.firstChild).toHaveAttribute('data-codia-renderer', 'live2d');
  });
  it('discards a late failed load without resetting a successful retry', async () => {
    let finishOld!: (value: CodiaLive2DHandle) => void;
    vi.mocked(loadCodiaLive2D).mockReturnValueOnce(new Promise(resolve => { finishOld = resolve; }));
    const { container } = render(<CodiaLive2DMascot enabled assets={assets} />);
    const oldOptions = vi.mocked(loadCodiaLive2D).mock.calls[0][1];
    act(() => oldOptions.onError(new Error('initial drawing failed')));
    fireEvent.click(screen.getByRole('button', { name: '重试 Live2D' }));
    await waitFor(() => expect(container.firstChild).toHaveAttribute('data-codia-renderer', 'live2d'));
    const oldHandle = createHandle();
    await act(async () => { finishOld(oldHandle); });
    expect(oldHandle.dispose).toHaveBeenCalledOnce();
    expect(handle.dispose).not.toHaveBeenCalled();
    expect(container.firstChild).toHaveAttribute('data-codia-renderer', 'live2d');
    expect(container.firstChild).not.toHaveAttribute('data-codia-load-error');
    expectNoStaticMascot(container);
  });
  it('discards loads that finish after unmount', async () => {
    let finish!: (value: CodiaLive2DHandle) => void;
    vi.mocked(loadCodiaLive2D).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const { unmount } = render(<CodiaLive2DMascot enabled assets={assets} />);
    unmount();
    await act(async () => { finish(handle); });
    expect(handle.dispose).toHaveBeenCalledOnce();
  });
  it('uses reduced motion and recovers context without reloading the app', async () => {
    media.matches = true;
    const { container } = render(<CodiaLive2DMascot enabled assets={assets} />);
    await waitFor(() => expect(container.firstChild).toHaveAttribute('data-codia-renderer', 'live2d'));
    expect(handle.setReducedMotion).toHaveBeenCalledWith(true);
    const canvas = container.querySelector('canvas')!;
    fireEvent(canvas, new Event('webglcontextlost', { cancelable: true }));
    expect(container.firstChild).toHaveAttribute('data-codia-renderer', 'error');
    expect(screen.getByRole('alert')).toHaveTextContent('WebGL context lost');
    expect(handle.dispose).toHaveBeenCalledOnce();
    expectNoStaticMascot(container);
    fireEvent(canvas, new Event('webglcontextrestored'));
    await waitFor(() => expect(container.firstChild).toHaveAttribute('data-codia-renderer', 'live2d'));
    expect(loadCodiaLive2D).toHaveBeenCalledTimes(2);
    expect(container.querySelector('canvas')).not.toBe(canvas);
  });
  it.each(['setReducedMotion', 'setVisible'] as const)('does not show a static image when initial %s drawing fails', async (method) => {
    vi.mocked(loadCodiaLive2D).mockImplementationOnce(async (_canvas, options) => {
      handle[method] = vi.fn(() => options.onError(new Error('initial pose drawing failed')));
      return handle;
    });
    const { container } = render(<CodiaLive2DMascot fallback={<span>Fallback mascot</span>} enabled assets={assets} />);
    await waitFor(() => expect(container.firstChild).toHaveAttribute('data-codia-load-error', 'initial pose drawing failed'));
    expect(container.firstChild).toHaveAttribute('data-codia-renderer', 'error');
    expectNoStaticMascot(container);
    expect(container.querySelector('canvas')).not.toBeVisible();
    expect(handle.dispose).toHaveBeenCalledOnce();
  });
  it('releases a running renderer after drawing fails and supports repeated real retries', async () => {
    const { container, unmount } = render(<CodiaLive2DMascot enabled assets={assets} />);
    await waitFor(() => expect(container.firstChild).toHaveAttribute('data-codia-renderer', 'live2d'));
    for (let attempt = 0; attempt < 2; attempt++) {
      const options = vi.mocked(loadCodiaLive2D).mock.calls[attempt][1];
      const previousHandle = handle;
      act(() => options.onError(new Error('Cubism drawing failed')));
      expect(previousHandle.dispose).toHaveBeenCalledOnce();
      expect(options.signal.aborted).toBe(true);
      expect(container.firstChild).toHaveAttribute('data-codia-renderer', 'error');
      expectNoStaticMascot(container);
      handle = createHandle();
      vi.mocked(loadCodiaLive2D).mockResolvedValueOnce(handle);
      fireEvent.click(screen.getByRole('button', { name: '重试 Live2D' }));
      await waitFor(() => expect(container.firstChild).toHaveAttribute('data-codia-renderer', 'live2d'));
      expect(previousHandle.dispose).toHaveBeenCalledOnce();
    }
    expect(loadCodiaLive2D).toHaveBeenCalledTimes(3);
    unmount();
    expect(handle.dispose).toHaveBeenCalledOnce();
    disconnects.forEach(disconnect => expect(disconnect).toHaveBeenCalledOnce());
  });
  it('reports string exceptions from Core instead of showing an empty error', async () => {
    vi.mocked(loadCodiaLive2D).mockRejectedValueOnce('Unable to grow wasm table');
    const { container } = render(<CodiaLive2DMascot fallback={<span>Fallback mascot</span>} enabled assets={assets} />);
    await waitFor(() => expect(container.firstChild).toHaveAttribute('data-codia-load-error', 'Unable to grow wasm table'));
    expect(container.firstChild).toHaveAttribute('data-codia-renderer', 'error');
    expectNoStaticMascot(container);
  });
});
