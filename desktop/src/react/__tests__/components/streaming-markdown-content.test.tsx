// @vitest-environment jsdom

import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  StreamingMarkdownContent,
  isTypewriterEligibleMarkdownSource,
} from '../../components/chat/StreamingMarkdownContent';

describe('StreamingMarkdownContent', () => {
  beforeEach(() => {
    window.matchMedia = vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }) as unknown as typeof window.matchMedia;
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('renders active prose through stable markdown-like paragraphs', () => {
    const { container, rerender } = render(
      <StreamingMarkdownContent source="旧正文" html="<p>旧正文</p>" active />,
    );

    const root = container.querySelector('.md-content');
    expect(root?.getAttribute('data-stream-plain-text')).toBe('true');
    expect(root?.querySelector('p')?.textContent).toBe('旧正文');
    expect(root?.querySelector('[data-stream-tail-char="true"]')).toBeNull();

    rerender(
      <StreamingMarkdownContent source="旧正文新正文继续出现" html="<p>旧正文新正文继续出现</p>" active />,
    );

    expect(container.querySelector('.md-content')).toBe(root);
    expect(container.querySelector('p')?.textContent).toBe('旧正文');
  });

  it('matches final markdown paragraph structure while prose is streaming', () => {
    const source = '第一段。\n\n第二段。';
    const html = '<p>第一段。</p>\n<p>第二段。</p>';

    const { container } = render(
      <StreamingMarkdownContent source={source} html={html} active />,
    );

    const paragraphs = Array.from(container.querySelectorAll('.md-content > p'));
    expect(paragraphs.map(p => p.textContent)).toEqual(['第一段。', '第二段。']);
  });

  it('advances small prose backlogs on the 30Hz stream clock', () => {
    vi.useFakeTimers();
    const { container, rerender } = render(
      <StreamingMarkdownContent source="你好" html="<p>你好</p>" active />,
    );

    rerender(
      <StreamingMarkdownContent source="你好世界" html="<p>你好世界</p>" active />,
    );

    expect(container.textContent?.trim()).toBe('你好');

    act(() => {
      vi.advanceTimersByTime(32);
    });
    expect(container.textContent?.trim()).toBe('你好');

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(container.textContent?.trim()).toBe('你好世界');
  });

  it('hard-catches up 80-character prose backlogs without animation debt', () => {
    const source = '开头';
    const largeTarget = `${source}${'一'.repeat(80)}`;
    const { container, rerender } = render(
      <StreamingMarkdownContent source={source} html={`<p>${source}</p>`} active />,
    );

    rerender(
      <StreamingMarkdownContent source={largeTarget} html={`<p>${largeTarget}</p>`} active />,
    );

    expect(container.textContent?.trim()).toBe(largeTarget);
  });

  it('renders final prose with markdown html when streaming is complete', () => {
    const { container } = render(
      <StreamingMarkdownContent source="完成正文" html="<p>完成正文</p>" active={false} />,
    );

    expect(container.querySelector('.md-content')?.getAttribute('data-stream-plain-text')).toBeNull();
    expect(container.querySelector('p')?.textContent).toBe('完成正文');
  });

  it('does not typewriter complex markdown blocks', () => {
    const source = '```ts\nconst x = 1;\n```';
    const html = '<pre><code>const x = 1;</code></pre>';

    const { container } = render(
      <StreamingMarkdownContent source={source} html={html} active />,
    );

    expect(container.textContent).toContain('const x = 1;');
    expect(container.querySelector('[data-stream-tail-char="true"]')).toBeNull();
    expect(container.querySelector('[class*="streamMarkdownBlockEnter"]')).not.toBeNull();
  });

  it('does not typewriter backtick-sensitive inline markdown while streaming', () => {
    const source = '这里有 `inline code`，后续文字也要稳定显示。';
    const html = '<p>这里有 <code>inline code</code>，后续文字也要稳定显示。</p>';

    expect(isTypewriterEligibleMarkdownSource(source)).toBe(false);

    const { container } = render(
      <StreamingMarkdownContent source={source} html={html} active />,
    );

    expect(container.textContent).toContain('后续文字也要稳定显示。');
    expect(container.querySelector('[data-stream-tail-char="true"]')).toBeNull();
    expect(container.querySelector('[class*="streamMarkdownBlockEnter"]')).not.toBeNull();
  });
});
