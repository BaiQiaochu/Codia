import fs from "fs/promises";
import { parseSessionEntries, buildSessionContext } from "../pi-sdk/index.ts";
import { TODO_STATE_CUSTOM_TYPES, TODO_TOOL_NAMES } from "./todo-constants.ts";
import { createModuleLogger } from "../debug-log.ts";
import { redactLogValue } from "../log-redactor.ts";

const log = createModuleLogger("todo-compat");

const VALID_STATUSES = new Set(["pending", "in_progress", "completed"]);

function formatTodoDiagnostic(value) {
  const redacted = redactLogValue(value);
  try {
    const serialized = JSON.stringify(redacted);
    return serialized === undefined ? String(redacted) : serialized;
  } catch {
    return String(redacted);
  }
}

function isLegacyTodoItem(item) {
  return item && typeof item === "object" && typeof item.done === "boolean";
}

function isNewTodoItem(item) {
  return (
    item &&
    typeof item === "object" &&
    typeof item.content === "string" &&
    typeof item.activeForm === "string" &&
    VALID_STATUSES.has(item.status)
  );
}

function migrateLegacyItem(old) {
  return {
    content: old.text ?? "",
    activeForm: old.text ?? "",
    status: old.done ? "completed" : "pending",
  };
}

export function migrateLegacyTodos(details) {
  if (!details || typeof details !== "object") return [];
  const todos = details.todos;
  if (!Array.isArray(todos)) return [];
  const result = [];
  for (const item of todos) {
    if (isLegacyTodoItem(item)) {
      result.push(migrateLegacyItem(item));
      continue;
    }
    if (isNewTodoItem(item)) {
      result.push(item);
      continue;
    }
    log.error(`dropped invalid todo item: ${formatTodoDiagnostic(item)}`);
  }
  return result;
}

export function isTodoGroupRemoved(todos) {
  if (!Array.isArray(todos)) return false;
  if (todos.length === 0) return true;
  return todos.every((item) => item.status === "completed");
}

export function applyTodoLifecycle(todos) {
  return isTodoGroupRemoved(todos) ? [] : todos;
}

function isValidTodoSnapshot(details) {
  return !!details
    && typeof details === "object"
    && Array.isArray(details.todos);
}

function snapshotFromToolResult(m) {
  if (!isValidTodoSnapshot(m.details)) {
    log.error(`skipped invalid todo snapshot: ${formatTodoDiagnostic({
      toolName: m.toolName,
      details: m.details,
    })}`);
    return { invalid: true };
  }
  const todos = migrateLegacyTodos(m.details);
  return {
    todos,
    removed: isTodoGroupRemoved(todos),
    source: "tool",
  };
}

function snapshotFromTodoStateMessage(m) {
  if (m.role !== "custom" || !TODO_STATE_CUSTOM_TYPES.includes(m.customType)) return null;
  const details = m.details;
  if (!isValidTodoSnapshot(details)) {
    log.error(`skipped invalid todo state event: ${formatTodoDiagnostic({
      customType: m.customType,
      details,
    })}`);
    return { invalid: true };
  }
  const todos = migrateLegacyTodos(details);
  return {
    todos,
    removed: details.removed !== false || isTodoGroupRemoved(todos),
    source: details.source === "model" ? "tool" : "user",
  };
}

export function extractLatestTodoSnapshot(sourceMessages) {
  if (!Array.isArray(sourceMessages)) return null;
  for (let i = sourceMessages.length - 1; i >= 0; i--) {
    const m = sourceMessages[i];
    if (!m) continue;

    const stateSnapshot = snapshotFromTodoStateMessage(m);
    if (stateSnapshot) {
      if (stateSnapshot.invalid) continue;
      return stateSnapshot;
    }

    if (m.role !== "toolResult") continue;
    if (!TODO_TOOL_NAMES.includes(m.toolName)) continue;
    const toolSnapshot = snapshotFromToolResult(m);
    if (toolSnapshot.invalid) continue;
    return toolSnapshot;
  }
  return null;
}

export function extractLatestTodos(sourceMessages) {
  const snapshot = extractLatestTodoSnapshot(sourceMessages);
  if (!snapshot) return null;
  return snapshot.removed ? [] : applyTodoLifecycle(snapshot.todos);
}

export function extractLatestTodosFromEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const header = entries[0];
  if (!header || header.type !== "session") return null;
  const { messages } = buildSessionContext(entries);
  return extractLatestTodos(messages);
}

export function extractLatestTodoSnapshotFromEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const header = entries[0];
  if (!header || header.type !== "session") return null;
  const { messages } = buildSessionContext(entries);
  return extractLatestTodoSnapshot(messages);
}

export async function loadLatestTodosFromSessionFile(sessionPath) {
  if (!sessionPath) return null;
  try {
    const raw = await fs.readFile(sessionPath, "utf-8");
    const entries = parseSessionEntries(raw);
    return extractLatestTodosFromEntries(entries);
  } catch {
    return null;
  }
}

export async function loadLatestTodoSnapshotFromSessionFile(sessionPath) {
  if (!sessionPath) return null;
  try {
    const raw = await fs.readFile(sessionPath, "utf-8");
    const entries = parseSessionEntries(raw);
    return extractLatestTodoSnapshotFromEntries(entries);
  } catch {
    return null;
  }
}
