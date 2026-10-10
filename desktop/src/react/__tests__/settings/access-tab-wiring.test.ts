import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SETTINGS_ROOT = path.resolve(__dirname, '../..', 'settings');

function read(rel: string) {
  return fs.readFileSync(path.join(SETTINGS_ROOT, rel), 'utf8');
}

describe('settings access tab wiring', () => {
  it('registers AccessTab in content and navigation using Codia API helpers', () => {
    const content = read('SettingsContent.tsx');
    const nav = read('settings-navigation.ts');
    const access = read('tabs/AccessTab.tsx');

    expect(content).toContain("import { AccessTab } from './tabs/AccessTab'");
    expect(content).toContain('access: AccessTab');
    expect(nav).toContain("id: 'access'");
    expect(nav).toContain("key: 'settings.tabs.access'");
    expect(nav).toContain("fallback: '访问与设备'");
    expect(access).toContain("import { codiaFetch, codiaUrl } from '../api'");
    expect(access).toContain("connectDeviceServerConnection");
    expect(access).toContain("persistServerConnectionSelection");
    expect(access).toContain("'/api/access/summary'");
    expect(access).toContain("'/api/access/mobile-credentials'");
    expect(access).toContain("'/api/access/desktop-credentials'");
    expect(access).toContain('settings.access.connectLanServer');
    expect(access).toContain('codia_dev_...');
  });
});
