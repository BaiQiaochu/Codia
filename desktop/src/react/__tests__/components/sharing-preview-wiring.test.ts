import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');

function read(relPath: string) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

describe('sharing preview wiring', () => {
  it('SharingTab calls the saveScreenshotPreview preload bridge', () => {
    const source = read('settings/tabs/SharingTab.tsx');

    expect(source).toContain('saveScreenshotPreview');
    expect(source).toContain("common.screenshotFailed");
  });

  it('SharingTab exposes the screenshot segmentation setting without legacy branding', () => {
    const source = read('settings/tabs/SharingTab.tsx');

    expect(source).toContain('SCREENSHOT_SEGMENT_VISIBLE_CHAR_LIMIT_STORAGE_KEY');
    expect(source).toContain("settings.screenshot.segmentTitle");
    expect(source).toContain("codia-screenshot-width");
    expect(source).toContain("settings.screenshot.codia");
    expect(source).toContain("codia-mobile");
    expect(source).toContain("codia-desktop");
    expect(source).toContain("codia-screenshot");
  });

  it('wires screenshot sharing to the Codia brand theme assets', () => {
    const extractSource = read('utils/screenshot-extract.ts');
    const screenshotSource = read('utils/screenshot.ts');
    const sharingSource = read('settings/tabs/SharingTab.tsx');
    const mainSource = fs.readFileSync(
      path.resolve(ROOT, '..', '..', 'main.cjs'),
      'utf8',
    );

    expect(extractSource).toContain("'codia-brand'");
    expect(extractSource).toContain("'codia-brand-desktop'");
    expect(screenshotSource).toContain("localStorage.getItem('codia-screenshot-color') || 'codia'");
    expect(sharingSource).toContain("stored === 'codia' ? stored : 'codia'");
    expect(mainSource).toContain('"codia-brand"');
    expect(mainSource).toContain('"codia-brand-desktop"');
    expect(fs.existsSync(path.resolve(ROOT, '..', 'screenshot-themes', 'codia-brand.css'))).toBe(true);
    expect(fs.existsSync(path.resolve(ROOT, '..', 'screenshot-themes', 'codia-brand-desktop.css'))).toBe(true);
  });

  it('SharingTab keeps API call examples out of the settings UI', () => {
    const source = read('settings/tabs/SharingTab.tsx');

    expect(source).not.toContain("import { codiaFetch }");
    expect(source).not.toContain("/api/preferences/web-access");
    expect(source).not.toContain("generateWebApiKey");
    expect(source).not.toContain("revokeWebApiKey");
    expect(source).not.toContain("settings.webAccess.documentationTitle");
    expect(source).not.toContain("curl -H");
    expect(source).not.toContain("fetch(");
    expect(source).not.toContain("/ws?");
  });

  it('preload exposes save-screenshot-preview to window.codia', () => {
    const preload = fs.readFileSync(
      path.resolve(ROOT, '..', '..', 'preload.cjs'),
      'utf8',
    );

    expect(preload).toContain('saveScreenshotPreview');
    expect(preload).toContain('save-screenshot-preview');
  });
});
