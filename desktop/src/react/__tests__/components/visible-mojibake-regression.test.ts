import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');

const VISIBLE_SETTINGS_FILES = [
  'settings/SettingsContent.tsx',
  'settings/tabs/AgentTab.tsx',
  'settings/tabs/MediaTab.tsx',
  'settings/tabs/agent/AgentToolsSection.tsx',
  'settings/tabs/providers/ProviderDetail.tsx',
  'settings/tabs/providers/ProviderModelList.tsx',
];

const MOJIBAKE_MARKERS = [
  String.fromCodePoint(0x922b),
  String.fromCodePoint(0x9225),
  String.fromCodePoint(0x95b8),
  String.fromCodePoint(0x95ba),
  String.fromCodePoint(0x5a34),
  String.fromCodePoint(0x6d93),
  String.fromCodePoint(0x6fe1),
  String.fromCodePoint(0x7efe),
  String.fromCodePoint(0x20ac),
  '\uFFFD',
];

function read(relPath: string) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

function stripComments(source: string) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function decodeUnicodeEscapes(source: string) {
  return source.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) =>
    String.fromCharCode(parseInt(hex, 16)));
}

describe('visible mojibake regression coverage', () => {
  it('keeps visible settings text readable', () => {
    const combined = stripComments(VISIBLE_SETTINGS_FILES.map(read).join('\n'));
    const readableCombined = decodeUnicodeEscapes(combined);

    for (const marker of MOJIBAKE_MARKERS) {
      expect(combined).not.toContain(marker);
    }

    expect(readableCombined).toContain('提示词模板工具');
    expect(readableCombined).toContain('模板预览');
    expect(readableCombined).toContain('默认转写模型');
    expect(readableCombined).toContain('全部');
    expect(readableCombined).toContain('MiniMax Token Plan 使用订阅计划 Key');
  });
});
