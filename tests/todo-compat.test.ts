import { describe, expect, it } from "vitest";
import {
  applyTodoLifecycle,
  extractLatestTodoSnapshot,
  extractLatestTodos,
} from "../lib/tools/todo-compat.js";
import { TODO_STATE_CUSTOM_TYPE } from "../lib/tools/todo-constants.js";

const completedTodo = {
  content: "Ship the fix",
  activeForm: "Shipping the fix",
  status: "completed",
};

describe("todo compatibility lifecycle", () => {
  it("removes todo groups once every item is completed", () => {
    expect(applyTodoLifecycle([completedTodo])).toEqual([]);
    expect(extractLatestTodos([{
      role: "toolResult",
      toolName: "todo_write",
      details: { todos: [completedTodo] },
    }])).toEqual([]);
  });

  it("reads the debranded custom todo state message as a removal snapshot", () => {
    expect(TODO_STATE_CUSTOM_TYPE).toBe("gsap.todo_state");

    const snapshot = extractLatestTodoSnapshot([{
      role: "custom",
      customType: TODO_STATE_CUSTOM_TYPE,
      details: {
        source: "user",
        removed: true,
        todos: [completedTodo],
      },
    }]);

    expect(snapshot).toMatchObject({
      removed: true,
      source: "user",
      todos: [completedTodo],
    });
    expect(extractLatestTodos([{
      role: "custom",
      customType: TODO_STATE_CUSTOM_TYPE,
      details: {
        source: "user",
        removed: true,
        todos: [completedTodo],
      },
    }])).toEqual([]);
  });

  it("keeps legacy Hana todo state messages readable without emitting the old brand", () => {
    expect(extractLatestTodos([{
      role: "custom",
      customType: "hana.todo_state",
      details: {
        source: "user",
        removed: true,
        todos: [completedTodo],
      },
    }])).toEqual([]);
  });

  it("preserves optional task-tree parent metadata from todo snapshots", () => {
    const todos = [{
      content: "Build release",
      activeForm: "Building release",
      status: "in_progress",
      id: "root",
    }, {
      content: "Rewrite scripts",
      activeForm: "Rewriting scripts",
      status: "pending",
      id: "scripts",
      parentId: "root",
    }];

    expect(extractLatestTodos([{
      role: "toolResult",
      toolName: "todo_write",
      details: { todos },
    }])).toEqual(todos);
  });
});
