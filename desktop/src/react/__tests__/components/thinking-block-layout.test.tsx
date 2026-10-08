// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThinkingBlock } from '../../components/chat/ThinkingBlock';

describe('ThinkingBlock layout behavior', () => {
  let originalScrollIntoView: typeof HTMLElement.prototype.scrollIntoView | undefined;
  let originalRequestAnimationFrame: typeof window.requestAnimationFrame;
  let originalCancelAnimationFrame: typeof window.cancelAnimationFrame;

  beforeEach(() => {
    originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    originalRequestAnimationFrame = window.requestAnimationFrame;
    originalCancelAnimationFrame = window.cancelAnimationFrame;

    Object.assign(window, {
      t: (key: string) => ({
        'thinking.done': '思考完成',
        'thinking.active': '思考中',
      } as Record<string, string>)[key] || key,
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    if (originalScrollIntoView) {
      HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    } else {
      delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
    }
    window.requestAnimationFrame = originalRequestAnimationFrame;
    window.cancelAnimationFrame = originalCancelAnimationFrame;
  });

  it('does not force-scroll the chat pane when expanding long thinking content', () => {
    const scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    window.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    }) as typeof window.requestAnimationFrame;
    window.cancelAnimationFrame = vi.fn() as unknown as typeof window.cancelAnimationFrame;

    render(
      <ThinkingBlock
        content={`${'这是一段很长的思考内容 '.repeat(20)}\n`.repeat(20)}
        sealed
      />,
    );

    expect(screen.queryByText(/这是一段很长的思考内容/)).toBeNull();

    fireEvent.click(screen.getByText('思考完成'));

    expect(screen.getByText(/这是一段很长的思考内容/)).toBeTruthy();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});
