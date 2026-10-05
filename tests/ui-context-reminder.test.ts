import { describe, expect, it } from "vitest";

import { buildUiContextReminder } from "../core/ui-context-reminder.ts";

describe("UI context reminder", () => {
  it("includes selected workspace tool details for the current turn", () => {
    const reminder = buildUiContextReminder({
      workspaceTool: {
        id: "research",
        title: "研究模式",
        description: "引用溯源、可信度、可导出报告",
      },
    }, "E:/G-sap");

    expect(reminder).toContain("<user-context>");
    expect(reminder).toContain("selected_workspace_tool:");
    expect(reminder).toContain("id: research");
    expect(reminder).toContain("title: 研究模式");
    expect(reminder).toContain("purpose: 引用溯源、可信度、可导出报告");
  });

  it("returns null when workspace tool metadata is malformed and no other UI context exists", () => {
    expect(buildUiContextReminder({ workspaceTool: { id: "", title: "" } }, "E:/G-sap")).toBeNull();
  });
});
