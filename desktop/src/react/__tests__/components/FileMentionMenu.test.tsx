// @vitest-environment jsdom
import React, { createRef } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileMentionMenu } from '../../components/input/FileMentionMenu';
import { AnchoredPortal } from '../../ui/AnchoredPortal';
import type { FileMentionItem } from '../../utils/file-mention-items';

const image: FileMentionItem = {
  id: 'image-1', source: 'workspace', kind: 'image',
  path: '/work/photo.png', name: 'photo.png', detail: '/work',
};

afterEach(cleanup);

describe('file mention menu', () => {
  it('renders outside a clipped composer and supports click selection while retaining editor focus', () => {
    const anchor = createRef<HTMLDivElement>();
    const select = vi.fn();
    const close = vi.fn();
    render(<>
      <div data-testid="composer" style={{ overflow: 'hidden', height: 60 }} ref={anchor}>
        <input aria-label="composer input" />
      </div>
      <AnchoredPortal open anchorRef={anchor} onClose={close}>
        <FileMentionMenu items={[image]} selected={0} busy={false} onSelect={select} onHover={vi.fn()} />
      </AnchoredPortal>
    </>);
    const menu = screen.getByRole('listbox');
    expect(screen.getByTestId('composer').contains(menu)).toBe(false);
    const input = screen.getByRole('textbox');
    input.focus();
    const option = screen.getByRole('option');
    fireEvent.mouseDown(option);
    expect(document.activeElement).toBe(input);
    fireEvent.click(option);
    expect(select).toHaveBeenCalledWith(image);
    expect(close).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(close).toHaveBeenCalledOnce();
  });

  it('shows an explicit empty or loading state instead of silently removing the menu', () => {
    const props = { items: [], selected: 0, onSelect: vi.fn(), onHover: vi.fn() };
    const { rerender } = render(<FileMentionMenu {...props} busy />);
    expect(screen.getByRole('status').textContent).toBe('正在搜索…');
    rerender(<FileMentionMenu {...props} busy={false} />);
    expect(screen.getByRole('status').textContent).toBe('没有匹配的文件、图片或助手');
  });
});
