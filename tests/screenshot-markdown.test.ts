import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);

describe('screenshot markdown renderer helpers', () => {
  it('resolves relative markdown image paths from the source markdown file', () => {
    const { resolveScreenshotMarkdownImageSrc } = require('../desktop/src/shared/screenshot-markdown.cjs');

    expect(resolveScreenshotMarkdownImageSrc('文本附件/Cover Image.png', {
      sourceFilePath: '/vault/notes/day.md',
    })).toBe('file:///vault/notes/%E6%96%87%E6%9C%AC%E9%99%84%E4%BB%B6/Cover%20Image.png');
  });

  it('renders code articles as escaped preformatted code instead of markdown paragraphs', () => {
    const { renderScreenshotCodeArticle } = require('../desktop/src/shared/screenshot-markdown.cjs');

    expect(renderScreenshotCodeArticle('<div>x</div>', 'html')).toBe(
      '<pre><code class="language-html">&lt;div&gt;x&lt;/div&gt;</code></pre>',
    );
  });

  it('drops unsupported explicit image protocols in screenshot markdown', () => {
    const { resolveScreenshotMarkdownImageSrc } = require('../desktop/src/shared/screenshot-markdown.cjs');

    expect(resolveScreenshotMarkdownImageSrc('javascript:alert(1)', {
      sourceFilePath: '/vault/notes/day.md',
    })).toBe('');
  });

  it('renders markdown cover before article body for screenshots', () => {
    const { renderScreenshotMarkdownArticle } = require('../desktop/src/shared/screenshot-markdown.cjs');
    const md = { render: vi.fn(() => '<h1>Demo</h1>') };
    const html = renderScreenshotMarkdownArticle(md, [
      '---',
      'cover:',
      '  image: 文本附件/cover.png',
      '  displayWidth: 72',
      '  displayHeight: 280',
      '  positionY: 64',
      '---',
      '# Demo',
    ].join('\n'), { sourceFilePath: '/vault/notes/day.md' });

    expect(md.render).toHaveBeenCalledWith('# Demo', { sourceFilePath: '/vault/notes/day.md' });
    expect(html).toContain('class="screenshot-cover"');
    expect(html).toContain('--screenshot-cover-display-width:72%');
    expect(html).toContain('--screenshot-cover-height:280px');
    expect(html).toContain('class="screenshot-cover-frame"');
    expect(html).toContain('object-position:50% 64%');
    expect(html).toContain('file:///vault/notes/%E6%96%87%E6%9C%AC%E9%99%84%E4%BB%B6/cover.png');
  });
});
