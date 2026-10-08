// @vitest-environment jsdom
import React, { useRef } from 'react';
import { render, act } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useQuickChatAutoScroll } from '../use-quick-chat-auto-scroll';

function defineScrollerMetrics(el: HTMLElement, metrics: { scrollHeight: number; clientHeight: number }) {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: metrics.scrollHeight });
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: metrics.clientHeight });
}

function Harness(props: {
  expanded: boolean;
  isStreaming: boolean;
  items: readonly unknown[];
  sessionPath: string | null;
  onScroller: (el: HTMLDivElement) => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  useQuickChatAutoScroll({
    expanded: props.expanded,
    isStreaming: props.isStreaming,
    scrollRef,
    sessionItems: props.items,
    sessionPath: props.sessionPath,
  });
  return (
    <div
      data-testid="scroller"
      ref={(el) => {
        scrollRef.current = el;
        if (el) props.onScroller(el);
      }}
    />
  );
}

describe('useQuickChatAutoScroll', () => {
  it('does not pull the transcript back to bottom after the user scrolls upward', () => {
    let scroller: HTMLDivElement | null = null;
    const { rerender } = render(
      <Harness
        expanded
        isStreaming={false}
        items={[1]}
        sessionPath="/tmp/quick.jsonl"
        onScroller={(el) => {
          scroller = el;
          defineScrollerMetrics(el, { scrollHeight: 1000, clientHeight: 200 });
        }}
      />,
    );
    expect(scroller).not.toBeNull();
    scroller!.scrollTop = 800;

    act(() => {
      scroller!.scrollTop = 100;
      scroller!.dispatchEvent(new Event('scroll'));
    });

    rerender(
      <Harness
        expanded
        isStreaming
        items={[1, 2]}
        sessionPath="/tmp/quick.jsonl"
        onScroller={(el) => {
          scroller = el;
          defineScrollerMetrics(el, { scrollHeight: 1200, clientHeight: 200 });
        }}
      />,
    );

    expect(scroller!.scrollTop).toBe(100);
  });
});
