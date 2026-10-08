// Run with the existing Electron executable after the --build-only fixture step.
// Uses normal sandbox/GPU policy and a fresh isolated profile; starts no server.
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const args = process.argv.slice(2);
const profileIndex = args.indexOf('--profile');
const profile = profileIndex < 0 ? fs.mkdtempSync(path.join(os.tmpdir(), 'codia-live2d-')) : path.resolve(args[profileIndex + 1]);
fs.mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 1188, height: 900, title: 'Codia Live2D standalone fixture',
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  window.webContents.on('did-fail-load', (_event, code, message) => console.error('Fixture load failure:', code, message));
  await window.loadFile(fileURLToPath(new URL('../.local-tools/live2d/react-fixture/index.html', import.meta.url)));
  console.log('Standalone fixture loaded from file://. Fresh profile:', profile);
});
app.on('window-all-closed', () => app.quit());
