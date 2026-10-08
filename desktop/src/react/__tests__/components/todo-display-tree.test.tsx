// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { TodoDisplay } from '../../components/input/TodoDisplay';
import type { TodoItem } from '../../types';

function todo(content: string, extra: Partial<TodoItem> = {}): TodoItem {
  return {
    content,
    activeForm: content,
    status: 'pending',
    ...extra,
  };
}

describe('TodoDisplay task tree', () => {
  afterEach(() => cleanup());

  it('renders nested todo items as a task tree when opened', () => {
    render(<TodoDisplay todos={[
      todo('Build release', { id: 'root' }),
      todo('Rewrite package scripts', { id: 'scripts', parentId: 'root' }),
      todo('Rewrite test scripts', { id: 'tests', parentId: 'root' }),
    ]} />);

    fireEvent.click(screen.getByRole('button'));

    const tree = screen.getByTestId('todo-tree');
    const root = within(tree).getByText('Build release').closest('[data-testid="todo-tree-node"]');
    expect(root).toBeTruthy();

    const childList = within(root as HTMLElement).getByTestId('todo-tree-children');
    expect(within(childList).getByText('Rewrite package scripts')).toBeTruthy();
    expect(within(childList).getByText('Rewrite test scripts')).toBeTruthy();
  });
});
