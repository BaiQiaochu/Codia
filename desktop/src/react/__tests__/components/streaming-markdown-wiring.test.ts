import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), 'desktop/src/react', relativePath), 'utf8');
}

describe('streaming markdown wiring', () => {
  it('routes active assistant text blocks through progressive markdown rendering', () => {
    const source = read('components/chat/AssistantMessage.tsx');
    const css = read('components/chat/Chat.module.css');
    const markdownContent = read('components/chat/MarkdownContent.tsx');
    const streamBuffer = read('hooks/use-stream-buffer.ts');
    const sessionActions = read('stores/session-actions.ts');
    const chatTypes = read('stores/chat-types.ts');

    expect(source).toContain("import { StreamingMarkdownContent } from './StreamingMarkdownContent'");
    expect(source).toContain('isStreaming }:');
    expect(source).toContain('<StreamingMarkdownContent html={block.html} source={block.source} active={isStreaming}');
    expect(markdownContent).toContain('tailFadeCount');
    expect(streamBuffer).toContain("source: segment.text");
    expect(sessionActions).toContain("source: segment.text");
    expect(chatTypes).toContain("source?: string");
    expect(css).toContain('.streamTailChar');
    expect(css).toContain('@keyframes stream-tail-fade');
  });
});
