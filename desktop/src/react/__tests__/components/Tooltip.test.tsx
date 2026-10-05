// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Tooltip } from '../../ui/Tooltip';

describe('Tooltip', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('uses the unified 500ms default delay before showing', () => {
    render(
      <Tooltip content="Hint">
        {({ ref, ...props }) => <button ref={(node) => ref(node)} {...props}>Anchor</button>}
      </Tooltip>,
    );

    const button = screen.getByText('Anchor');
    fireEvent.mouseEnter(button);

    act(() => { vi.advanceTimersByTime(499); });
    expect(screen.queryByRole('tooltip')).toBeNull();

    act(() => { vi.advanceTimersByTime(1); });
    expect(screen.getByRole('tooltip').textContent).toBe('Hint');
  });

  it('hides immediately on mouse leave', () => {
    render(
      <Tooltip content="Hint">
        {({ ref, ...props }) => <button ref={(node) => ref(node)} {...props}>Anchor</button>}
      </Tooltip>,
    );

    const button = screen.getByText('Anchor');
    fireEvent.mouseEnter(button);
    act(() => { vi.advanceTimersByTime(500); });
    expect(screen.getByRole('tooltip')).toBeTruthy();

    fireEvent.mouseLeave(button);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('does not show when content is empty', () => {
    render(
      <Tooltip content="">
        {({ ref, ...props }) => <button ref={(node) => ref(node)} {...props}>Anchor</button>}
      </Tooltip>,
    );

    const button = screen.getByText('Anchor');
    fireEvent.mouseEnter(button);
    act(() => { vi.advanceTimersByTime(500); });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});
