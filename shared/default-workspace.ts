import fs from "fs";
import os from "os";
import path from "path";
import {
  DEFAULT_HEARTBEAT_INTERVAL_MINUTES,
  DEFAULT_WORKSPACE_DIRNAME,
} from "./default-workspace-constants.ts";

export {
  DEFAULT_HEARTBEAT_INTERVAL_MINUTES,
  DEFAULT_WORKSPACE_DIRNAME,
};

export function resolveDefaultWorkspacePath(homeDir = os.homedir()): string {
  return path.join(homeDir, "Desktop", DEFAULT_WORKSPACE_DIRNAME);
}

export function ensureDefaultWorkspace(homeDir = os.homedir()): string {
  const workspacePath = resolveDefaultWorkspacePath(homeDir);
  fs.mkdirSync(workspacePath, { recursive: true });
  return workspacePath;
}

function normalizePathForCompare(p: string): string {
  return process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p);
}

export function isDefaultWorkspacePath(cwd: unknown, homeDir = os.homedir()): boolean {
  if (typeof cwd !== "string" || !cwd.trim()) return false;
  return normalizePathForCompare(cwd) === normalizePathForCompare(resolveDefaultWorkspacePath(homeDir));
}

export function restoreDefaultWorkspaceIfMissing(cwd: unknown, homeDir = os.homedir()): boolean {
  if (!isDefaultWorkspacePath(cwd, homeDir)) return false;
  fs.mkdirSync(cwd as string, { recursive: true });
  return true;
}
