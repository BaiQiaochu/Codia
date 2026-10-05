import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SETTINGS_ROOT = path.resolve(__dirname, '../..', 'settings');

function read(rel: string) {
  return fs.readFileSync(path.join(SETTINGS_ROOT, rel), 'utf8');
}

describe('settings access tab wiring', () => {
  it('registers AccessTab in content and navigation using G-SAP API helpers', () => {
    const content = read('SettingsContent.tsx');
    const nav = read('SettingsNav.tsx');
    const access = read('tabs/AccessTab.tsx');

    expect(content).toContain("import { AccessTab } from './tabs/AccessTab'");
    expect(content).toContain('access: AccessTab');
    expect(content).toContain("access: 'settings.tabs.access'");
    expect(content).toContain("access: '\\u8bbf\\u95ee\\u4e0e\\u8bbe\\u5907'");
    expect(nav).toContain("id: 'access'");
    expect(nav).toContain("key: 'settings.tabs.access'");
    expect(access).toContain("import { gsapFetch, gsapUrl } from '../api'");
    expect(access).toContain("connectDeviceServerConnection");
    expect(access).toContain("persistServerConnectionSelection");
    expect(access).toContain("'/api/access/summary'");
    expect(access).toContain("'/api/access/mobile-credentials'");
    expect(access).toContain("'/api/access/desktop-credentials'");
    expect(access).toContain('settings.access.connectLanServer');
    expect(access).toContain('gsap_dev_...');
  });
});
