import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function readProjectFile(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

describe('global focus ring styles', () => {
  it('does not draw visible focus outlines in desktop or mobile entries', () => {
    for (const file of ['desktop/src/styles.css', 'desktop/src/react/mobile/mobile-entry.css']) {
      const css = readProjectFile(file);

      expect(css).toMatch(/:focus,\s*:focus-visible\s*\{[^}]*outline:\s*none\s*!important/);
      expect(css).not.toMatch(/^:focus-visible\s*\{[^}]*outline:\s*2px\s+solid\s+var\(--accent\)/m);
    }
  });
});
