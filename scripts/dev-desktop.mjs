#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createServer } from 'vite';
import { DEFAULT_GSAP_DEV_HOME, applyGsapHomeEnv } from '../shared/gsap-home.ts';

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
  const port = Number(process.env.GSAP_DEV_DESKTOP_PORT ?? (process.env.GSAP_E2E === '1' ? 0 : 5173));
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('GSAP_DEV_DESKTOP_PORT must be an integer between 0 and 65535.');
  }

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
  applyGsapHomeEnv(env.GSAP_HOME || DEFAULT_GSAP_DEV_HOME, env);
  Object.assign(env, {
    GSAP_LAUNCH_NODE: process.execPath,
    GSAP_LAUNCH_NODE_VERSION: process.versions.node,
    GSAP_DESKTOP_SERVER_MODE: 'source',
    GSAP_DEV_PRELOAD_PATH: preloadPath,
    GSAP_PORT: env.GSAP_PORT || '0',
    VITE_DEV_URL: rendererUrl,
  });
  delete env.ELECTRON_RUN_AS_NODE;
  console.log(`[source] renderer=${rendererUrl}; server=Node TypeScript source`);
  electron = spawn(require('electron'), [root, ...process.argv.slice(2)], {
    cwd: root, env, stdio: 'inherit', windowsHide: true,
  });
  const exitCode = await new Promise((resolve, reject) => {
    electron.once('error', reject);
    electron.once('exit', (code) => resolve(code ?? 1));
    for (const signal of ['SIGINT', 'SIGTERM', ...(process.platform === 'win32' ? ['SIGBREAK'] : [])]) {
      process.once(signal, () => { void close(0); });
    }
  });
  await close(exitCode);
} catch (error) {
  console.error(`[source] ${error.stack || error.message}`);
  await close(1);
}
