// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlanModeButton } from '../../components/input/PlanModeButton';

describe('PlanModeButton dropdown positioning', () => {
  beforeEach(() => {
    Object.assign(window, {
      innerWidth: 480,
      innerHeight: 220,
      t: (key: string) => ({
        'input.autoMode': 'Auto review',
        'input.operateMode': 'Operate directly',
        'input.askMode': 'Ask before acting',
        'input.readOnlyMode': 'Read-only mode',
        'input.accessMode': 'Session access mode',
      } as Record<string, string>)[key] || key,
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 240,
      y: 168,
      top: 168,
      right: 320,
      bottom: 196,
      left: 240,
      width: 80,
      height: 28,
      toJSON: () => ({}),
    } as DOMRect);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('mounts the portal dropdown with coordinates immediately', () => {
    render(<PlanModeButton mode="auto" onChange={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: /Auto review/ }));

    const dropdown = screen.getByText('Operate directly').closest('div');
    expect(dropdown).toBeTruthy();
    expect(dropdown?.style.position).toBe('fixed');
    expect(dropdown?.style.top).not.toBe('');
    expect(dropdown?.style.left).not.toBe('');
    expect(dropdown?.style.visibility).not.toBe('hidden');
  });

  it('uses the Chinese fallback instead of leaking the i18n key for auto mode', () => {
    window.t = (key: string) => key;

    render(<PlanModeButton mode="auto" onChange={() => {}} />);

    expect(screen.getByRole('button', { name: /自动模式/ })).toBeTruthy();
    expect(screen.queryByText('input.autoMode')).toBeNull();
  });
});
