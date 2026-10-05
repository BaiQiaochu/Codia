// @ts-nocheck
import fs from "fs";
import {
  readSessionEntriesFile,
  writeSessionEntriesFile,
} from "./session-jsonl-file.ts";

const DEFAULT_LOOKBACK = 10;
const DEFAULT_ERROR_THRESHOLD = 3;
const STOP_REASONS_DROPPED_BY_SDK = new Set(["error", "aborted"]);

export function evaluateSessionHealth(sessionPath, opts = {}) {
  const lookback = opts.lookback ?? DEFAULT_LOOKBACK;
  const errorThreshold = opts.errorThreshold ?? DEFAULT_ERROR_THRESHOLD;

  let raw;
  try {
    raw = fs.readFileSync(sessionPath, "utf-8");
  } catch {
    return { healthy: true, recentErrors: 0, totalChecked: 0, exists: false };
  }

  const lines = raw.split("\n");
  let assistantCount = 0;
  let errorCount = 0;
  for (let i = lines.length - 1; i >= 0 && assistantCount < lookback; i--) {
    const line = lines[i];
    if (!line) continue;

    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (entry?.type !== "message") continue;
    if (entry?.message?.role !== "assistant") continue;

    assistantCount++;
    if (entry.message.stopReason === "error") errorCount++;
  }

  return {
    healthy: errorCount < errorThreshold,
    recentErrors: errorCount,
    totalChecked: assistantCount,
    exists: true,
  };
}

function collectSurvivingToolCallIds(message, into) {
  if (!message || message.role !== "assistant") return;
  if (STOP_REASONS_DROPPED_BY_SDK.has(message.stopReason)) return;
  const content = message.content;
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if ((block.type === "toolCall" || block.type === "tool_use")
      && typeof block.id === "string" && block.id.length > 0) {
      into.add(block.id);
    }
  }
}

function isToolResultEntry(entry) {
  return Boolean(entry)
    && entry.type === "message"
    && entry.message
    && entry.message.role === "toolResult";
}

function isAssistantEntry(entry) {
  return Boolean(entry)
    && entry.type === "message"
    && entry.message
    && entry.message.role === "assistant";
}

export function repairOrphanToolResultEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return { entries, removed: 0 };
  }

  const declaredToolCallIds = new Set();
  const orphanParentById = new Map();
  for (const entry of entries) {
    if (isAssistantEntry(entry)) {
      collectSurvivingToolCallIds(entry.message, declaredToolCallIds);
      continue;
    }
    if (isToolResultEntry(entry)) {
      const toolCallId = entry.message.toolCallId;
      const paired = typeof toolCallId === "string" && declaredToolCallIds.has(toolCallId);
      if (!paired) orphanParentById.set(entry.id, entry.parentId ?? null);
    }
  }

  if (orphanParentById.size === 0) {
    return { entries, removed: 0 };
  }

  const resolveSurvivingParent = (parentId) => {
    let current = parentId ?? null;
    const guard = new Set();
    while (current !== null && orphanParentById.has(current) && !guard.has(current)) {
      guard.add(current);
      current = orphanParentById.get(current);
    }
    return current;
  };

  const repaired = [];
  for (const entry of entries) {
    if (entry && orphanParentById.has(entry.id)) continue;
    if (entry && typeof entry === "object" && entry.parentId != null
      && orphanParentById.has(entry.parentId)) {
      repaired.push({ ...entry, parentId: resolveSurvivingParent(entry.parentId) });
    } else {
      repaired.push(entry);
    }
  }

  return { entries: repaired, removed: orphanParentById.size };
}

export function repairOrphanToolResultEntriesInFile(sessionPath) {
  const loaded = readSessionEntriesFile(sessionPath);
  if (!loaded) return { repaired: false, removed: 0 };

  const { entries: repaired, removed } = repairOrphanToolResultEntries(loaded.entries);
  if (removed === 0) return { repaired: false, removed: 0 };

  try {
    writeSessionEntriesFile(sessionPath, repaired);
  } catch {
    return { repaired: false, removed: 0 };
  }

  return { repaired: true, removed };
}
