import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');

function read(relPath: string) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

describe('message actions alignment', () => {
  it('UserMessage puts actions into the right-aligned footer row', () => {
    const userSource = read('components/chat/UserMessage.tsx');

    expect(userSource).toMatch(/<MessageFooterActions[\s\S]*align="right"/);
    expect(userSource).toMatch(/leadingActions=\{footerActions\}/);
    expect(userSource).toMatch(/actions=\{messageActions\}/);
  });

  it('MessageActions delegates to footer alignment instead of floating msgActions styles', () => {
    const actionsSource = read('components/chat/MessageActions.tsx');
    const styleSource = read('components/chat/Chat.module.css');

    expect(actionsSource).toMatch(/align\?:\s*'left'\s*\|\s*'right'/);
    expect(actionsSource).toMatch(/<MessageFooterActions[\s\S]*align=\{align\}/);
    expect(styleSource).toMatch(/\.messageFooterActionsLeft\s*\{/);
    expect(styleSource).not.toMatch(/\.msgActionsLeft\s*\{/);
  });
});
