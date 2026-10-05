import fs from "fs";
import { mergeWorkspaceHistory, normalizeWorkspacePath } from "./workspace-history.ts";
import { normalizeWorkspaceUiState } from "./workspace-ui-state.ts";

const MISSING_PATH_CODES = new Set(["ENOENT", "ENOTDIR"]);

type WorkspaceGcOptions = {
  statSync?: typeof fs.statSync;
};

type WorkspaceGcStatus = "invalid" | "present" | "missing" | "unknown";

export function classifyWorkspacePathForGc(value: unknown, { statSync = fs.statSync }: WorkspaceGcOptions = {}) {
  const workspace = normalizeWorkspacePath(value);
  if (!workspace) return { path: null, status: "invalid", errorCode: null };
  try {
    statSync(workspace);
    return { path: workspace, status: "present", errorCode: null };
  } catch (err) {
    const errorCode = typeof (err as { code?: unknown })?.code === "string" ? (err as { code: string }).code : null;
    return {
      path: workspace,
      status: (MISSING_PATH_CODES.has(errorCode || "") ? "missing" : "unknown") as WorkspaceGcStatus,
      errorCode,
    };
  }
}

export function pruneMissingWorkspaceConfig(config: Record<string, any> = {}, options: WorkspaceGcOptions = {}) {
  const patch: Record<string, any> = {};

  if (Array.isArray(config.cwd_history)) {
    const current = mergeWorkspaceHistory(config.cwd_history, []);
    const cwdHistory = current.filter((item) => classifyWorkspacePathForGc(item, options).status !== "missing");
    if (!sameArray(current, cwdHistory)) {
      patch.cwd_history = cwdHistory;
    }
  }

  const lastCwd = normalizeWorkspacePath(config.last_cwd);
  if (lastCwd && classifyWorkspacePathForGc(lastCwd, options).status === "missing") {
    patch.last_cwd = null;
  }

  const homeFolder = normalizeWorkspacePath(config.desk?.home_folder);
  if (homeFolder && classifyWorkspacePathForGc(homeFolder, options).status === "missing") {
    patch.desk = { ...(patch.desk || {}), home_folder: null };
  }

  return {
    changed: Object.keys(patch).length > 0,
    patch,
  };
}

export function pruneMissingWorkspaceUiState(raw: unknown = {}, options: WorkspaceGcOptions = {}) {
  const state = normalizeWorkspaceUiState(raw, options);
  const workspaces: Record<string, unknown> = {};
  for (const [workspace, record] of Object.entries(state.workspaces || {})) {
    if (classifyWorkspacePathForGc(workspace, options).status === "missing") continue;
    workspaces[workspace] = record;
  }
  const next = normalizeWorkspaceUiState({ ...state, workspaces }, options);
  return {
    changed: JSON.stringify(next) !== JSON.stringify(state),
    state: next,
  };
}

function sameArray(a: unknown[], b: unknown[]) {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}
