/**
 * @vitest-environment jsdom
 */

import { describe, expect, it } from 'vitest';
import { renderMarkdown, renderMarkdownPreview, resolveMarkdownImageSrc } from '../../utils/markdown';

describe('renderMarkdown Obsidian and Mermaid compatibility', () => {
  it('renders Obsidian callouts from blockquote syntax', () => {
    const html = renderMarkdown([
      '> [!warning] Careful',
      '> First **line**.',
    ].join('\n'));

    expect(html).toContain('class="markdown-callout markdown-callout-warning"');
    expect(html).toContain('<div class="markdown-callout-title">Careful</div>');
    expect(html).toContain('<strong>line</strong>');
    expect(html).not.toContain('[!warning]');
    expect(html).not.toContain('<blockquote>');
  });

  it('keeps foldable callouts and generated classes in preview mode', () => {
    const html = renderMarkdownPreview([
      '> [!faq]- Can fold?',
      '> Yes.',
    ].join('\n'));

    expect(html).toContain('<details class="markdown-callout markdown-callout-question">');
    expect(html).toContain('<summary class="markdown-callout-title">Can fold?</summary>');
    expect(html).toContain('<p>Yes.</p>');
    expect(html).not.toContain('[!faq]');
  });

  it('marks mermaid fenced code blocks as renderable diagram placeholders', () => {
    const html = renderMarkdown([
      '```mermaid',
      'graph TD',
      '  A-->B',
      '```',
    ].join('\n'));

    expect(html).toContain('class="mermaid-diagram"');
    expect(html).toContain('class="mermaid-source"');
    expect(html).toContain('class="mermaid-rendered"');
    expect(html).toContain('graph TD');
    expect(html).not.toContain('<code class="language-mermaid"');
  });

  it('keeps Chinese punctuation outside auto-linkified URLs', () => {
    const html = renderMarkdown('参考 https://example.com/docs。');

    expect(html).toContain('<a href="https://example.com/docs">https://example.com/docs</a>。');
    expect(html).not.toContain('docs%E3%80%82');
  });

  it('keeps markdown images in preview mode and resolves local Windows paths through file URLs', () => {
    const fileUrl = (filePath: string) => `file:///${filePath.replace(/\\/g, '/')}`;

    expect(resolveMarkdownImageSrc('E:/docs/preset-cover.png', {
      filePath: 'E:/docs/note.md',
      getFileUrl: fileUrl,
    })).toBe('file:///E:/docs/preset-cover.png');

    const html = renderMarkdownPreview('![方案图](文本附件/cover.png)', {
      filePath: 'E:/docs/note.md',
      getFileUrl: fileUrl,
    });

    expect(html).toContain('<img');
    expect(html).toContain('src="file:///E:/docs/文本附件/cover.png"');
    expect(html).toContain('alt="方案图"');
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('decoding="async"');
  });

  it('renders markdown footnotes with clickable refs and backrefs', () => {
    const html = renderMarkdown([
      '正文引用[^main]。',
      '',
      '[^main]: 脚注 **正文**。',
    ].join('\n'));

    const refMatch = html.match(
      /<sup class="footnote-ref"><a href="#(?<footnoteId>fn-gsap-fn-[a-z0-9]+-1)" id="(?<refId>fnref-gsap-fn-[a-z0-9]+-1)" role="doc-noteref">1<\/a><\/sup>/,
    );

    expect(refMatch?.groups?.footnoteId).toBeTruthy();
    expect(refMatch?.groups?.refId).toBeTruthy();
    expect(html).toContain(`<li id="${refMatch?.groups?.footnoteId}">`);
    expect(html).toContain('脚注 <strong>正文</strong>。');
    expect(html).toContain(
      `<a href="#${refMatch?.groups?.refId}" class="footnote-backref" role="doc-backlink" title="Jump back to reference">&#8617;</a>`,
    );
    expect(html).not.toContain('[^main]:');
  });

  it('preserves safe generated footnote markup in markdown preview mode', () => {
    const html = renderMarkdownPreview([
      '正文引用[^safe]。',
      '',
      '[^safe]: 预览脚注。',
    ].join('\n'));

    expect(html).toMatch(/<section class="footnotes" role="doc-endnotes">/);
    expect(html).toMatch(/<sup class="footnote-ref"><a href="#fn-gsap-fn-[a-z0-9]+-1" id="fnref-gsap-fn-[a-z0-9]+-1" role="doc-noteref" rel="noopener noreferrer">1<\/a><\/sup>/);
    expect(html).toMatch(/<li id="fn-gsap-fn-[a-z0-9]+-1">/);
    expect(html).toMatch(/<a href="#fnref-gsap-fn-[a-z0-9]+-1" class="footnote-backref" role="doc-backlink" title="Jump back to reference" rel="noopener noreferrer">(?:↩|&#8617;)<\/a>/);
  });

  it('strips unsafe raw footnote ids classes and roles in markdown preview mode', () => {
    const html = renderMarkdownPreview([
      '<section class="footnotes evil" role="doc-endnotes">',
      '<ol><li id="fn-gsap-fn-abc-1" role="button">',
      '<a id="fnref-gsap-fn-abc-1" href="#fn-gsap-fn-abc-1" class="footnote-backref evil" role="doc-backlink">back</a>',
      '</li></ol></section>',
    ].join(''));

    expect(html).toContain('<section class="footnotes" role="doc-endnotes">');
    expect(html).toContain('<li id="fn-gsap-fn-abc-1">');
    expect(html).toContain('class="footnote-backref"');
    expect(html).toContain('role="doc-backlink"');
    expect(html).not.toContain('evil');
    expect(html).not.toContain('role="button"');
  });
});
