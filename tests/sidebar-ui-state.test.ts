import { describe, expect, it } from "vitest";
import {
  mergeSidebarUiPrefs,
  normalizeSidebarUiPrefs,
  normalizeSidebarUiPrefsPatch,
} from "../shared/sidebar-ui-state.ts";

describe("sidebar UI preferences", () => {
  it("keeps existing users on the two-line session list by default", () => {
    expect(normalizeSidebarUiPrefs({}).sessionList).toEqual({ rowMode: "two-line" });
    expect(normalizeSidebarUiPrefs({ sessionList: { rowMode: "single-line" } }).sessionList).toEqual({
      rowMode: "single-line",
    });
  });

  it("normalizes partial sidebar UI patches without inventing omitted branches", () => {
    expect(normalizeSidebarUiPrefsPatch({
      projectView: {
        collapsedProjectIds: ["project-a", "", "project-a"],
      },
    })).toEqual({
      projectView: {
        collapsedProjectIds: ["project-a"],
      },
    });
    expect(normalizeSidebarUiPrefsPatch({
      sessionList: { rowMode: "single-line" },
    })).toEqual({
      sessionList: { rowMode: "single-line" },
    });
  });

  it("merges session list density independently from project view state", () => {
    const current = normalizeSidebarUiPrefs({
      projectView: {
        collapsedProjectIds: ["project-a"],
        collapsedFolderIds: ["folder-a"],
        showAllProjectIds: ["project-b"],
      },
      sessionList: { rowMode: "single-line" },
    });

    expect(mergeSidebarUiPrefs(current, {
      projectView: { showAllProjectIds: ["project-c"] },
    })).toEqual({
      projectView: {
        collapsedProjectIds: ["project-a"],
        collapsedFolderIds: ["folder-a"],
        showAllProjectIds: ["project-c"],
      },
      sessionList: { rowMode: "single-line" },
    });

    expect(mergeSidebarUiPrefs(current, {
      sessionList: { rowMode: "two-line" },
    })).toEqual({
      projectView: {
        collapsedProjectIds: ["project-a"],
        collapsedFolderIds: ["folder-a"],
        showAllProjectIds: ["project-b"],
      },
      sessionList: { rowMode: "two-line" },
    });

    expect(mergeSidebarUiPrefs(current, {
      sessionList: { rowMode: "dense" },
    })).toEqual(current);
  });
});
