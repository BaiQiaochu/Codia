import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');

function read(relPath: string) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

describe('whatsapp bridge wiring', () => {
  it('SettingsApp mounts the WhatsApp QR overlay', () => {
    const source = read('settings/SettingsApp.tsx');

    expect(source).toContain("WhatsappQrcodeOverlay");
    expect(source).toContain("<WhatsappQrcodeOverlay />");
  });

  it('WhatsApp bridge section opens QR overlay instead of inline web page flow', () => {
    const source = read('settings/tabs/bridge/WhatsappSection.tsx');

    expect(source).toContain("gsap-show-whatsapp-qrcode");
    expect(source).toContain("settings.bridge.whatsappScan");
    expect(source).toContain("settings.bridge.whatsappRescan");
    expect(source).not.toContain('alt="WhatsApp QR"');
  });
});
