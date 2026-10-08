/**
 * @vitest-environment jsdom
 */

import { describe, expect, it } from 'vitest';
import { renderMarkdown, renderMarkdownPreview } from '../../utils/markdown';

describe('renderMarkdownPreview', () => {
  it('adds stable heading ids and preserves them through sanitization', () => {
    const html = renderMarkdownPreview([
      '# Overview',
      '',
      '## Same Title',
      '',
      '## Same Title',
    ].join('\n'));

    expect(html).toContain('<h1 id="overview">Overview</h1>');
    expect(html).toContain('<h2 id="same-title">Same Title</h2>');
    expect(html).toContain('<h2 id="same-title-1">Same Title</h2>');
  });

  it('keeps local file names from becoming auto-linkified domains', () => {
    const html = renderMarkdown('See README.md, package.json, ./docs/ARCHITECTURE.md and C:\\work\\config.ts');
    const previewHtml = renderMarkdownPreview('See README.md, package.json and ./docs/ARCHITECTURE.md');

    expect(html).toContain('README.md');
    expect(html).toContain('package.json');
    expect(html).toContain('./docs/ARCHITECTURE.md');
    expect(html).toContain('C:\\work\\config.ts');
    expect(html).not.toContain('<a ');
    expect(previewHtml).not.toContain('<a ');
  });

  it('keeps normal fuzzy links and explicit markdown file labels clickable', () => {
    const html = renderMarkdown('Visit openai.com, www.example.com and [README.md](https://example.com/readme)');

    expect(html).toContain('<a href="http://openai.com">openai.com</a>');
    expect(html).toContain('<a href="http://www.example.com">www.example.com</a>');
    expect(html).toContain('<a href="https://example.com/readme">README.md</a>');
  });
});
