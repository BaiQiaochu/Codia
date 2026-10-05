import { describe, expect, it } from 'vitest';
import { buildTodoTree, todoTreeDisplayText } from '../../utils/todo-tree';
import type { TodoItem } from '../../types';

function todo(content: string, extra: Partial<TodoItem> = {}): TodoItem {
  return {
    content,
    activeForm: content,
    status: 'pending',
    ...extra,
  };
}

describe('todo tree utilities', () => {
  it('groups explicit parentId children under their parent', () => {
    const tree = buildTodoTree([
      todo('Build release', { id: 'root' }),
      todo('Rewrite scripts', { id: 'scripts', parentId: 'root' }),
      todo('Run smoke tests', { id: 'smoke', parentId: 'root' }),
    ]);

    expect(tree).toHaveLength(1);
    expect(todoTreeDisplayText(tree[0])).toBe('Build release');
    expect(tree[0].children.map(todoTreeDisplayText)).toEqual([
      'Rewrite scripts',
      'Run smoke tests',
    ]);
  });

  it('builds a tree from indentation and removes structural prefixes from labels', () => {
    const tree = buildTodoTree([
      todo('1. Package cleanup'),
      todo('  1.1 Rewrite package scripts'),
      todo('  1.2 Rewrite test scripts'),
      todo('2. UI verification'),
    ]);

    expect(tree.map(todoTreeDisplayText)).toEqual(['Package cleanup', 'UI verification']);
    expect(tree[0].children.map(todoTreeDisplayText)).toEqual([
      'Rewrite package scripts',
      'Rewrite test scripts',
    ]);
  });
});
