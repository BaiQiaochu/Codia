/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SessionViewToggle } from '../../components/SessionViewToggle';

const t = (key: string) => ({
  'sidebar.view.time': '时间视图',
  'sidebar.view.project': '项目视图',
  'sidebar.view.sort': '视图切换',
}[key] || key);

afterEach(cleanup);

describe('visible session view switch', () => {
  it('shows both labeled buttons immediately and exposes the current view', () => {
    render(<SessionViewToggle value="time" onChange={vi.fn()} t={t} />);
    expect(screen.getByRole('button', { name: '时间视图' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '项目视图' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('calls the existing mode change action and updates selected styling', () => {
    const onChange = vi.fn();
    const { rerender } = render(<SessionViewToggle value="time" onChange={onChange} t={t} />);
    fireEvent.click(screen.getByRole('button', { name: '项目视图' }));
    expect(onChange).toHaveBeenCalledWith('project');
    rerender(<SessionViewToggle value="project" onChange={onChange} t={t} />);
    expect(screen.getByRole('button', { name: '项目视图' })).toHaveAttribute('aria-pressed', 'true');
    const timeButton = screen.getByRole('button', { name: '时间视图' });
    timeButton.focus();
    expect(timeButton).toHaveFocus();
    fireEvent.click(timeButton);
    expect(onChange).toHaveBeenLastCalledWith('time');
  });
});
