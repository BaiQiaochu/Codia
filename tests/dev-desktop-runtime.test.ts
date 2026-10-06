import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveDesktopDevPort } from '../scripts/dev-desktop-runtime.mjs';

describe('local desktop development runtime', () => {
  it('resolves port zero to an OS-assigned port before Vite receives it', async () => {
    const port = await resolveDesktopDevPort('0');
    expect(Number.isInteger(port)).toBe(true);
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThanOrEqual(65535);
  });

  it('preserves an explicit development port', async () => {
    expect(await resolveDesktopDevPort('5174')).toBe(5174);
  });

  it.each(['-1', '65536', 'abc', '1.5'])('rejects invalid port %s', async value => {
    await expect(resolveDesktopDevPort(value)).rejects.toThrow('GSAP_DEV_DESKTOP_PORT');
  });

  it('keeps source startup and explicit local build startup available', () => {
    const { scripts } = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'));
    expect(scripts.start).toBe('node scripts/launch.js electron');
    expect(scripts['start:local']).toBe('npm run build:client && npm run start:built');
    expect(scripts['start:built']).toBe('node scripts/launch.js electron-built');
    expect(scripts.build).toBe('npm run build:client && npm run build:server');
  });

  it('does not reference the removed standalone editor during window shutdown', () => {
    const main = fs.readFileSync(path.resolve('desktop/main.cjs'), 'utf8');
    expect(main).not.toMatch(/\beditorWindow\b/);
    expect(main).toContain('["show", "hide", "minimize", "restore", "close", "closed"]');
  });

  it('launches the desktop GUI without the Windows background-helper hide flag', () => {
    const dev = fs.readFileSync(path.resolve('scripts/dev-desktop.mjs'), 'utf8');
    const built = fs.readFileSync(path.resolve('scripts/launch.js'), 'utf8');
    const devSpawn = dev.slice(dev.indexOf("electron = spawn(require('electron')"), dev.indexOf('const exitCode ='));
    const builtSpawn = built.slice(built.indexOf('const child = spawn(bin'), built.indexOf('child.on('));
    for (const spawn of [devSpawn, builtSpawn]) {
      expect(spawn).toContain('windowsHide: false');
      expect(spawn).not.toContain('windowsHide: true');
    }
    // Console-only cleanup helpers should still be hidden.
    expect(dev).toMatch(/spawn\('taskkill',[\s\S]*?windowsHide: true/);
  });
});
