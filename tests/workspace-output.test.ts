import path from "path";
import { describe, expect, it } from "vitest";
import fs from "fs";

import {
  WORKSPACE_OUTPUT_ROOT_DIRNAME,
  resolveAgentWorkspaceOutputDirs,
  resolveWorkspaceOutputDir,
  sanitizeWorkspaceOutputSegment,
} from "../shared/workspace-output.ts";

describe("workspace output directory contract", () => {
  it("places app output folders under a single BYOUNG-Works root", () => {
    const workspace = path.join("/tmp", "project");

    expect(WORKSPACE_OUTPUT_ROOT_DIRNAME).toBe("BYOUNG-Works");
    expect(resolveWorkspaceOutputDir(workspace, "screenshots", "zh-CN")).toBe(
      path.join(workspace, "BYOUNG-Works", "截图"),
    );
    expect(resolveWorkspaceOutputDir(workspace, "diary", "zh-CN")).toBe(
      path.join(workspace, "BYOUNG-Works", "日记"),
    );
    expect(resolveWorkspaceOutputDir(workspace, "screenshots", "en")).toBe(
      path.join(workspace, "BYOUNG-Works", "Screenshots"),
    );
    expect(resolveWorkspaceOutputDir(workspace, "diary", "en")).toBe(
      path.join(workspace, "BYOUNG-Works", "Diary"),
    );
  });

  it("uses the visible agent name for heartbeat patrol and activity dirs", () => {
    const workspace = path.join("/tmp", "project");

    expect(resolveAgentWorkspaceOutputDirs(workspace, "灏忚姳*?\"<>|. ", "zh-CN")).toEqual({
      patrolDir: path.join(workspace, "BYOUNG-Works", "小花的巡检"),
      activityDir: path.join(workspace, "BYOUNG-Works", "灏忚姳-activity"),
      agentSegment: "灏忚姳",
    });

    expect(resolveAgentWorkspaceOutputDirs(workspace, "Nova", "en")).toEqual({
      patrolDir: path.join(workspace, "BYOUNG-Works", "Nova Patrol"),
      activityDir: path.join(workspace, "BYOUNG-Works", "Nova-activity"),
      agentSegment: "Nova",
    });
  });

  it("sanitizes unsafe path segments without hidden id fallbacks", () => {
    expect(sanitizeWorkspaceOutputSegment("aux")).toBe("agent-aux");
    expect(sanitizeWorkspaceOutputSegment("   ")).toBe("Agent");
    expect(sanitizeWorkspaceOutputSegment("a/b\\c:d*e?f\"g<h>i|j")).toBe("abcdefghij");
  });

  it("keeps visible output folder copy neutral", () => {
    for (const locale of ["zh", "zh-TW", "ja", "ko", "en"]) {
      const data = JSON.parse(fs.readFileSync(path.join(process.cwd(), "desktop", "src", "locales", `${locale}.json`), "utf-8"));
      const text = [
        data.common.screenshotSaved,
        data.common.screenshotSavedMultiple,
        data.slash.diaryDone,
      ].join("\n");

      expect(text).not.toContain("G-SAP-Works");
      expect(text).not.toContain("BYOUNG-Works");
      expect(text).not.toMatch(/OH-Works|OpenHanako|Hanako|hanako|diary folder/);
    }
  });
});
