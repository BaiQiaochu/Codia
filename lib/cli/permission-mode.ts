// @ts-nocheck
import { CliError } from "./errors.ts";

const MODES = new Set(["read_only", "ask", "operate"]);
const ALIASES = new Map([
  ["readonly", "read_only"],
  ["read-only", "read_only"],
  ["read_only", "read_only"],
  ["ro", "read_only"],
  ["ask", "ask"],
  ["prompt", "ask"],
  ["operate", "operate"],
  ["auto", "operate"],
  ["full", "operate"],
]);

const CODEX_APPROVAL_ALIASES = new Map([
  ["untrusted", "read_only"],
  ["read-only", "read_only"],
  ["readonly", "read_only"],
  ["read_only", "read_only"],
  ["ro", "read_only"],
  ["on-request", "ask"],
  ["on_request", "ask"],
  ["onfailure", "ask"],
  ["on-failure", "ask"],
  ["on_failure", "ask"],
  ["ask", "ask"],
  ["prompt", "ask"],
  ["never", "operate"],
  ["auto", "operate"],
  ["full", "operate"],
  ["full-auto", "operate"],
]);

const CODEX_SANDBOX_ALIASES = new Map([
  ["read-only", "read_only"],
  ["readonly", "read_only"],
  ["read_only", "read_only"],
  ["workspace-write", "ask"],
  ["workspace_write", "ask"],
  ["workspace", "ask"],
  ["danger-full-access", "operate"],
  ["danger_full_access", "operate"],
  ["danger", "operate"],
  ["full", "operate"],
  ["none", "operate"],
]);

const MODE_RANK = new Map([
  ["read_only", 0],
  ["ask", 1],
  ["operate", 2],
]);

export function normalizeCliPermissionMode(value) {
  const key = String(value || "").trim().toLowerCase();
  const normalized = ALIASES.get(key);
  if (!normalized || !MODES.has(normalized)) throw new CliError(`未知权限模式: ${value}`);
  return normalized;
}

function lookupCodexMode(value, aliases, label) {
  if (value === null || value === undefined || value === "") return null;
  const key = String(value).trim().toLowerCase();
  const normalized = aliases.get(key);
  if (!normalized || !MODES.has(normalized)) throw new CliError(`Unknown Codex ${label} mode: ${value}`);
  return normalized;
}

export function permissionModeFromApprovalMode(value) {
  return lookupCodexMode(value, CODEX_APPROVAL_ALIASES, "approval");
}

export function permissionModeFromSandbox(value) {
  return lookupCodexMode(value, CODEX_SANDBOX_ALIASES, "sandbox");
}

export function permissionModeFromCodexRuntimeOptions({ approvalMode = null, sandboxMode = null } = {}) {
  const modes = [
    permissionModeFromApprovalMode(approvalMode),
    permissionModeFromSandbox(sandboxMode),
  ].filter(Boolean);
  if (!modes.length) return null;
  return modes.reduce((safeMode, mode) => (
    MODE_RANK.get(mode) < MODE_RANK.get(safeMode) ? mode : safeMode
  ));
}

export function formatPermissionMode(mode) {
  const normalized = MODES.has(mode) ? mode : "ask";
  if (normalized === "read_only") return "只读 read_only";
  if (normalized === "operate") return "自动执行 operate";
  return "询问 ask";
}

export function permissionModeQuery({ sessionPath } = {}) {
  const qs = new URLSearchParams();
  if (sessionPath) qs.set("sessionPath", sessionPath);
  const text = qs.toString();
  return text ? `/session-permission-mode?${text}` : "/session-permission-mode";
}

export async function readPermissionMode(client, options = {}) {
  return await client.get(permissionModeQuery(options));
}

export async function setPermissionMode(client, mode, { sessionPath = null } = {}) {
  return await client.post("/session-permission-mode", {
    permissionMode: normalizeCliPermissionMode(mode),
    sessionPath: sessionPath || undefined,
    currentSessionOnly: true,
  });
}
