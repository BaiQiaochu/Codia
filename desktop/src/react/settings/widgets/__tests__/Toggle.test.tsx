/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { Toggle } from '../Toggle';

afterEach(cleanup);

describe('Toggle', () => {
  it('renders on state when on=true', () => {
    const { container } = render(<Toggle on={true} onChange={() => {}} />);
    const btn = container.querySelector('button.codia-toggle') as HTMLButtonElement;
    expect(btn.classList.contains('on')).toBe(true);
    expect(btn.classList.contains('loading')).toBe(false);
    expect(btn.getAttribute('aria-checked')).toBe('true');
    expect(btn.getAttribute('aria-busy')).toBeNull();
    expect(btn.disabled).toBe(false);
  });

  it('renders off state when on=false', () => {
    const { container } = render(<Toggle on={false} onChange={() => {}} />);
    const btn = container.querySelector('button.codia-toggle') as HTMLButtonElement;
    expect(btn.classList.contains('on')).toBe(false);
    expect(btn.classList.contains('loading')).toBe(false);
    expect(btn.getAttribute('aria-checked')).toBe('false');
  });

  it('renders loading state when on=undefined and does not fire onChange', () => {
    const onChange = vi.fn();
    const { container } = render(<Toggle on={undefined} onChange={onChange} />);
    const btn = container.querySelector('button.codia-toggle') as HTMLButtonElement;

    expect(btn.classList.contains('loading')).toBe(true);
    expect(btn.getAttribute('aria-busy')).toBe('true');
    expect(btn.getAttribute('aria-checked')).toBe('mixed');
    expect(btn.disabled).toBe(true);

    fireEvent.click(btn);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('fires onChange with toggled values', () => {
    const onChange = vi.fn();
    const { container, rerender } = render(<Toggle on={true} onChange={onChange} />);
    fireEvent.click(container.querySelector('button.codia-toggle')!);
    expect(onChange).toHaveBeenCalledWith(false);

    rerender(<Toggle on={false} onChange={onChange} />);
    fireEvent.click(container.querySelector('button.codia-toggle')!);
    expect(onChange).toHaveBeenCalledWith(true);
  });
});
