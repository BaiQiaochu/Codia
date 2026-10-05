// @ts-nocheck
/**
 * Agent Phone session policy helpers.
 *
 * The runner lives in hub/agent-executor.js because it needs Engine session
 * context. This module keeps the reusable policy pieces pure and testable.
 */

import path from "path";
import { SESSION_PERMISSION_MODES } from "../../core/session-permission-mode.ts";
import { safeConversationStem } from "./agent-phone-projection.ts";
import { uniqueToolNames } from "../../shared/tool-categories.ts";

export const AGENT_PHONE_TOOL_MODES = Object.freeze({
  READ_ONLY: "read_only",
  WRITE: "write",
});

export const AGENT_PHONE_COMPACTION = Object.freeze({
  IDLE_TOKENS: 120_000,
  HARD_TOKENS: 180_000,
});

export const AGENT_PHONE_SESSION_ACTIVE_WINDOW_MS = 30 * 60 * 1000;

const PHONE_EXCLUDED_TOOL_NAMES = new Set([
  "browser",
  "chrome",
  "channel",
  "dm",
]);

export function getAgentPhoneSessionDir(agentDir, conversationId) {
  return path.join(agentDir, "phone", "sessions", safeConversationStem(conversationId));
}

export function getAgentPhoneRefreshDate(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function shouldRefreshAgentPhoneSession(meta = {}, now = new Date()) {
  return meta?.lastRefreshedDate !== getAgentPhoneRefreshDate(now);
}

export function isAgentPhoneSessionPath(sessionPath) {
  if (!sessionPath || typeof sessionPath !== "string") return false;
  const parts = path.normalize(sessionPath).split(path.sep).filter(Boolean);
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (parts[i] === "phone" && parts[i + 1] === "sessions") return true;
  }
  return false;
}

export function normalizeAgentPhoneToolMode(mode) {
  return mode === AGENT_PHONE_TOOL_MODES.WRITE
    ? AGENT_PHONE_TOOL_MODES.WRITE
    : AGENT_PHONE_TOOL_MODES.READ_ONLY;
}

export function getAgentPhonePermissionMode(toolMode) {
  return normalizeAgentPhoneToolMode(toolMode) === AGENT_PHONE_TOOL_MODES.WRITE
    ? SESSION_PERMISSION_MODES.OPERATE
    : SESSION_PERMISSION_MODES.READ_ONLY;
}

export function shouldCompactAgentPhoneSession({
  tokens,
  isActive = false,
  idleTokens = AGENT_PHONE_COMPACTION.IDLE_TOKENS,
  hardTokens = AGENT_PHONE_COMPACTION.HARD_TOKENS,
} = {}) {
  if (typeof tokens !== "number") return null;
  if (tokens >= hardTokens) return "hard";
  if (!isActive && tokens >= idleTokens) return "idle";
  return null;
}

export function shouldReuseAgentPhoneSession({
  meta = {},
  sessionExists = false,
  now = new Date(),
  activeWindowMs = AGENT_PHONE_SESSION_ACTIVE_WINDOW_MS,
} = {}) {
  if (!sessionExists) return false;
  const lastUsedAt = Date.parse(meta?.lastPhoneSessionUsedAt || "");
  if (!Number.isFinite(lastUsedAt)) return false;
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(nowMs)) return false;
  return nowMs - lastUsedAt <= activeWindowMs;
}

// Tool visibility is a stable phone-surface capability. Read/write mode is
// enforced by session permission wrappers, so it must not narrow this schema.
export function filterAgentPhoneTools({ tools = [], customTools = [] } = {}) {
  return {
    tools: tools.filter((tool) => !PHONE_EXCLUDED_TOOL_NAMES.has(tool.name)),
    customTools: customTools.filter((tool) => !PHONE_EXCLUDED_TOOL_NAMES.has(tool.name)),
  };
}

export function getAgentPhoneActiveToolNames({ tools = [], customTools = [] } = {}) {
  return uniqueToolNames([
    ...tools.map((tool) => tool?.name),
    ...customTools.map((tool) => tool?.name),
  ]);
}

export function applyConversationScopedMemorySearch(tools = [], scopedMemoryTool = null) {
  if (!scopedMemoryTool) return tools;
  return (Array.isArray(tools) ? tools : []).map((tool) => (
    tool?.name === "search_memory" ? scopedMemoryTool : tool
  ));
}
