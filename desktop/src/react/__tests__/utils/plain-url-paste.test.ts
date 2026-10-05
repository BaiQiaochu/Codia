import { describe, expect, it } from 'vitest';
import { extractPlainUrlPaste } from '../../utils/plain-url-paste';

function clipboard(values: Record<string, string>) {
  return {
    getData(type: string) {
      return values[type] || '';
    },
  };
}

describe('extractPlainUrlPaste', () => {
  it('normalizes a single plain http url', () => {
    const result = extractPlainUrlPaste(clipboard({
      'text/plain': ' https://example.com/path?q=1 ',
    }));

    expect(result).toBe('https://example.com/path?q=1');
  });

  it('prefers text/uri-list urls when present', () => {
    const result = extractPlainUrlPaste(clipboard({
      'text/plain': 'Example link',
      'text/uri-list': '# copied url\nhttps://example.com/article\n',
    }));

    expect(result).toBe('https://example.com/article');
  });

  it('extracts a single rich link whose body is only that link text', () => {
    const result = extractPlainUrlPaste(clipboard({
      'text/plain': 'Example',
      'text/html': '<a href="https://example.com/article">Example</a>',
    }));

    expect(result).toBe('https://example.com/article');
  });

  it('does not collapse rich html that contains extra text', () => {
    const result = extractPlainUrlPaste(clipboard({
      'text/plain': 'Read Example now',
      'text/html': 'Read <a href="https://example.com/article">Example</a> now',
    }));

    expect(result).toBeNull();
  });

  it('ignores non-http urls and multi-word plain text', () => {
    expect(extractPlainUrlPaste(clipboard({ 'text/plain': 'mailto:test@example.com' }))).toBeNull();
    expect(extractPlainUrlPaste(clipboard({ 'text/plain': 'https://example.com one more' }))).toBeNull();
  });
});
