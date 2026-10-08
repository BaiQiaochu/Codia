// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import React, { createRef } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnchoredPortal } from '../../ui/AnchoredPortal';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('AnchoredPortal workspace menu placement', () => {
  it('escapes a clipped composer, opens above its bottom anchor and keeps menu item clicks usable', () => {
    const onClose = vi.fn();
    const onSelect = vi.fn();
    const anchorRef = createRef<HTMLButtonElement>();
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return (this.tagName === 'BUTTON'
        ? { left: 30, right: 70, top: 640, bottom: 668, width: 40, height: 28 }
        : { left: 0, right: 264, top: 0, bottom: 360, width: 264, height: 360 }) as DOMRect;
    });
    const { container } = render(
      <div style={{ overflow: 'hidden', height: 80 }}>
        <button ref={anchorRef}>工具</button>
        <AnchoredPortal open anchorRef={anchorRef} align="start" offset={8} viewportPadding={8} onClose={onClose} role="menu">
          <button role="menuitemradio" aria-checked={false} onClick={onSelect}>不使用工具</button>
          <button role="menuitemradio" aria-checked={false}>网页开发</button>
        </AnchoredPortal>
      </div>,
    );
    const menu = screen.getByRole('menu');
    expect(container.contains(menu)).toBe(false);
    expect(menu.parentElement).toBe(document.body);
    expect(menu).toHaveStyle({ position: 'fixed', top: '272px', left: '30px', zIndex: '9999' });
    const firstItem = screen.getByRole('menuitemradio', { name: '不使用工具' });
    fireEvent.mouseDown(firstItem);
    fireEvent.click(firstItem);
    expect(onSelect).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
