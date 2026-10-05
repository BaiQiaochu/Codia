import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');

function read(rel: string) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

describe('PWA login gate wiring', () => {
  it('wraps the main app and only gates web/PWA platform', () => {
    const main = read('../main.tsx');
    const gate = read('components/PwaLoginGate.tsx');
    const auth = read('pwa-auth.ts');

    expect(main).toContain('<PwaLoginGate>');
    expect(gate).toContain("platform === 'web'");
    expect(gate).toContain("Promise.resolve(typeof window.platform?.getPlatform === 'function' ? window.platform.getPlatform() : 'web')");
    expect(gate).toContain("mode === 'accessKey'");
    expect(gate).toContain("mode === 'password'");
    expect(gate).toContain('loginPwa({ mode, accessKey: accessKey.trim(), username: username.trim(), password })');
    expect(auth).toContain("fetch('/api/web-auth/session'");
    expect(auth).toContain("fetch('/api/web-auth/login'");
    expect(auth).toContain("credentials: 'same-origin'");
    expect(auth).toContain("legacyValidatePwaSession");
  });
});
