import { describe, expect, it } from 'vitest';
import { extractMarkdownHeadings } from '../../utils/markdown-document';

describe('markdown document utilities', () => {
  it('ignores cover frontmatter when extracting headings', () => {
    const headings = extractMarkdownHeadings([
      '---',
      'cover:',
      '  image: 文本附件/cover.png',
      '  displayHeight: 320',
      '  positionY: 50',
      '---',
      '# 正文标题',
      '',
      'Body',
    ].join('\n'));

    expect(headings.map(heading => heading.text)).toEqual(['正文标题']);
  });
});
