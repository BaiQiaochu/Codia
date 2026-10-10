import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PreferencesManager } from "../core/preferences-manager.js";
import { upsertWorkspaceUiState } from "../shared/workspace-ui-state.ts";
import {
  classifyWorkspacePathForGc,
  pruneMissingWorkspaceConfig,
} from "../shared/workspace-persistence-gc.ts";

function normalizedPath(value) {
  return String(value || "").replace(/\\/g, "/");
}

describe("workspace persistence GC", () => {
  const tempRoots = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tempRoots.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeRoot() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codia-workspace-gc-"));
    tempRoots.push(root);
    return root;
  }

  function writePrefs(userDir, workspaceUiState) {
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(path.join(userDir, "preferences.json"), JSON.stringify({
      _defaultsRelaxedMigrated: true,
      workspace_ui_state: workspaceUiState,
    }, null, 2), "utf-8");
  }

  it("prunes missing cwd_history, last_cwd, and explicit home folder config", () => {
    const root = makeRoot();
    const existingWorkspace = path.join(root, "existing");
    const missingWorkspace = path.join(root, "missing");
    fs.mkdirSync(existingWorkspace);

    const result = pruneMissingWorkspaceConfig({
      last_cwd: missingWorkspace,
      cwd_history: [missingWorkspace, existingWorkspace],
      desk: { home_folder: missingWorkspace },
    });

    expect(result).toEqual({
      changed: true,
      patch: {
        cwd_history: [normalizedPath(existingWorkspace)],
        last_cwd: null,
        desk: { home_folder: null },
      },
    });
  });

  it("keeps paths when stat reports temporary access failure", () => {
    const blockedWorkspace = path.join(os.tmpdir(), `codia-blocked-${Date.now()}`);
    const status = classifyWorkspacePathForGc(blockedWorkspace, {
      statSync: () => {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      },
    });

    expect(status).toMatchObject({ path: normalizedPath(blockedWorkspace), status: "unknown", errorCode: "EACCES" });
    expect(pruneMissingWorkspaceConfig({ last_cwd: blockedWorkspace }, {
      statSync: () => {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      },
    })).toEqual({ changed: false, patch: {} });
  });

  it("removes workspace_ui_state records for roots that are definitely gone", () => {
    const root = makeRoot();
    const userDir = path.join(root, "user");
    const existingWorkspace = path.join(root, "existing");
    const missingWorkspace = path.join(root, "missing");
    fs.mkdirSync(existingWorkspace);
    let state = upsertWorkspaceUiState({}, missingWorkspace, {
      deskExpandedPaths: ["old"],
    }, { surface: "electron", now: () => 1 });
    state = upsertWorkspaceUiState(state, existingWorkspace, {
      deskExpandedPaths: ["keep"],
    }, { surface: "electron", now: () => 2 });
    writePrefs(userDir, state);

    const manager = new PreferencesManager({ userDir, agentsDir: path.join(root, "agents") });

    expect(manager.getWorkspaceUiState(missingWorkspace, "electron")).toBeNull();
    expect(manager.getWorkspaceUiState(existingWorkspace, "electron")).toMatchObject({
      deskExpandedPaths: ["keep"],
    });
    const stored = JSON.parse(fs.readFileSync(path.join(userDir, "preferences.json"), "utf-8"));
    expect(stored.workspace_ui_state.workspaces[normalizedPath(missingWorkspace)]).toBeUndefined();
    expect(stored.workspace_ui_state.workspaces[normalizedPath(existingWorkspace)]).toBeDefined();
  });
});
