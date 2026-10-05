import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../../..');

function cssBlock(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`));
  return match?.[1] || '';
}

describe('channel scroll styles', () => {
  it('keeps channel message auto-scroll immediate for rapid incoming messages', () => {
    const styles = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
    const block = cssBlock(styles, '.channel-messages');

    expect(block).not.toMatch(/scroll-behavior\s*:\s*smooth/);
  });
});
