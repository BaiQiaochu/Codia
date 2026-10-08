// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChapterRail } from '../../components/preview/MarkdownChrome';

function readMarkdownChromeSource(): string {
  return fs.readFileSync(
    path.join(process.cwd(), 'desktop/src/react/components/preview/MarkdownChrome.tsx'),
    'utf8',
  );
}

function readMarkdownChromeCss(): string {
  return fs.readFileSync(
    path.join(process.cwd(), 'desktop/src/react/components/preview/MarkdownChrome.module.css'),
    'utf8',
  );
}

function readTimelineRailCss(): string {
  return fs.readFileSync(
    path.join(process.cwd(), 'desktop/src/react/components/shared/TimelineRailNavigator.module.css'),
    'utf8',
  );
}

describe('MarkdownChrome chapter rail layout', () => {
  afterEach(() => cleanup());

  it('uses the shared timeline rail component instead of a private chapter popover', () => {
    const source = readMarkdownChromeSource();
    const css = readMarkdownChromeCss();

    expect(source).toContain('TimelineRailNavigator');
    expect(source).toContain('measureTimelineMarkerWidthEm');
    expect(source).not.toContain('chapterTrigger');
    expect(source).not.toContain('chapterPopover');
    expect(css).not.toContain('.chapterTrigger');
    expect(css).not.toContain('.chapterPopover');
  });

  it('renders timeline rail markers with the same line/label structure as chat', () => {
    render(
      <ChapterRail
        headings={[
          { id: 'short', level: 1, text: 'A', line: 0, offset: 0 },
          { id: 'section', level: 2, text: 'Section', line: 4, offset: 72 },
          { id: 'long', level: 3, text: 'A much longer heading for marker width', line: 8, offset: 120 },
        ]}
        activeHeadingId="long"
        railVisible
        onJump={vi.fn()}
      />,
    );

    const nav = screen.getByRole('navigation', { name: 'Markdown sections' });
    expect(nav.className).toContain('timelineNav');
    expect(nav.className).toContain('timelineNavLeft');
    expect(nav.className).toContain('timelineNavVisible');
    expect(screen.getByRole('button', { name: 'Jump to A' }).querySelector('[class*="timelineLine"]')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Jump to A much longer heading for marker width' }).className).toContain('timelineMarkerActive');
    expect(screen.getAllByText(/A|Section|A much longer heading/)).toHaveLength(3);
  });

  it('applies Markdown heading hierarchy indentation and longer markers only through rail item variables', () => {
    render(
      <ChapterRail
        headings={[
          { id: 'h1', level: 1, text: 'A', line: 0, offset: 0 },
          { id: 'h2', level: 2, text: 'B', line: 4, offset: 72 },
          { id: 'h3', level: 3, text: 'C', line: 8, offset: 120 },
        ]}
        activeHeadingId="h2"
        railVisible
        onJump={vi.fn()}
      />,
    );

    const h1 = screen.getByRole('button', { name: 'Jump to A' });
    const h2 = screen.getByRole('button', { name: 'Jump to B' });
    const h3 = screen.getByRole('button', { name: 'Jump to C' });

    expect(h1.style.getPropertyValue('--timeline-label-indent')).toBe('0rem');
    expect(h2.style.getPropertyValue('--timeline-label-indent')).toBe('0.875rem');
    expect(h3.style.getPropertyValue('--timeline-label-indent')).toBe('1.75rem');
    expect(h1.style.getPropertyValue('--timeline-marker-width')).toBe('0.75em');
    expect(h1.style.getPropertyValue('--timeline-marker-max-width')).toBe('1.5em');
  });

  it('keeps the rail hidden until the preview hover zone marks it visible', () => {
    render(
      <ChapterRail
        headings={[{ id: 'intro', level: 1, text: 'Intro', line: 0, offset: 0 }]}
        activeHeadingId={null}
        onJump={vi.fn()}
      />,
    );

    expect(screen.getByRole('navigation', { name: 'Markdown sections' }).className).not.toContain('timelineNavVisible');
  });

  it('keeps the rail non-scrollable until the detail card expands', () => {
    const css = readTimelineRailCss();

    expect(css).toMatch(/\.timelineList\s*\{[^}]*overflow-y:\s*hidden;/s);
    expect(css).toMatch(/\.timelineList\s*\{[^}]*scrollbar-width:\s*thin;/s);
    expect(css).toMatch(/\.timelineList::-webkit-scrollbar\s*\{[^}]*width:\s*6px;/s);
    expect(css).toMatch(/\.timelineNavExpanded\s+\.timelineList\s*\{[^}]*scrollbar-width:\s*thin;/s);
    expect(css).toMatch(/\.timelineNavExpanded\s+\.timelineList\s*\{[^}]*overflow-y:\s*hidden;/s);
    expect(css).toMatch(/\.timelineNavExpanded\s+\.timelineList::-webkit-scrollbar\s*\{[^}]*width:\s*0;/s);
  });
});
