import path from "path";
import { describe, expect, it } from "vitest";
import {
  normalizeSessionFolderScope,
  workspaceRootsForSandbox,
} from "../shared/workspace-scope.ts";

describe("workspace scope", () => {
  it("dedupes user-authorized folders after primary and workspace folders", () => {
    const project = path.resolve("/workspace/project");
    const reference = path.resolve("/workspace/reference");
    const external = path.resolve("/external/assets");

    expect(normalizeSessionFolderScope({
      primaryCwd: project,
      workspaceFolders: [reference, project],
      authorizedFolders: [external, reference, external],
    })).toEqual({
      primaryCwd: project,
      workspaceFolders: [reference],
      authorizedFolders: [external],
      sandboxFolders: [project, reference, external],
    });
  });

  it("includes authorized folders in sandbox roots without prompt-visible workspace scope", () => {
    const project = path.resolve("/workspace/project");
    const external = path.resolve("/external/assets");

    expect(workspaceRootsForSandbox(project, [], [external])).toEqual([project, external]);
  });
});
