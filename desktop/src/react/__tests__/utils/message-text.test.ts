/**
 * @vitest-environment jsdom
 */

import { describe, expect, it } from 'vitest';
import { extractTextBlockPlainText } from '../../utils/message-text';

describe('extractTextBlockPlainText', () => {
  it('prefers source text over rendered HTML for assistant copy and speech', () => {
    const text = extractTextBlockPlainText([
      {
        type: 'text',
        source: 'original formula $E=mc^2$',
        html: '<span class="katex-mathml">duplicate</span><span class="katex-html">visual</span>',
      },
    ]);

    expect(text).toBe('original formula $E=mc^2$');
  });

  it('falls back to plain text from legacy HTML blocks', () => {
    const text = extractTextBlockPlainText([
      {
        type: 'text',
        html: '<p><strong>Hello</strong> world</p>',
      },
    ]);

    expect(text).toBe('Hello world');
  });
});
