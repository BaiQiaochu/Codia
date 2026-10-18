import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CodiaLive2DMascot } from '../../../desktop/src/react/components/CodiaLive2DMascot';
import type { CodiaLive2DAssets } from '../../../desktop/src/react/live2d/assets';
import './style.css';

function Fixture() {
  const [assets, setAssets] = useState<CodiaLive2DAssets | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [mounted, setMounted] = useState(true);
  const [safe, setSafe] = useState(false);
  const [key, setKey] = useState(0);
  const [size, setSize] = useState(360);
  const [cycling, setCycling] = useState(false);
  const [cycleStatus, setCycleStatus] = useState('尚未运行连续启停检查');
  const [state, setState] = useState<Record<string, unknown>>({ status: 'loading-config' });
  const [events, setEvents] = useState<string[]>([]);
  const stage = useRef<HTMLDivElement>(null);
  const lostContext = useRef<WEBGL_lose_context | null>(null);
  const addEvent = (message: string) => setEvents(previous => [...previous.slice(-29), `${new Date().toISOString()} ${message}`]);
  useEffect(() => {
    const controller = new AbortController();
    const port = new URL(location.href).searchParams.get('assetPort');
    const base = location.protocol === 'file:' ? `http://127.0.0.1:${Number(port)}/` : location.href;
    void fetch(new URL('fixture-config.json', base), { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error(`Fixture config HTTP ${response.status}`);
      const config = await response.json();
      setAssets({ modelUrl: new URL(config.modelUrl, base).href, shaderPath: new URL(config.shaderPath, base).href });
    }).catch(error => { if (!controller.signal.aborted) addEvent(String(error)); });
    const error = (event: ErrorEvent) => addEvent(`error: ${event.message}`);
    const rejection = (event: PromiseRejectionEvent) => addEvent(`unhandledrejection: ${String(event.reason)}`);
    window.addEventListener('error', error);
    window.addEventListener('unhandledrejection', rejection);
    return () => {
      controller.abort();
      window.removeEventListener('error', error);
      window.removeEventListener('unhandledrejection', rejection);
    };
  }, []);
  useEffect(() => {
    if (!stage.current) return;
    let previous = '';
    const read = () => {
      const host = stage.current?.querySelector<HTMLElement>('[data-codia-renderer]');
      const canvas = stage.current?.querySelector('canvas');
      const value = {
        renderer: host?.dataset.codiaRenderer ?? 'unmounted', error: host?.dataset.codiaLoadError ?? null,
        canvas: canvas ? { width: canvas.width, height: canvas.height } : null,
        reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
        pageProtocol: location.protocol,
      };
      const json = JSON.stringify(value);
      if (json === previous) return;
      previous = json;
      setState(value);
      addEvent(json);
    };
    const observer = new MutationObserver(read);
    observer.observe(stage.current, { subtree: true, attributes: true, childList: true });
    read();
    return () => observer.disconnect();
  }, []);
  function lose() {
    const canvas = stage.current?.querySelector('canvas');
    const extension = canvas?.getContext('webgl2')?.getExtension('WEBGL_lose_context');
    if (!extension) { addEvent('WEBGL_lose_context unavailable'); return; }
    lostContext.current = extension;
    extension.loseContext();
    addEvent('loseContext requested');
  }
  function restore() {
    if (!lostContext.current) { addEvent('No lost context to restore'); return; }
    lostContext.current.restoreContext();
    addEvent('restoreContext requested');
  }
  async function cycleFiveTimes() {
    if (cycling) return;
    setCycling(true);
    const waitForRenderer = async (expected: string) => {
      const deadline = performance.now() + 20_000;
      while (performance.now() < deadline) {
        const host = stage.current?.querySelector<HTMLElement>('[data-codia-renderer]');
        if (host?.dataset.codiaRenderer === expected) {
          // Allow the actual WebGL frame to reach the compositor before toggling.
          await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
          return;
        }
        if (expected === 'live2d' && host?.dataset.codiaLoadError) throw new Error(host.dataset.codiaLoadError);
        await new Promise(resolve => setTimeout(resolve, 40));
      }
      throw new Error(`Timed out waiting for ${expected}`);
    };
    try {
      setMounted(true);
      setSafe(false);
      setEnabled(true);
      await waitForRenderer('live2d');
      for (let cycle = 1; cycle <= 5; cycle++) {
        setCycleStatus(`第 ${cycle}/5 次停用…`);
        setEnabled(false);
        await waitForRenderer('disabled');
        setCycleStatus(`第 ${cycle}/5 次启用…`);
        setEnabled(true);
        await waitForRenderer('live2d');
        addEvent(`cycle ${cycle}/5: disabled → live2d, no reported runtime error`);
      }
      setCycleStatus('5/5 次启停完成：均恢复 live2d；请继续核对画面');
    } catch (error) {
      const message = `连续启停失败：${error instanceof Error ? error.message : String(error)}`;
      setCycleStatus(message);
      addEvent(message);
    } finally { setCycling(false); }
  }
  return (
    <main>
      <h1>Codia Live2D · React 运行时检查</h1>
      <p>使用真实组件、官方 SDK 与指定导出模型。这里只检查加载和生命周期，视觉质量仍需人工核对。</p>
      <fieldset className="controls" disabled={cycling}>
        <label><input id="enabled" type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />启用</label>
        <label><input id="mounted" type="checkbox" checked={mounted} onChange={event => setMounted(event.target.checked)} />挂载</label>
        <label><input id="gpu-safe" type="checkbox" checked={safe} onChange={event => setSafe(event.target.checked)} />GPU 安全模式</label>
        <button id="remount" onClick={() => setKey(value => value + 1)}>重新挂载</button>
        <button id="lose-context" onClick={lose}>丢失 WebGL 上下文</button>
        <button id="restore-context" onClick={restore}>恢复 WebGL 上下文</button>
        <button id="cycle-five" disabled={!assets} onClick={() => void cycleFiveTimes()}>连续启停 5 次</button>
        <label>尺寸 <input id="size" type="range" min="140" max="520" value={size} onChange={event => setSize(Number(event.target.value))} />{size}px</label>
      </fieldset>
      <p id="cycle-status" role="status">{cycleStatus}</p>
      <div ref={stage} id="stage" style={{ width: size, height: size }}>
        {mounted && <CodiaLive2DMascot key={key} enabled={enabled} assets={assets} gpuSafeMode={safe} />}
      </div>
      <h2>当前状态</h2><pre id="runtime-state">{JSON.stringify(state, null, 2)}</pre>
      <h2>状态与错误记录</h2><pre id="runtime-events">{events.join('\n')}</pre>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
