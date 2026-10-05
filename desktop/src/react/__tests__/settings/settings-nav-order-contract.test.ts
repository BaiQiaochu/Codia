import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const settingsNavPath = path.resolve(__dirname, '../../settings/SettingsNav.tsx');

function readSettingsNav() {
  return fs.readFileSync(settingsNavPath, 'utf8');
}

function extractNativeTabIds(source: string): string[] {
  const tabItemsMatch = source.match(/const TAB_ITEMS = \[([\s\S]*?)\];/);
  if (!tabItemsMatch) return [];
  return Array.from(tabItemsMatch[1].matchAll(/\{\s*id: '([^']+)'/g), match => match[1]);
}

describe('settings navigation order contract', () => {
  it('keeps original OpenHanako settings entries in their original relative groups', () => {
    const ids = extractNativeTabIds(readSettingsNav());
    const originalOrder = [
      'agent',
      'me',
      'interface',
      'general',
      'browser',
      'work',
      'skills',
      'bridge',
      'providers',
      'media',
      'sharing',
      'access',
      'plugins',
      'experiments',
      'security',
      'about',
    ];

    expect(ids.filter(id => originalOrder.includes(id))).toEqual(originalOrder);
  });

  it('places professional operations settings beside their closest native settings area', () => {
    const ids = extractNativeTabIds(readSettingsNav());

    expect(ids).not.toContain('search');
    expect(ids).not.toContain('computer');
    expect(ids).not.toContain('license');
    expect(ids.indexOf('diagnostics')).toBeGreaterThan(ids.indexOf('security'));
    expect(ids[ids.length - 1]).toBe('about');
  });
});
