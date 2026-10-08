/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PluginTabOverflow } from '../../components/plugin/PluginTabOverflow';

describe('PluginTabOverflow', () => {
  beforeEach(() => {
    window.t = ((key: string) => key) as typeof window.t;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 768 });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders the dropdown outside the clipped tab bar so collapsed plugin tabs remain clickable', () => {
    const onSelect = vi.fn();
    render(
      <div data-testid="clipped-tabs" style={{ overflow: 'hidden', width: 120, height: 32 }}>
        <PluginTabOverflow
          tabs={[{ id: 'plugin:demo', label: 'Demo Plugin' }]}
          currentTab="chat"
          onSelect={onSelect}
        />
      </div>,
    );

    fireEvent.click(screen.getByTitle('channel.moreTabs'));

    const item = screen.getByRole('button', { name: 'Demo Plugin' });
    expect(screen.getByTestId('clipped-tabs').contains(item)).toBe(false);

    fireEvent.click(item);
    expect(onSelect).toHaveBeenCalledWith('plugin:demo');
  });
});
