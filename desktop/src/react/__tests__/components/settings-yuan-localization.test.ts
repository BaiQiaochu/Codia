import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');

function read(relPath: string) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

function locale(relPath: string) {
  return JSON.parse(read(relPath)) as {
    yuan?: {
      types?: Record<string, { name?: string; label?: string; avatar?: string }>;
    };
  };
}

describe('settings yuan localization', () => {
  it('renders yuan option names from locale metadata instead of hardcoded English labels', () => {
    const source = read('settings/tabs/agent/YuanSelector.tsx');
    expect(source).not.toContain('Codia Balance');
    expect(source).not.toContain('Codia Emotional');
    expect(source).not.toContain('Codia Rational');
    expect(source).toContain('meta.name');
  });

  it('keeps zh yuan option text localized and functionally neutral', () => {
    const types = locale('../locales/zh.json').yuan?.types || {};
    expect(types.codia?.name).toBe('均衡');
    expect(types.butter?.name).toBe('情感');
    expect(types.ming?.name).toBe('理性');
    expect(types.kong?.name).toBe('原始');
    expect(types.hermes).toBeUndefined();
    expect(types.codia?.label).not.toBe('Codia Balance');
    expect(types.butter?.label).not.toBe('Codia Emotional');
    expect(types.ming?.label).not.toBe('Codia Rational');
  });
});
