import { describe, expect, it } from "vitest";
import {
  getWorkspaceUiStateEntry,
  normalizeWorkspaceUiEntry,
  normalizeWorkspaceUiState,
  upsertWorkspaceUiState,
} from "../shared/workspace-ui-state.ts";

describe("workspace UI state", () => {
  it("keeps electron and PWA workspace state in separate surface buckets", () => {
    let state = upsertWorkspaceUiState({}, "/repo", {
      deskExpandedPaths: ["desktop"],
      deskSelectedPath: "desktop/a.md",
    }, { surface: "electron", now: () => 10 });

    state = upsertWorkspaceUiState(state, "/repo", {
      deskExpandedPaths: ["mobile"],
      deskSelectedPath: "mobile/a.md",
    }, { surface: "pwa", now: () => 20 });

    expect(getWorkspaceUiStateEntry(state, "/repo", { surface: "electron" })).toMatchObject({
      deskExpandedPaths: ["desktop"],
      deskSelectedPath: "desktop/a.md",
    });
    expect(getWorkspaceUiStateEntry(state, "/repo", { surface: "pwa" })).toMatchObject({
      deskExpandedPaths: ["mobile"],
      deskSelectedPath: "mobile/a.md",
    });
  });

  it("reads legacy unbucketed workspace state as electron state", () => {
    const state = normalizeWorkspaceUiState({
      workspaces: {
        "/repo": {
          updatedAt: 1,
          deskExpandedPaths: ["old-desktop"],
          deskSelectedPath: "old-desktop/a.md",
        },
      },
    });

    expect(getWorkspaceUiStateEntry(state, "/repo", { surface: "electron" })).toMatchObject({
      deskExpandedPaths: ["old-desktop"],
      deskSelectedPath: "old-desktop/a.md",
    });
    expect(getWorkspaceUiStateEntry(state, "/repo", { surface: "pwa" })).toBeNull();
  });

  it("persists right workspace companion fields", () => {
    expect(normalizeWorkspaceUiEntry({
      rightWorkspaceTab: "workspace",
      jianView: "notes",
      jianDrawerOpen: true,
    })).toMatchObject({
      rightWorkspaceTab: "workspace",
      jianView: "notes",
      jianDrawerOpen: true,
    });
  });
});
