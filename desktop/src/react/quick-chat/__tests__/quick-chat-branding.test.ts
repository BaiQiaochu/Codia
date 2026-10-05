import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SOURCE = path.resolve(__dirname, '../QuickChatApp.tsx');

describe('quick chat branding boundary', () => {
  it('uses the G-SAP preload API before the legacy compatibility alias', () => {
    const source = fs.readFileSync(SOURCE, 'utf-8');

    expect(source).toContain('return window.gsap || window.platform || window.hana || null');
    expect(source).not.toMatch(/window\.hana\?\./);
  });
});
