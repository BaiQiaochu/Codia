// @vitest-environment jsdom

import fs from 'node:fs';
import path from 'node:path';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SelectionQuoteActionSurface } from '../../components/selection/SelectionQuoteActionSurface';
import { useStore } from '../../stores';
import { captureSelection } from '../../stores/selection-actions';

describe('SelectionQuoteActionSurface', () => {
  beforeEach(() => {
    window.t = ((key: string) => (key === 'selection.quoteToChat' ? '引用到对话' : key)) as typeof window.t;
    vi.useFakeTimers();
    useStore.getState().clearQuoteCandidate();
    useStore.getState().clearQuotedSelections();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('adds the current selection candidate as an independent quote chip source', () => {
    const removeAllRanges = vi.fn();
    const getSelection = vi.spyOn(window, 'getSelection').mockReturnValue({
      rangeCount: 1,
      removeAllRanges,
    } as unknown as Selection);
    const requestInputFocus = vi.fn();
    useStore.setState({ requestInputFocus } as never);

    useStore.getState().setQuoteCandidate({
      text: '第一段引用',
      sourceTitle: 'Assistant message',
      sourceKind: 'chat',
      sourceSessionPath: '/session/a.jsonl',
      sourceMessageId: 'assistant-1',
      sourceRole: 'assistant',
      charCount: 5,
      anchorRect: { left: 100, right: 180, top: 120, bottom: 140, width: 80, height: 20 },
    });

    render(<SelectionQuoteActionSurface />);

    fireEvent.click(screen.getByRole('button', { name: '引用到对话' }));

    expect(useStore.getState().quotedSelections).toHaveLength(1);
    expect(useStore.getState().quotedSelections[0]).toMatchObject({ text: '第一段引用' });
    expect(useStore.getState().quoteCandidate).toBeNull();
    expect(removeAllRanges).toHaveBeenCalledOnce();
    expect(requestInputFocus).toHaveBeenCalledOnce();
    getSelection.mockRestore();
  });

  it('keeps the readable action label visible without rendering a duplicate tooltip', () => {
    useStore.getState().setQuoteCandidate({
      text: '第一段引用',
      sourceTitle: 'Assistant message',
      sourceKind: 'chat',
      charCount: 5,
      anchorRect: { left: 100, right: 180, top: 120, bottom: 140, width: 80, height: 20 },
    });

    render(<SelectionQuoteActionSurface />);

    const button = screen.getByRole('button', { name: '引用到对话' });
    expect(button.textContent).toContain('引用到对话');
    fireEvent.mouseEnter(button);
    expect(screen.queryByRole('tooltip')).toBeNull();

    act(() => { vi.advanceTimersByTime(500); });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('renders a labeled SVG quote action above the selection anchor with breathing room', () => {
    useStore.getState().setQuoteCandidate({
      text: '第一段引用',
      sourceTitle: 'Assistant message',
      sourceKind: 'chat',
      charCount: 5,
      anchorRect: { left: 100, right: 180, top: 120, bottom: 140, width: 80, height: 20 },
    });

    render(<SelectionQuoteActionSurface />);

    const button = screen.getByRole('button', { name: '引用到对话' });
    const surface = button.closest('[data-selection-ignore="true"]') as HTMLElement;
    const icon = button.querySelector('svg');

    expect(icon).not.toBeNull();
    expect(icon?.getAttribute('fill')).toBe('currentColor');
    expect(icon?.hasAttribute('stroke')).toBe(false);
    expect(button.textContent).toContain('引用到对话');
    expect(surface.getAttribute('data-selection-quote-action')).toBe('true');
    expect(surface.style.left).toBe('94px');
    expect(surface.style.top).toBe('76px');
  });

  it('keeps the selection quote toolbar as a compact labeled action instead of a square icon tile', () => {
    const css = fs.readFileSync(
      path.join(process.cwd(), 'desktop/src/react/components/selection/SelectionQuoteActionSurface.module.css'),
      'utf8',
    );
    const surfaceRule = css.match(/\.surface\s*\{(?<body>[\s\S]*?)\}/)?.groups?.body || '';
    const buttonRule = css.match(/\.button\s*\{(?<body>[\s\S]*?)\}/)?.groups?.body || '';
    const labelRule = css.match(/\.label\s*\{(?<body>[\s\S]*?)\}/)?.groups?.body || '';

    expect(surfaceRule).toContain('display: flex');
    expect(surfaceRule).toContain('padding: 2px');
    expect(buttonRule).toContain('min-width: 88px');
    expect(buttonRule).toContain('height: 28px');
    expect(buttonRule).toContain('white-space: nowrap');
    expect(labelRule).toContain('display: inline-flex');
    expect(css).not.toContain('.tooltip');
  });

  it('follows the live native selection rect when the transcript scrolls', () => {
    let liveRect = { left: 100, right: 180, top: 120, bottom: 140, width: 80, height: 20 };
    const getSelection = vi.spyOn(window, 'getSelection').mockReturnValue({
      rangeCount: 1,
      toString: () => '第一段引用',
      getRangeAt: () => ({
        getBoundingClientRect: () => liveRect,
      }),
    } as unknown as Selection);
    const requestAnimationFrame = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      });
    const cancelAnimationFrame = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});

    useStore.getState().setQuoteCandidate({
      text: '第一段引用',
      sourceTitle: 'Assistant message',
      sourceKind: 'chat',
      charCount: 5,
      anchorRect: { left: 100, right: 180, top: 120, bottom: 140, width: 80, height: 20 },
    });
    render(<SelectionQuoteActionSurface />);

    const surface = screen.getByRole('button', { name: '引用到对话' }).closest('[data-selection-ignore="true"]') as HTMLElement;
    expect(surface.style.top).toBe('76px');

    liveRect = { left: 100, right: 180, top: 70, bottom: 90, width: 80, height: 20 };
    act(() => {
      document.dispatchEvent(new Event('scroll'));
    });

    expect(surface.style.top).toBe('26px');

    getSelection.mockRestore();
    requestAnimationFrame.mockRestore();
    cancelAnimationFrame.mockRestore();
  });

  it('keeps a CodeMirror quote anchored to its stored editor rect', () => {
    const getSelection = vi.spyOn(window, 'getSelection').mockReturnValue({
      rangeCount: 1,
      toString: () => 'editor quote',
      getRangeAt: () => ({
        getBoundingClientRect: () => ({ left: 100, right: 180, top: 70, bottom: 90, width: 80, height: 20 }),
      }),
    } as unknown as Selection);

    useStore.getState().setQuoteCandidate({
      text: 'editor quote',
      sourceTitle: 'note.md',
      sourceKind: 'preview',
      sourceFilePath: '/notes/note.md',
      selectionAnchorKind: 'codemirror',
      charCount: 12,
      anchorRect: { left: 100, right: 180, top: 120, bottom: 140, width: 80, height: 20 },
    } as never);
    render(<SelectionQuoteActionSurface />);

    const surface = document.querySelector('[data-selection-ignore="true"]') as HTMLElement;
    expect(surface.style.left).toBe('94px');
    expect(surface.style.top).toBe('76px');

    getSelection.mockRestore();
  });

  it('does not show the quote action over selected preview code blocks', () => {
    document.body.innerHTML = '<pre><code>from fastapi import FastAPI</code></pre>';
    const codeText = document.querySelector('code')?.firstChild;
    expect(codeText).toBeTruthy();

    const getSelection = vi.spyOn(window, 'getSelection').mockReturnValue({
      anchorNode: codeText,
      focusNode: codeText,
      anchorOffset: 0,
      focusOffset: 7,
      rangeCount: 1,
      toString: () => 'fastapi',
      getRangeAt: () => ({
        getClientRects: () => [],
        getBoundingClientRect: () => ({ left: 20, right: 80, top: 30, bottom: 50, width: 60, height: 20 }),
      }),
    } as unknown as Selection);

    captureSelection({ title: 'main.py', filePath: '/docs/main.py' } as never);

    expect(useStore.getState().quoteCandidate).toBeNull();
    getSelection.mockRestore();
  });
});
