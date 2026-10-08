import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('SessionList hover contract', () => {
  it('uses any-hover policy and keeps keyboard focus controls visible', () => {
    const css = fs.readFileSync(
      path.join(__dirname, '../../components/SessionList.module.css'),
      'utf-8',
    );

    expect(css).not.toMatch(/@media\s*\(hover:\s*hover\)\s*and\s*\(pointer:\s*fine\)/);
    expect(css).toMatch(/@media\s*\(any-hover:\s*hover\)\s*and\s*\(any-pointer:\s*fine\)\s*\{[\s\S]*\.sessionItem:hover\s*\{/);
    expect(css).toMatch(/\.sessionSectionTitle:focus-within \.sectionTitleActions\s*\{[\s\S]*opacity:\s*1/);
    expect(css).toMatch(/\.sessionItemActive ~ \.sessionDeleteBtn/);
  });
});
