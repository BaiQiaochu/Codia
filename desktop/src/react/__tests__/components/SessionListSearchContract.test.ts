import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');

function read(rel: string) {
  return readFileSync(path.join(ROOT, rel), 'utf8');
}

describe('SessionList search contract', () => {
  it('keeps session search outside the scrolling list and at 16px on mobile', () => {
    const component = read('components/SessionList.tsx');
    const moduleCss = read('components/SessionList.module.css');
    const appCss = read('../styles.css');
    const mobileCss = read('mobile/mobile-entry.css');

    expect(component).toContain('SessionSearchBox');
    expect(component).toContain('/api/sessions/search');
    expect(component).toContain('styles.sessionListScroller');

    expect(moduleCss).toContain('.sessionSearchBox');
    expect(moduleCss).toContain('.sessionSearchInput');
    expect(moduleCss).toContain(':global(.mobile-desktop-root) .sessionSearchInput');
    expect(moduleCss).toMatch(/font-size:\s*16px/);

    expect(appCss).toMatch(/\.session-list\s*\{[\s\S]*overflow:\s*hidden/);
    expect(mobileCss).toMatch(/\.session-list\s*\{[\s\S]*overflow:\s*hidden/);
  });

  it('keeps permanent session delete available from the session context menu', () => {
    const component = read('components/SessionList.tsx');

    expect(component).toContain('deleteSession');
    expect(component).toContain("t('session.delete')");
    expect(component).toContain("t('session.deleteConfirm')");
    expect(component).toContain('deleteSession(session.path)');
  });

  it('keeps permanent session delete directly available on each session row', () => {
    const component = read('components/SessionList.tsx');
    const moduleCss = read('components/SessionList.module.css');

    expect(component).toContain('handleDelete');
    expect(component).toContain('styles.sessionDeleteBtn');
    expect(component).toContain('deleteSession(s.path)');
    expect(moduleCss).toContain('.sessionDeleteBtn');
    expect(moduleCss).toContain('.sessionItemShell:hover .sessionDeleteBtn');
    expect(moduleCss).toContain('@media (hover: none), (pointer: coarse)');
    expect(moduleCss).toMatch(/@media \(hover: none\), \(pointer: coarse\) \{[\s\S]*\.sessionDeleteBtn[\s\S]*pointer-events:\s*auto/);
  });
});
