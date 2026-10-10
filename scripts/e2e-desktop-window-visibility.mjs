#!/usr/bin/env node
// Verify native BrowserWindow visibility. A rendered page or a "show" event
// alone does not detect Windows SW_HIDE suppressing a desktop launch.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import WebSocket from 'ws';
import { createIsolatedE2EHome, getAvailablePort, startMockOpenAI, removeE2EHome } from './e2e-env.mjs';

const root = process.cwd();
const output = path.join(root, 'artifacts/desktop-window-visibility');
const electron = createRequire(import.meta.url)('electron');
const electronAPI = "process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron')";
const mainWindow = `${electronAPI}.BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html'))`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
fs.mkdirSync(output, { recursive: true });

async function waitFor(fn, label, timeout = 60000) {
  const deadline = Date.now() + timeout;
  do {
    const value = await fn();
    if (value) return value;
    await sleep(200);
  } while (Date.now() < deadline);
  throw new Error(`${label} timed out`);
}

async function connect(port) {
  const target = await waitFor(async () => {
    try { return (await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json()))[0]; }
    catch { return null; }
  }, 'main-process inspector');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  let id = 0;
  const pending = new Map();
  ws.on('message', raw => {
    const message = JSON.parse(String(raw));
    const ticket = pending.get(message.id);
    if (!ticket) return;
    pending.delete(message.id);
    clearTimeout(ticket.timer);
    if (message.error) ticket.reject(new Error(message.error.message));
    else ticket.resolve(message.result);
  });
  ws.on('close', () => {
    for (const ticket of pending.values()) { clearTimeout(ticket.timer); ticket.reject(new Error('Inspector closed')); }
    pending.clear();
  });
  return {
    close: () => ws.close(),
    async evaluate(expression) {
      const response = await new Promise((resolve, reject) => {
        const requestId = ++id;
        const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('Inspector request timed out')); }, 15000);
        pending.set(requestId, { resolve, reject, timer });
        ws.send(JSON.stringify({ id: requestId, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
      });
      if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
      return response.result?.value;
    },
  };
}

async function checkMode(mode) {
  const dir = path.join(output, mode);
  fs.mkdirSync(dir, { recursive: true });
  const mock = await startMockOpenAI();
  const home = createIsolatedE2EHome({ mockBaseUrl: mock.baseUrl });
  const inspectPort = await getAvailablePort();
  const env = { ...process.env, CODIA_HOME: home, CODIA_DEV_DESKTOP_PORT: '0', CODIA_PORT: '0', CODIA_DESKTOP_SERVER_MODE: 'dist' };
  delete env.ELECTRON_RUN_AS_NODE;
  // Keep the real tray, single-instance handling and normal window behavior.
  delete env.CODIA_E2E;
  const stdout = fs.openSync(path.join(dir, 'stdout.log'), 'w');
  const stderr = fs.openSync(path.join(dir, 'stderr.log'), 'w');
  const child = spawn(process.execPath, ['scripts/launch.js', mode, `--inspect=127.0.0.1:${inspectPort}`], {
    cwd: root, env, windowsHide: true, stdio: ['ignore', stdout, stderr],
  });
  let inspector;
  const report = { mode, ok: false, checks: [] };
  let userData;
  let executionError;
  let cleanupError;
  try {
    // The bundled server performs a clean schema migration and plugin scan in
    // this isolated profile. On slower Windows hosts that cold start can take
    // longer than the source modes without indicating a product failure.
    const startupTimeout = mode === 'electron-built' ? 150000 : 60000;
    // The ESM bootstrap creates a transient inspector context. Wait until the
    // real main window exists before evaluating in the main-process context.
    await waitFor(() => {
      if (child.exitCode !== null) throw new Error(`Desktop exited before startup: ${child.exitCode}`);
      const log = path.join(home, 'diagnostics/desktop-launch/renderer.log');
      return fs.existsSync(log) && fs.readFileSync(log, 'utf8').split('\n').some(line => {
        if (!line.trim()) return false;
        const entry = JSON.parse(line);
        return entry.event === 'window-created' && entry.details?.label === 'main';
      });
    }, 'main window creation', startupTimeout);
    inspector = await connect(inspectPort);
    userData = await inspector.evaluate(`${electronAPI}.app.getPath('userData')`);
    const snapshot = () => inspector.evaluate(`(() => {
      const windows = ${electronAPI}.BrowserWindow.getAllWindows();
      const w = ${mainWindow};
      return w ? {visible:w.isVisible(), minimized:w.isMinimized(), focused:w.isFocused(),
        bounds:w.getBounds(), splash:windows.some(item=>item.isVisible() && item.webContents.getURL().includes('splash.html'))} : null;
    })()`);
    await waitFor(async () => { const s = await snapshot(); return s && !s.splash; }, 'splash handoff');
    const rendererSnapshot = () => inspector.evaluate(`${mainWindow}.webContents.executeJavaScript(\`(async () => ({
      port: await window.platform.getServerPort(),
      text: document.body.innerText.slice(0, 1600),
      mascot: document.querySelector('[data-codia-renderer]')?.getAttribute('data-codia-renderer') || null,
      mascotError: document.querySelector('[data-codia-renderer]')?.getAttribute('data-codia-load-error') || null,
      appReady: window.__CODIA_E2E__?.appReady ?? null
    }))()\`)`);
    let renderer;
    await waitFor(async () => {
      renderer = await rendererSnapshot();
      if (renderer?.mascotError) throw new Error(`Live2D load failed: ${renderer.mascotError}`);
      return renderer?.mascot === 'live2d' && renderer.text.includes('嗨，我是小豆蔻');
    }, 'localized renderer and Live2D mascot', 30000);
    report.renderer = renderer;
    const ready = await snapshot();
    assert.equal(ready.visible, true, 'main window must really be visible after splash closes');
    assert.equal(ready.minimized, false, 'startup must not leave the main window minimized');
    report.checks.push({ name: 'startup-visible', state: ready });

    await inspector.evaluate(`${mainWindow}.close()`);
    assert.equal((await snapshot()).visible, false, 'close should hide to tray');
    report.checks.push({ name: 'close-to-tray' });

    const duplicate = spawn(electron, [root], { cwd: root, env, windowsHide: false, stdio: 'ignore' });
    const duplicateExit = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { duplicate.kill(); reject(new Error('Duplicate launch did not exit')); }, 15000);
      duplicate.once('error', error => { clearTimeout(timer); reject(error); });
      duplicate.once('exit', code => { clearTimeout(timer); resolve(code); });
    });
    assert.equal(duplicateExit, 0);
    await waitFor(async () => (await snapshot())?.visible, 'second instance restores tray window', 5000);
    report.checks.push({ name: 'second-instance-restores-window', state: await snapshot() });

    await inspector.evaluate(`${mainWindow}.minimize()`);
    await waitFor(async () => (await snapshot())?.minimized, 'minimize', 5000);
    await inspector.evaluate(`${electronAPI}.app.emit('activate')`);
    await waitFor(async () => { const s = await snapshot(); return s?.visible && !s.minimized; }, 'activate restores minimized window', 5000);
    report.checks.push({ name: 'activate-restores-window', state: await snapshot() });
    // Hold the mascot's documented reduced-motion pose for the evidence image
    // instead of occasionally capturing the intentional hidden phase.
    await inspector.evaluate(`(() => {
      const wc = ${mainWindow}.webContents;
      if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
      return wc.debugger.sendCommand('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-motion', value: 'reduce' }]
      });
    })()`);
    await sleep(300);
    await inspector.evaluate(`${mainWindow}.webContents.executeJavaScript('window.getSelection()?.removeAllRanges()')`);
    const png = await inspector.evaluate(`${mainWindow}.capturePage().then(image=>image.toPNG().toString('base64'))`);
    fs.writeFileSync(path.join(dir, 'main.png'), Buffer.from(png, 'base64'));
    await inspector.evaluate(`(() => {
      const wc = ${mainWindow}.webContents;
      if (wc.debugger.isAttached()) wc.debugger.detach();
    })()`);
    report.mockRequests = mock.requests.length;
    report.ok = true;
    console.log(`${mode}: ${report.checks.length} native window checks passed`);
  } catch (error) {
    report.error = error.stack || String(error);
    executionError = error;
  } finally {
    if (inspector) {
      await inspector.evaluate(`${electronAPI}.app.quit()`).catch(() => {});
      inspector.close();
      await waitFor(() => child.exitCode !== null || child.signalCode !== null, 'desktop shutdown', 10000).catch(() => {});
    }
    if (child.exitCode === null && child.signalCode === null) {
      try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {}
    }
    const log = path.join(home, 'diagnostics/desktop-launch/renderer.log');
    if (fs.existsSync(log)) fs.copyFileSync(log, path.join(dir, 'renderer.log'));
    await mock.close();
    const resolved = path.resolve(home);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('codia-e2e-home-')) {
      cleanupError = new Error('Refusing to clean an unexpected smoke home');
    } else {
      removeE2EHome(resolved);
    }
    if (process.platform === 'win32' && userData) {
      const { getUserDataAppName } = createRequire(import.meta.url)('../desktop/src/shared/single-instance-lock.cjs');
      const expected = path.resolve(process.env.APPDATA, getUserDataAppName(home, path.join(os.homedir(), '.codia')));
      if (path.resolve(userData) !== expected || !path.basename(expected).startsWith('Codia-e2e-home-')) {
        cleanupError ??= new Error('Refusing to clean an unexpected Electron userData directory');
      } else {
        fs.rmSync(expected, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      }
    }
    fs.closeSync(stdout);
    fs.closeSync(stderr);
    if (cleanupError) report.cleanupError = cleanupError.message;
    fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
  }
  if (executionError) throw executionError;
  if (cleanupError) throw cleanupError;
}

const requestedModes = String(process.env.CODIA_E2E_DESKTOP_MODES || '')
  .split(',')
  .map(value => value.trim())
  .filter(Boolean);
const modes = requestedModes.length ? requestedModes : ['electron', 'electron-dev', 'electron-built'];
for (const mode of modes) await checkMode(mode);
