import { TODO_STATE_CUSTOM_TYPES, TODO_TOOL_NAMES } from "./todo-constants";
import type { TodoItem, TodoStatus } from "../types";

type LegacyTodoItem = { id?: number; text: string; done: boolean };
type UnknownDetails = { todos?: unknown[] } & Record<string, unknown>;
type MessageLike = { role?: string; toolName?: string; details?: unknown; customType?: string };
type TodoSnapshot = {
  todos: TodoItem[];
  removed: boolean;
  source: "tool" | "user";
};

const VALID_STATUSES: ReadonlySet<TodoStatus> = new Set<TodoStatus>([
  "pending",
  "in_progress",
  "completed",
]);

function isLegacyTodoItem(item: unknown): item is LegacyTodoItem {
  return (
    typeof item === "object" &&
    item !== null &&
    typeof (item as { done?: unknown }).done === "boolean"
  );
}

function isNewTodoItem(item: unknown): item is TodoItem {
  if (typeof item !== "object" || item === null) return false;
  const it = item as Record<string, unknown>;
  return (
    typeof it.content === "string" &&
    typeof it.activeForm === "string" &&
    typeof it.status === "string" &&
    VALID_STATUSES.has(it.status as TodoStatus)
  );
}

function migrateLegacyItem(old: LegacyTodoItem): TodoItem {
  return {
    content: old.text ?? "",
    activeForm: old.text ?? "",
    status: old.done ? "completed" : "pending",
  };
}

export function migrateLegacyTodos(details: UnknownDetails | null | undefined): TodoItem[] {
  if (!details || typeof details !== "object") return [];
  const todos = (details as { todos?: unknown }).todos;
  if (!Array.isArray(todos)) return [];
  const result: TodoItem[] = [];
  for (const item of todos) {
    if (isLegacyTodoItem(item)) {
      result.push(migrateLegacyItem(item));
      continue;
    }
    if (isNewTodoItem(item)) {
      result.push(item);
      continue;
    }
    console.error("[todo-compat] dropped invalid todo item:", item);
  }
  return result;
}

export function isTodoGroupRemoved(todos: TodoItem[]): boolean {
  if (!Array.isArray(todos)) return false;
  if (todos.length === 0) return true;
  return todos.every((item) => item.status === "completed");
}

export function applyTodoLifecycle(todos: TodoItem[]): TodoItem[] {
  return isTodoGroupRemoved(todos) ? [] : todos;
}

function isValidTodoSnapshot(details: unknown): details is { todos: unknown[] } {
  return (
    !!details &&
    typeof details === "object" &&
    Array.isArray((details as { todos?: unknown }).todos)
  );
}

function snapshotFromToolResult(m: MessageLike): TodoSnapshot | { invalid: true } {
  if (!isValidTodoSnapshot(m.details)) {
    console.error("[todo-compat] skipped invalid todo snapshot:", {
      toolName: m.toolName,
      details: m.details,
    });
    return { invalid: true };
  }
  const todos = migrateLegacyTodos(m.details as UnknownDetails);
  return {
    todos,
    removed: isTodoGroupRemoved(todos),
    source: "tool",
  };
}

function snapshotFromTodoStateMessage(m: MessageLike): TodoSnapshot | { invalid: true } | null {
  if (m.role !== "custom" || !TODO_STATE_CUSTOM_TYPES.includes(m.customType as typeof TODO_STATE_CUSTOM_TYPES[number])) {
    return null;
  }
  const details = m.details as ({ removed?: unknown; source?: unknown } & UnknownDetails) | null | undefined;
  if (!isValidTodoSnapshot(details)) {
    console.error("[todo-compat] skipped invalid todo state event:", {
      customType: m.customType,
      details,
    });
    return { invalid: true };
  }
  const stateDetails = details as { removed?: unknown; source?: unknown } & UnknownDetails;
  const todos = migrateLegacyTodos(stateDetails);
  return {
    todos,
    removed: stateDetails.removed !== false || isTodoGroupRemoved(todos),
    source: stateDetails.source === "model" ? "tool" : "user",
  };
}

export function extractLatestTodoSnapshot(sourceMessages: MessageLike[] | null | undefined): TodoSnapshot | null {
  if (!Array.isArray(sourceMessages)) return null;
  for (let i = sourceMessages.length - 1; i >= 0; i--) {
    const m = sourceMessages[i];
    if (!m) continue;

    const stateSnapshot = snapshotFromTodoStateMessage(m);
    if (stateSnapshot) {
      if ("invalid" in stateSnapshot) continue;
      return stateSnapshot;
    }

    if (m.role !== "toolResult") continue;
    if (!m.toolName || !TODO_TOOL_NAMES.includes(m.toolName as typeof TODO_TOOL_NAMES[number])) continue;
    const toolSnapshot = snapshotFromToolResult(m);
    if ("invalid" in toolSnapshot) continue;
    return toolSnapshot;
  }
  return null;
}

export function extractLatestTodos(sourceMessages: MessageLike[] | null | undefined): TodoItem[] | null {
  const snapshot = extractLatestTodoSnapshot(sourceMessages);
  if (!snapshot) return null;
  return snapshot.removed ? [] : applyTodoLifecycle(snapshot.todos);
}
