import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const LOCALES_ROOT = path.resolve(__dirname, '../../../locales');
const PROJECT_ROOT = path.resolve(__dirname, '../../../../..');

const REQUIRED_SCREENSHOT_KEYS = [
  'title',
  'desc',
  'color',
  'width',
  'light',
  'dark',
  'sakura',
  'mobile',
  'desktop',
  'mobileTitle',
  'mobileDesc',
  'desktopTitle',
  'desktopDesc',
  'saveCurrentPreview',
  'segmentTitle',
  'segmentLimitLabel',
  'segmentLimitHint',
  'segmentLimitUnit',
];

const REQUIRED_MEDIA_KEYS = [
  'localServiceTitle',
  'localServiceDesc',
  'localServiceEndpoint',
  'localServiceProtocol',
  'localServiceHint',
  'diagnose',
  'diagnoseSuccess',
  'diagnoseFailed',
  'noModelsHint',
  'qualityLow',
  'qualityMedium',
  'qualityHigh',
];

const REQUIRED_WEB_ACCESS_KEYS = [
  'title',
  'desc',
  'empty',
  'generate',
  'regenerate',
  'revoke',
  'generated',
  'generateFailed',
  'revoked',
  'revokeFailed',
  'copied',
  'createdAt',
  'usage',
  'wsUsage',
  'browserTest',
];

const REQUIRED_ACCESS_KEYS = [
  'mobileAccess',
  'lanToggle',
  'lanHint',
  'port',
  'portHint',
  'mobileUrl',
  'mobileUrlLanHint',
  'mobileUrlLocalHint',
  'status',
  'statusHint',
  'restartRequired',
  'runtimeEndpoint',
  'effectiveMobileUrl',
  'lanAddresses',
  'noLanAddresses',
  'qrCode',
  'qrCodeHint',
  'mobileKeys',
  'generateMobileKey',
  'mobileKeyHint',
  'mobileKey',
  'mobileKeyOnce',
  'mobileKeyCreated',
  'mobileKeyFailed',
  'noDevices',
  'revokeCredential',
  'credentialRevoked',
  'credentialRevokeFailed',
  'deviceRevoked',
  'deviceRevokeFailed',
  'revoke',
  'localAccount',
  'username',
  'displayName',
  'saveAccount',
  'accountSaved',
  'password',
  'passwordSet',
  'passwordNotSet',
  'passwordHint',
  'newPassword',
  'savePassword',
  'passwordSaved',
  'clearPassword',
  'passwordCleared',
  'copy',
  'copied',
  'saveNetwork',
  'saved',
  'invalidPort',
  'loadFailed',
];

const REQUIRED_API_KEYS = [
  'visionAuxiliaryToggle',
  'vision',
  'video',
  'reasoning',
];

const REQUIRED_COMMON_KEYS = [
  'loading',
  'regenerate',
];

function readLocale(name: string) {
  return JSON.parse(fs.readFileSync(path.join(LOCALES_ROOT, `${name}.json`), 'utf8'));
}

function collectLocaleStrings(value: unknown, prefix = ''): Array<{ path: string; value: string }> {
  if (typeof value === 'string') return [{ path: prefix || '<root>', value }];
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => (
    collectLocaleStrings(child, prefix ? `${prefix}.${key}` : key)
  ));
}

function collectLocaleKeys(value: unknown, prefix = ''): string[] {
  if (typeof value === 'string') return [prefix || '<root>'];
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => (
    collectLocaleKeys(child, prefix ? `${prefix}.${key}` : key)
  ));
}

describe('settings locale smoke', () => {
  it('lets desktop startup follow the OS locale when no explicit preference is saved', () => {
    const mainSource = fs.readFileSync(path.join(PROJECT_ROOT, 'desktop/main.cjs'), 'utf8');
    const browserI18nSource = fs.readFileSync(path.join(PROJECT_ROOT, 'desktop/src/lib/i18n.ts'), 'utf8');

    expect(mainSource).toContain('app.getLocale()');
    expect(mainSource).toContain('prefs.locale === "system"');
    expect(browserI18nSource).toContain("locale === 'system'");
    expect(browserI18nSource).toContain('navigator.language');
  });

  it('keeps screenshot and media settings keys complete across supported locales', () => {
    for (const localeName of ['zh', 'zh-TW', 'en', 'ja', 'ko']) {
      const locale = readLocale(localeName);
      const screenshot = locale?.settings?.screenshot ?? {};
      const media = locale?.settings?.media ?? {};
      const webAccess = locale?.settings?.webAccess ?? {};
      const access = locale?.settings?.access ?? {};
      const api = locale?.settings?.api ?? {};
      const common = locale?.common ?? {};

      expect(locale?.settings?.tabs?.access, `${localeName}.settings.tabs.access`).toBeTruthy();

      for (const key of REQUIRED_SCREENSHOT_KEYS) {
        expect(screenshot[key], `${localeName}.settings.screenshot.${key}`).toBeTruthy();
      }

      for (const key of REQUIRED_MEDIA_KEYS) {
        expect(media[key], `${localeName}.settings.media.${key}`).toBeTruthy();
      }

      for (const key of REQUIRED_WEB_ACCESS_KEYS) {
        expect(webAccess[key], `${localeName}.settings.webAccess.${key}`).toBeTruthy();
        expect(webAccess[key], `${localeName}.settings.webAccess.${key}`).not.toContain('???');
      }

      for (const key of REQUIRED_ACCESS_KEYS) {
        expect(access[key], `${localeName}.settings.access.${key}`).toBeTruthy();
        expect(access[key], `${localeName}.settings.access.${key}`).not.toContain('???');
      }

      for (const key of REQUIRED_API_KEYS) {
        expect(api[key], `${localeName}.settings.api.${key}`).toBeTruthy();
      }

      for (const key of REQUIRED_COMMON_KEYS) {
        expect(common[key], `${localeName}.common.${key}`).toBeTruthy();
      }

      expect(locale?.appMode?.chat, `${localeName}.appMode.chat`).toBeTruthy();
      expect(locale?.appMode?.reader, `${localeName}.appMode.reader`).toBeUndefined();
      expect(locale?.appMode?.backToChat, `${localeName}.appMode.backToChat`).toBeUndefined();
      expect(locale?.appMode?.coding, `${localeName}.appMode.coding`).toBeUndefined();
      expect(locale?.coding, `${localeName}.coding`).toBeUndefined();
    }
  });

  it('keeps supported locale strings free from visible question-mark mojibake', () => {
    for (const localeName of ['zh', 'zh-TW', 'en', 'ja', 'ko']) {
      const locale = readLocale(localeName);
      for (const entry of collectLocaleStrings(locale)) {
        expect(entry.value, `${localeName}.${entry.path}`).not.toMatch(/\?\?+/);
      }
    }
  });

  it('keeps supported locale key coverage aligned with English', () => {
    const englishKeys = collectLocaleKeys(readLocale('en'));

    for (const localeName of ['zh', 'zh-TW', 'ja', 'ko']) {
      const localeKeys = new Set(collectLocaleKeys(readLocale(localeName)));
      const missingKeys = englishKeys.filter((key) => !localeKeys.has(key));

      expect(missingKeys, `${localeName} missing locale keys`).toEqual([]);
    }
  });

  it('keeps plugin marketplace copy neutral and G-SAP branded', () => {
    const blocked = /original plugin|original marketplace|原版插件|原版市场|原版 marketplace/i;

    for (const localeName of ['zh', 'en']) {
      const plugins = readLocale(localeName)?.settings?.plugins ?? {};
      const marketplaceValues = [
        plugins.marketplaceCount,
        plugins.marketplaceNoSource,
        plugins.marketplaceEmpty,
        plugins.marketLoadError,
        plugins.marketInstall,
        plugins.marketUpdate,
      ];

      for (const value of marketplaceValues) {
        expect(String(value), `${localeName} marketplace copy`).not.toMatch(blocked);
      }
    }
  });
});
