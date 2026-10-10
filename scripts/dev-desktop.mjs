#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createServer } from 'vite';
import { resolveDesktopDevPort } from './dev-desktop-runtime.mjs';
import { DEFAULT_CODIA_DEV_HOME, applyCodiaHomeEnv } from '../shared/codia-home.ts';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('..', import.meta.url));
let vite;
let electron;
let temporaryDir;
let closing;

async function close(code = 0) {
  if (closing) return closing;
  closing = (async () => {
    if (electron?.pid && electron.exitCode === null && electron.signalCode === null) {
      const exited = new Promise((resolve) => electron.once('exit', resolve));
      if (process.platform === 'win32') {
        // Stop only the process tree created by this launcher, including its server.
        const killer = spawn('taskkill', ['/PID', String(electron.pid), '/T', '/F'], {
          windowsHide: true, stdio: 'ignore',
        });
        await new Promise((resolve) => {
          killer.once('exit', resolve);
          killer.once('error', () => { electron.kill(); resolve(); });
        });
      } else {
        electron.kill('SIGTERM');
      }
      await exited;
    }
    await vite?.close();
    // This directory is created by mkdtemp for this process, outside the source tree.
    if (temporaryDir) await rm(temporaryDir, { recursive: true, force: true });
    process.exitCode = code;
  })();
  return closing;
}

try {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major !== 24 || minor < 12) throw new Error('Codia source mode requires Node.js >=24.12.0 <25.');
  const port = await resolveDesktopDevPort(process.env.CODIA_DEV_DESKTOP_PORT ?? (process.env.CODIA_E2E === '1' ? 0 : 5173));

  temporaryDir = await mkdtemp(path.join(os.tmpdir(), 'codia-source-preload-'));
  const preloadPath = path.join(temporaryDir, 'preload.cjs');
  // Sandboxed Electron cannot require local helper files. Keep its required
  // single-file preload temporary; never build the application into the checkout.
  await build({
    absWorkingDir: root,
    entryPoints: ['desktop/preload.cjs'],
    outfile: preloadPath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
    target: 'node24',
    sourcemap: 'inline',
    logLevel: 'warning',
  });
  vite = await createServer({
    configFile: path.join(root, 'vite.config.ts'),
    mode: 'development',
    server: { host: '127.0.0.1', port, strictPort: true },
  });
  await vite.listen();
  const address = vite.httpServer.address();
  if (!address || typeof address === 'string') throw new Error('Vite did not open a TCP listener.');
  const rendererUrl = `http://127.0.0.1:${address.port}`;
  const env = { ...process.env };
  applyCodiaHomeEnv(env.CODIA_HOME || DEFAULT_CODIA_DEV_HOME, env);
  Object.assign(env, {
    CODIA_LAUNCH_NODE: process.execPath,
    CODIA_LAUNCH_NODE_VERSION: process.versions.node,
    CODIA_DESKTOP_SERVER_MODE: 'source',
    CODIA_DEV_PRELOAD_PATH: preloadPath,
    CODIA_PORT: env.CODIA_PORT || '0',
    VITE_DEV_URL: rendererUrl,
  });
  delete env.ELECTRON_RUN_AS_NODE;
  console.log(`[source] renderer=${rendererUrl}; server=Node TypeScript source`);
  electron = spawn(require('electron'), [root, ...process.argv.slice(2)], {
    // This is the user's GUI, not a background helper. SW_HIDE on Windows
    // can suppress its first ShowWindow even after Electron emits "show".
    cwd: root, env, stdio: 'inherit', windowsHide: false,
  });
  const exitCode = await new Promise((resolve, reject) => {
    electron.once('error', reject);
    electron.once('exit', (code, signal) => {
      console.log(`[source] desktop exited: code=${code ?? 'none'}, signal=${signal || 'none'}`);
      resolve(code ?? 1);
    });
    for (const signal of ['SIGINT', 'SIGTERM', ...(process.platform === 'win32' ? ['SIGBREAK'] : [])]) {
      process.once(signal, () => {
        console.log(`[source] launcher received ${signal}; closing its desktop and Vite server`);
        void close(0);
      });
    }
  });
  await close(exitCode);
} catch (error) {
  console.error(`[source] ${error.stack || error.message}`);
  await close(1);
}
