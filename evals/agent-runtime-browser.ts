import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { BrowserManager } from '../lib/browser/browser-manager.ts';

export async function createIsolatedBrowser() {
  const require = createRequire(import.meta.url);
  let executable: string;
  try { executable = require('electron'); } catch { return null; }
  if (!fs.existsSync(executable)) return null;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codia-browser-eval-'));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, [fileURLToPath(new URL('./fixtures/runtime-browser-host.cjs', import.meta.url)), root], {
    env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let errorText = '';
  child.stderr?.on('data', data => { errorText = (errorText + data).slice(-2000); });
  const close = async () => {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => child.kill(), 3000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
        if (child.connected) child.send({ type: 'shutdown' }); else child.kill();
      });
    }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  };
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Isolated Chromium host startup timed out')), 20000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error(`Isolated Chromium host exited: ${errorText}`)); });
      child.on('message', (message: any) => { if (message.type === 'ready') { clearTimeout(timer); resolve(); } });
    });
    const transport = { get connected() { return child.connected; },
      send: (message: any) => child.send(message),
      onMessage: (handler: (message: any) => void) => child.on('message', handler) };
    return { manager: new BrowserManager({ transport }), close };
  } catch (error) { await close(); throw error; }
}
