import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../../utils/markdown';

function codeBlocks(html: string): string[] {
  return [...html.matchAll(/<pre><code[^>]*>([\s\S]*?)<\/code><\/pre>/g)].map(match => match[1]);
}

describe('renderMarkdown stack trace formatting', () => {
  it('renders consecutive JavaScript stack frames as a copyable code block', () => {
    const html = renderMarkdown([
      'NapCat Shell App Loading...',
      '05-10 00:53:20 [error] [NapCat] [Process] failed: Error: ENOENT: no such file or directory',
      'at Object.openSync (node:fs:561:18)',
      'at Object.readFileSync (node:fs:445:35)',
      'at new QQBasicInfoWrapper (file:///E:/apps/napcat.mjs:61153:51)',
      'at async startWorkerProcess (file:///E:/apps/napcat.mjs:912:7)',
      '05-10 00:53:20 [error] [NapCat] [Fork] Worker process exited with code: 1',
    ].join('\n'));

    const blocks = codeBlocks(html);
    expect(blocks).toHaveLength(1);
    expect(html).toContain('language-text');
    expect(blocks[0]).toContain('at Object.openSync');
    expect(blocks[0]).toContain('at async startWorkerProcess');
    expect(blocks[0]).not.toContain('NapCat Shell App Loading');
    expect(blocks[0]).not.toContain('Worker process exited');
    expect(html).toContain('NapCat Shell App Loading');
    expect(html).toContain('Worker process exited');
  });

  it('does not turn a single stack-like line into a code block', () => {
    const html = renderMarkdown('at Object.openSync (node:fs:561:18)');

    expect(codeBlocks(html)).toHaveLength(0);
    expect(html).toContain('at Object.openSync');
  });

  it('does not rewrap stack frames inside an existing fenced code block', () => {
    const html = renderMarkdown([
      '```js',
      'at Object.openSync (node:fs:561:18)',
      'at Object.readFileSync (node:fs:445:35)',
      '```',
    ].join('\n'));

    expect(codeBlocks(html)).toHaveLength(1);
    expect(html).toContain('language-js');
    expect(html).not.toContain('language-text');
  });
});
