/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SelectWidget } from '../SelectWidget';

describe('SelectWidget', () => {
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 600 });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('keeps the portal popup aligned while settings scroll', async () => {
    const onChange = vi.fn();
    render(
      <SelectWidget
        value=""
        onChange={onChange}
        placeholder="Choose option"
        options={[
          { value: 'alpha', label: 'Alpha' },
          { value: 'beta', label: 'Beta' },
        ]}
      />,
    );

    const trigger = screen.getByRole('button', { name: /Choose option/ });
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
      x: 32,
      y: 548,
      top: 548,
      left: 32,
      right: 272,
      bottom: 580,
      width: 240,
      height: 32,
      toJSON: () => ({}),
    } as DOMRect);
    fireEvent.click(trigger);

    await waitFor(() => expect(document.body.querySelector('[data-select-widget-popup]')).toBeTruthy());
    const popup = document.body.querySelector('[data-select-widget-popup]') as HTMLElement;
    expect(popup.style.top || popup.style.bottom).not.toBe('');

    fireEvent.scroll(window);
    expect(document.body.querySelector('[data-select-widget-popup]')).toBeTruthy();

    fireEvent.click(screen.getByRole('option', { name: 'Alpha' }));
    expect(onChange).toHaveBeenCalledWith('alpha');
    expect(document.body.querySelector('[data-select-widget-popup]')).toBeNull();
  });

  it('exposes class hooks, listbox semantics, and a readable arrow', async () => {
    render(
      <SelectWidget
        value="alpha"
        onChange={vi.fn()}
        className="capsule-root"
        triggerClassName="capsule-trigger"
        popupClassName="capsule-popup"
        options={[
          { value: 'alpha', label: 'Alpha' },
          { value: 'beta', label: 'Beta' },
        ]}
      />,
    );

    const trigger = screen.getByRole('button', { name: /Alpha/ });
    expect(trigger.closest('.capsule-root')).toBeTruthy();
    expect(trigger).toHaveClass('capsule-trigger');
    expect(trigger).toHaveAttribute('aria-haspopup', 'listbox');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveAttribute('title', 'Alpha');
    expect(trigger.querySelector('svg')).toBeTruthy();

    fireEvent.click(trigger);

    await waitFor(() => expect(document.body.querySelector('[data-select-widget-popup]')).toBeTruthy());
    const popup = document.body.querySelector('[data-select-widget-popup]') as HTMLElement;
    expect(popup).toHaveClass('capsule-popup');
    expect(popup).toHaveAttribute('role', 'listbox');
    expect(screen.getByRole('option', { name: 'Alpha' })).toHaveAttribute('aria-selected', 'true');
  });
});
