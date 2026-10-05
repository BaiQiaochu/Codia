import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');

function read(rel: string) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

describe('main content drop overlay', () => {
  it('uses a stable svg icon instead of mojibake text', () => {
    const source = read('MainContent.tsx');
    const mojibakePaperclip = String.fromCodePoint(0x9983, 0x6438);

    expect(source).not.toContain(mojibakePaperclip);
    expect(source).toContain('className="drop-icon"');
    expect(source).toContain('<svg');
  });

  it('applies welcome-mode class and compact welcome layout rules', () => {
    const source = read('MainContent.tsx');
    const css = fs.readFileSync(path.join(ROOT, '../styles.css'), 'utf8');

    expect(source).toContain("welcomeMode");
    expect(source).toContain("main-content${welcomeMode ? ' welcome-mode' : ''}");
    expect(css).toMatch(/\.main-content\.welcome-mode \.chat-area\s*\{/);
    expect(css).toMatch(/\.main-content\.welcome-mode \.input-area > \*\s*\{/);
    expect(css).toMatch(/--welcome-chat-input-column-width:\s*40rem/);
    expect(source).not.toContain('ReaderSurface');
  });
});
