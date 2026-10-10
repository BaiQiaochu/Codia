import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

function read(relativePath: string): string {
  return readFileSync(path.join(root, 'desktop/src/react', relativePath), 'utf8');
}

function extractRule(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = css.indexOf('\n}', start);
  expect(end).toBeGreaterThan(start);
  return css.slice(start, end + 2);
}

describe('Agent create overlay theme contract', () => {
  it('uses a Codia themed modal layout without cloning the original theme surface', () => {
    const css = read('settings/Settings.module.css');
    const source = read('settings/overlays/AgentCreateOverlay.tsx');
    const overlayRule = extractRule(css, '.agent-create-overlay');
    const cardRule = extractRule(css, '.agent-create-card');

    expect(css).toContain('--agent-create-content-width');
    expect(css).toContain('--agent-create-accent-soft');
    expect(css).toContain('.agent-create-card :global(.yuan-chips)');
    expect(css).toContain('.agent-create-card :global(.yuan-chip.selected)');
    expect(css).toContain('width: min(640px, calc(100vw - 48px))');
    expect(css).toContain('backdrop-filter: blur(10px)');
    expect(css).toContain('color-mix(in srgb, var(--accent) 12%, var(--bg-card))');
    expect(css).toContain('box-shadow: 0 22px 60px color-mix(in srgb, var(--shadow) 62%, transparent)');
    expect(overlayRule).not.toContain('background: rgba(0, 0, 0, 0.35)');
    expect(cardRule).not.toContain('width: 620px;');
    expect(cardRule).not.toContain('box-shadow: 0 12px 48px var(--shadow)');
    expect(source).toContain('entries.map(([key, meta])');
    expect(source).not.toContain("entries.filter(([key]) => key === 'kong')");
    expect(source).not.toContain("entries.filter(([key]) => key !== 'kong')");
    expect(source).toMatch(/codia/i);
  });
});
