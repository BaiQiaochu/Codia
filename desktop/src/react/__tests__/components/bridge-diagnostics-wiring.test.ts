import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');

function read(relPath: string) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

function cssRule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{(?<body>[^}]*)\\}`))?.groups?.body || '';
}

describe('bridge diagnostics wiring', () => {
  it('BridgeTab wires the shared diagnostics panel into QQ and reconnect actions', () => {
    const source = read('settings/tabs/BridgeTab.tsx');

    expect(source).toContain('PlatformDiagnostics');
    expect(source).toContain("reconnectPlatform('qq')");
    expect(source).toContain("reconnectPlatform('wechat')");
    expect(source).toContain("reconnectPlatform('whatsapp')");
  });

  it('WeChat and WhatsApp sections render the shared diagnostics panel', () => {
    const wechat = read('settings/tabs/bridge/WechatSection.tsx');
    const whatsapp = read('settings/tabs/bridge/WhatsappSection.tsx');
    const diagnostics = read('settings/tabs/bridge/PlatformDiagnostics.tsx');

    expect(wechat).toContain('<PlatformDiagnostics');
    expect(whatsapp).toContain('<PlatformDiagnostics');
    expect(diagnostics).toContain('settings.bridge.diagTitle');
    expect(diagnostics).toContain('settings.bridge.diagLastSync');
    expect(diagnostics).toContain("t('status.reconnect')");
  });

  it('WeChat section keeps the reply-window delivery reminder visible', () => {
    const wechat = read('settings/tabs/bridge/WechatSection.tsx');
    const styles = read('settings/tabs/BridgeTab.module.css');

    expect(wechat).toContain("t('settings.bridge.wechatReplyWindowReminder')");
    expect(styles).toContain('.wechat-info-reminder');
  });

  it('keeps social platform diagnostics spaced away from panel edges', () => {
    const css = read('mobile/mobile-entry.css');
    const panel = cssRule(css, '.bridge-diagnostics-panel');
    const row = cssRule(css, '.bridge-diagnostics-row');
    const value = cssRule(css, '.bridge-diagnostics-value');
    const mobileValue = css.match(/@media \(max-width: 640px\)\s*\{[\s\S]*?\.bridge-diagnostics-value\s*\{(?<body>[^}]*)\}/)?.groups?.body || '';

    expect(panel).toMatch(/gap:\s*var\(--space-md\)/);
    expect(panel).toMatch(/padding:\s*var\(--space-md\)/);
    expect(row).toMatch(/display:\s*grid/);
    expect(row).toMatch(/padding:\s*8px\s+0/);
    expect(value).toMatch(/overflow-wrap:\s*anywhere/);
    expect(mobileValue).toMatch(/text-align:\s*left/);
  });
});
