import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function readResourceCss(): string {
  return fs.readFileSync(
    path.join(process.cwd(), 'desktop/src/react/components/chat/ChatResourceCard.module.css'),
    'utf8',
  );
}

function cssRule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return css.match(new RegExp(`${escaped}\\s*\\{(?<body>[^}]*)\\}`))?.groups?.body || '';
}

describe('ChatResourceCard layout', () => {
  it('keeps shared resource cards capped, clipped, and action-safe', () => {
    const css = readResourceCss();
    const card = cssRule(css, '.card');
    const title = cssRule(css, '.title');
    const subtitle = cssRule(css, '.subtitle');
    const actions = cssRule(css, '.actions');

    expect(card).toMatch(/--chat-resource-card-width:\s*clamp\(320px,\s*60%,\s*640px\)/);
    expect(card).toMatch(/width:\s*var\(--chat-resource-card-width\)/);
    expect(card).toMatch(/max-width:\s*100%/);
    expect(title).toMatch(/text-overflow:\s*ellipsis/);
    expect(subtitle).toMatch(/text-overflow:\s*ellipsis/);
    expect(actions).toMatch(/max-width:\s*36%/);
  });

  it('marks interactive resource cards with pointer cursor affordance', () => {
    const css = readResourceCss();
    const interactiveButton = cssRule(css, '.interactive button.main');

    expect(interactiveButton).toMatch(/cursor:\s*pointer/);
  });
});
