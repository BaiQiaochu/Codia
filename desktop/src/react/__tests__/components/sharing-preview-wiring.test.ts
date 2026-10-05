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
    expect(source).toContain("gsap-screenshot-width");
    expect(source).toContain("settings.screenshot.gsap");
    expect(source).toContain("gsap-mobile");
    expect(source).toContain("gsap-desktop");
    expect(source).not.toContain("hana-screenshot");
  });

  it('wires screenshot sharing to the G-SAP brand theme assets', () => {
    const extractSource = read('utils/screenshot-extract.ts');
    const screenshotSource = read('utils/screenshot.ts');
    const sharingSource = read('settings/tabs/SharingTab.tsx');
    const mainSource = fs.readFileSync(
      path.resolve(ROOT, '..', '..', 'main.cjs'),
      'utf8',
    );

    expect(extractSource).toContain("'gsap-brand'");
    expect(extractSource).toContain("'gsap-brand-desktop'");
    expect(screenshotSource).toContain("localStorage.getItem('gsap-screenshot-color') || 'gsap'");
    expect(sharingSource).toContain("stored === 'gsap' ? stored : 'gsap'");
    expect(mainSource).toContain('"gsap-brand"');
    expect(mainSource).toContain('"gsap-brand-desktop"');
    expect(fs.existsSync(path.resolve(ROOT, '..', 'screenshot-themes', 'gsap-brand.css'))).toBe(true);
    expect(fs.existsSync(path.resolve(ROOT, '..', 'screenshot-themes', 'gsap-brand-desktop.css'))).toBe(true);
  });

  it('SharingTab keeps API call examples out of the settings UI', () => {
    const source = read('settings/tabs/SharingTab.tsx');

    expect(source).not.toContain("import { gsapFetch }");
    expect(source).not.toContain("/api/preferences/web-access");
    expect(source).not.toContain("generateWebApiKey");
    expect(source).not.toContain("revokeWebApiKey");
    expect(source).not.toContain("settings.webAccess.documentationTitle");
    expect(source).not.toContain("curl -H");
    expect(source).not.toContain("fetch(");
    expect(source).not.toContain("/ws?");
  });

  it('preload exposes save-screenshot-preview to window.gsap', () => {
    const preload = fs.readFileSync(
      path.resolve(ROOT, '..', '..', 'preload.cjs'),
      'utf8',
    );

    expect(preload).toContain('saveScreenshotPreview');
    expect(preload).toContain('save-screenshot-preview');
  });
});
