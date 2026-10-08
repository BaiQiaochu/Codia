// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentTabScroller, type AgentTabScrollerItem } from '../../components/automation/AgentTabScroller';

function buildItems(count: number): AgentTabScrollerItem[] {
  return Array.from({ length: count }, (_, index) => {
    const number = index + 1;
    return {
      id: `agent-${number}`,
      label: `Agent ${number}`,
      avatar: <span data-testid={`agent-avatar-${number}`} />,
    };
  });
}

function renderScroller(activeId = 'agent-1') {
  const onSelect = vi.fn();
  const view = render(
    <AgentTabScroller
      items={buildItems(9)}
      activeId={activeId}
      ariaLabel="Agent tabs"
      previousLabel="Previous Agent"
      nextLabel="Next Agent"
      onSelect={onSelect}
    />,
  );
  return { onSelect, ...view };
}

describe('AgentTabScroller', () => {
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('keeps overflow tabs reachable from wheel input', () => {
    renderScroller();

    const scroller = screen.getByTestId('agent-tab-scroller');
    Object.defineProperty(scroller, 'clientWidth', { configurable: true, value: 160 });
    Object.defineProperty(scroller, 'scrollWidth', { configurable: true, value: 520 });

    fireEvent.wheel(scroller, { deltaY: 90 });

    expect(scroller.scrollLeft).toBe(90);
    expect(screen.getByRole('button', { name: 'Previous Agent' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next Agent' })).toBeInTheDocument();
  });

  it('pages the scroller from the visible arrow controls', async () => {
    renderScroller();

    const scroller = screen.getByTestId('agent-tab-scroller');
    Object.defineProperty(scroller, 'clientWidth', { configurable: true, value: 160 });
    Object.defineProperty(scroller, 'scrollWidth', { configurable: true, value: 520 });
    fireEvent.scroll(scroller);

    const nextButton = screen.getByRole('button', { name: 'Next Agent' });
    await waitFor(() => expect(nextButton).not.toBeDisabled());
    fireEvent.click(nextButton);

    expect(scroller.scrollLeft).toBe(115);
  });

  it('selects adjacent tabs from keyboard navigation', () => {
    const { onSelect } = renderScroller('agent-2');

    fireEvent.keyDown(screen.getByRole('tab', { name: 'Agent 2' }), { key: 'ArrowRight' });
    expect(onSelect).toHaveBeenLastCalledWith('agent-3');

    fireEvent.keyDown(screen.getByRole('tab', { name: 'Agent 2' }), { key: 'Home' });
    expect(onSelect).toHaveBeenLastCalledWith('agent-1');

    fireEvent.keyDown(screen.getByRole('tab', { name: 'Agent 2' }), { key: 'End' });
    expect(onSelect).toHaveBeenLastCalledWith('agent-9');
  });

  it('centers the active tab when selection moves beyond the visible range', async () => {
    const { rerender, onSelect } = renderScroller('agent-1');

    const scroller = screen.getByTestId('agent-tab-scroller');
    Object.defineProperty(scroller, 'clientWidth', { configurable: true, value: 160 });
    Object.defineProperty(scroller, 'scrollWidth', { configurable: true, value: 520 });
    const farTab = screen.getByRole('tab', { name: 'Agent 8' });
    Object.defineProperty(farTab, 'offsetLeft', { configurable: true, value: 420 });
    Object.defineProperty(farTab, 'offsetWidth', { configurable: true, value: 64 });

    rerender(
      <AgentTabScroller
        items={buildItems(9)}
        activeId="agent-8"
        ariaLabel="Agent tabs"
        previousLabel="Previous Agent"
        nextLabel="Next Agent"
        onSelect={onSelect}
      />,
    );

    await waitFor(() => expect(scroller.scrollLeft).toBe(360));
  });
});
