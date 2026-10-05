import { describe, expect, it } from 'vitest';
import {
  applyTodoLifecycle,
  extractLatestTodoSnapshot,
  extractLatestTodos,
} from '../../utils/todo-compat';
import { TODO_STATE_CUSTOM_TYPE } from '../../utils/todo-constants';

const completedTodo = {
  content: 'Ship the fix',
  activeForm: 'Shipping the fix',
  status: 'completed' as const,
};

describe('frontend todo compatibility lifecycle', () => {
  it('removes completed todo groups and custom removal snapshots', () => {
    expect(applyTodoLifecycle([completedTodo])).toEqual([]);
    expect(TODO_STATE_CUSTOM_TYPE).toBe('gsap.todo_state');

    const messages = [{
      role: 'custom',
      customType: TODO_STATE_CUSTOM_TYPE,
      details: {
        source: 'user',
        removed: true,
        todos: [completedTodo],
      },
    }];

    expect(extractLatestTodoSnapshot(messages)).toMatchObject({
      removed: true,
      source: 'user',
      todos: [completedTodo],
    });
    expect(extractLatestTodos(messages)).toEqual([]);
  });

  it('keeps legacy Hana custom todo state messages readable', () => {
    expect(extractLatestTodos([{
      role: 'custom',
      customType: 'hana.todo_state',
      details: {
        source: 'user',
        removed: true,
        todos: [completedTodo],
      },
    }])).toEqual([]);
  });
});
