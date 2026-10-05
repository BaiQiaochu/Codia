import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');

function read(relPath: string) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

function readJson(relPath: string): unknown {
  return JSON.parse(read(relPath));
}

function getPathValue(data: unknown, keyPath: string): unknown {
  if (data && typeof data === 'object' && keyPath in data) {
    return (data as Record<string, unknown>)[keyPath];
  }

  return keyPath.split('.').reduce<unknown>((current, key) => {
    if (!current || typeof current !== 'object') return undefined;
    return (current as Record<string, unknown>)[key];
  }, data);
}

describe('settings regression wiring', () => {
  it('SettingsContent reloads avatars and settings snapshot after server restart', () => {
    const source = read('settings/SettingsContent.tsx');

    expect(source).toContain("loadAvatars().catch(() => {})");
    expect(source).toContain("loadSettingsSnapshot({ retainSameKeyData: true }).catch(() => {})");
    expect(source).toContain("const serverToken = data.token || store.serverToken");
    expect(source).toContain("refreshLocalServerConnectionState({");
    expect(source).not.toContain("refreshLocalServerConnectionState as refreshLocalServerConnection");
  });

  it('sharing and media tabs keep visible labels behind i18n keys', () => {
    const sharingSource = read('settings/tabs/SharingTab.tsx');
    const mediaDetailSource = read('settings/tabs/media/MediaProviderDetail.tsx');

    expect(sharingSource).toContain("settings.screenshot.saveCurrentPreview");
    expect(mediaDetailSource).toContain("settings.media.default");
    expect(mediaDetailSource).toContain("settings.media.qualityLow");
    expect(mediaDetailSource).toContain("settings.media.qualityMedium");
    expect(mediaDetailSource).toContain("settings.media.qualityHigh");
  });

  it('keeps experiment section descriptions localized in all bundled desktop locales', () => {
    const requiredKey = 'settings.experiments.memorySectionDescription';
    const localeDir = path.join(ROOT, '../locales');
    const localeFiles = fs.readdirSync(localeDir).filter(file => file.endsWith('.json'));

    expect(localeFiles).toEqual(expect.arrayContaining(['zh.json', 'en.json', 'zh-TW.json', 'ja.json', 'ko.json']));
    for (const file of localeFiles) {
      const value = getPathValue(readJson(path.join('../locales', file)), requiredKey);
      expect(value, `${file} should define ${requiredKey}`).toEqual(expect.any(String));
      expect(String(value).trim()).not.toBe('');
      expect(value).not.toBe(requiredKey);
    }
  });

  it('keeps channel, timeline and shared fallback labels localized in all bundled desktop locales', () => {
    const requiredKeys = [
      'channel.taskTree',
      'channel.clearTaskTree',
      'channel.companyUnavailable',
      'channel.unassigned',
      'chat.timeline.navAriaLabel',
      'chat.timeline.jumpTo',
      'common.error',
      'common.refresh',
    ];
    const localeFiles = ['zh.json', 'en.json', 'zh-TW.json', 'ja.json', 'ko.json'];

    for (const file of localeFiles) {
      const localeData = readJson(path.join('../locales', file));
      for (const key of requiredKeys) {
        const value = getPathValue(localeData, key);
        expect(value, `${file} should define ${key}`).toEqual(expect.any(String));
        expect(String(value).trim()).not.toBe('');
        expect(value).not.toBe(key);
      }
    }
  });
});
