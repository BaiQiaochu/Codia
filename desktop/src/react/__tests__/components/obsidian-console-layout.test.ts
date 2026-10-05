import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');

function read(relPath: string) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

function extractRule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\n\\}`, 'm').exec(css);
  return match?.[1] || '';
}

describe('console layout after reader removal', () => {
  it('keeps the normal local terminal layout without reader runtime wiring', () => {
    const css = read('../../src/styles.css');
    const app = read('App.tsx');
    const tokens = extractRule(css, 'html[data-app-view-mode="obsidian"]');
    const baseRule = extractRule(css, '.bottom-console');
    const collapsedRuleBase = extractRule(css, '.bottom-console.collapsed');
    const headerRule = extractRule(css, '.bottom-console-header');
    const consoleToggleRule = extractRule(css, '.tb-console-toggle.active::after');

    expect(tokens).not.toContain('--ide-activity-bar-width');
    expect(baseRule).toContain('top: auto;');
    expect(baseRule).toContain('bottom: 0;');
    expect(collapsedRuleBase).toContain('display: none;');
    expect(headerRule).toContain('border-radius: 9px 9px 0 0;');
    expect(css).toMatch(/\.bottom-console-header-actions\s*\{\s*margin-left:\s*auto;[\s\S]*display:\s*flex;/);
    expect(consoleToggleRule).toContain('bottom: 3px;');
    expect(css).not.toContain('body.obsidian-mode .bottom-console');
    expect(css).not.toContain('--ide-activity-bar-width');
    expect(app).not.toContain('<BottomConsole');
    expect(app).not.toContain('tb-console-toggle');
    expect(app).not.toContain('{!ideMode && <BottomConsole');
    expect(app).not.toContain("if (ideMode) setBottomConsoleOpen(true);");
    expect(app).not.toContain('obsidian-sidebar-collapsed');
    expect(app).not.toContain('readerMode');
  });
});
