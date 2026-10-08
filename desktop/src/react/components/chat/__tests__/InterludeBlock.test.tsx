/**
 * @vitest-environment jsdom
 */
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InterludeBlock } from '../InterludeBlock';

const block = {
  type: 'interlude',
  id: 'deferred:subagent-1:success',
  variant: 'deferred_result',
  taskId: 'subagent-1',
  status: 'success',
  sourceKind: 'subagent',
  sourceLabel: 'G-SAP 代码审查',
  text: 'G-SAP 收到来自代码审查的回复',
  detailMarkdown: '**内部详情**\n\n- 第一条',
} as const;

function mockMatchMedia(matches: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

describe('InterludeBlock', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('opens a markdown detail preview on desktop viewports', () => {
    mockMatchMedia(false);
    render(<InterludeBlock block={block} />);

    fireEvent.click(screen.getByRole('button', { name: /G-SAP 收到来自代码审查的回复/ }));

    expect(screen.getByRole('dialog')).toHaveTextContent('内部详情');
    expect(screen.getByRole('dialog')).toHaveTextContent('第一条');
  });

  it('keeps the preview open when the preview itself scrolls', () => {
    mockMatchMedia(false);
    render(<InterludeBlock block={block} />);

    fireEvent.click(screen.getByRole('button', { name: /G-SAP 收到来自代码审查的回复/ }));
    fireEvent.scroll(screen.getByRole('dialog'));

    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('does not enable click preview on mobile or coarse-pointer viewports', () => {
    mockMatchMedia(true);
    render(<InterludeBlock block={block} />);

    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
