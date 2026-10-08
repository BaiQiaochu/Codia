import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import YAML from 'js-yaml';
import { createIsolatedE2EHome, getAvailablePort, startMockOpenAI } from './e2e-env.mjs';

// Visual checks must never inherit the user's development profile or model setup.
export async function startIsolatedVisualRuntime(root, mockOptions = {}) {
  const mock = await startMockOpenAI({ reply: 'Codia local visual check.', ...mockOptions });
  const home = createIsolatedE2EHome({ mockBaseUrl: mock.baseUrl });
  const workspace = path.join(home, 'visual-workspace');
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, 'readme.md'), '# Codia visual fixture\n');
  const configPath = path.join(home, 'agents', 'gsap', 'config.yaml');
  const config = YAML.load(fs.readFileSync(configPath, 'utf8'));
  config.desk.home_folder = workspace;
  fs.writeFileSync(configPath, YAML.dump(config));
  const port = await getAvailablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['scripts/dev-web.js'], {
    cwd: root,
    env: {
      ...process.env,
      GSAP_HOME: home,
      GSAP_DEV_HOME: home,
      GSAP_PORT: '0',
      GSAP_E2E: '1',
      GSAP_DEV_WEB_CLIENT_PORT: String(port),
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  let processError;
  child.on('error', error => { processError = error; });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', chunk => { logs = (logs + String(chunk)).slice(-80_000); });
  }
  async function close() {
    if (child.pid && child.exitCode === null) {
      if (process.platform === 'win32') {
        try { execFileSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { windowsHide: true, stdio: 'ignore' }); } catch {}
      } else {
        child.kill('SIGTERM');
      }
    }
    await mock.close();
    // Keep the isolated profile for failure diagnosis; never touch user profiles.
  }
  try {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      if (processError) throw processError;
      if (child.exitCode !== null) throw new Error(`Visual runtime exited (${child.exitCode})`);
      try {
        const info = JSON.parse(fs.readFileSync(path.join(home, 'server-info.json'), 'utf8'));
        const response = await fetch(`${baseUrl}/index.html`, { signal: AbortSignal.timeout(1500) });
        if (response.ok && info.token) {
          return { baseUrl, token: info.token, home, mock, close, logs: () => logs };
        }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error('Isolated visual runtime startup timed out');
  } catch (error) {
    await close();
    throw new Error(`${error.message}\n${logs.slice(-6000)}`);
  }
}
