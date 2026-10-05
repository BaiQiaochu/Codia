import { describe, expect, it } from "vitest";
import {
  WORKSPACE_TOOL_CONTRACTS,
  WORKSPACE_TOOL_OPTIONS,
  buildWorkspaceToolTurnContext,
  getWorkspaceToolContract,
  normalizeWorkspaceToolSelection,
} from "../shared/workspace-tools.ts";
import { buildUiContextTurnContext } from "../core/ui-context-reminder.ts";

describe("workspace tool contract", () => {
  it("exposes every chat tool as a backend contract", () => {
    expect(WORKSPACE_TOOL_OPTIONS.map((tool) => tool.id)).toEqual([
      "research",
      "documents",
      "meeting",
      "selection",
      "workflow-market",
    ]);
    expect(WORKSPACE_TOOL_CONTRACTS).toHaveLength(WORKSPACE_TOOL_OPTIONS.length);
    for (const contract of WORKSPACE_TOOL_CONTRACTS) {
      expect(contract.backendRoute || contract.operation).toBeTruthy();
      expect(contract.capabilities.length).toBeGreaterThan(0);
      expect(contract.recommendedTools.length).toBeGreaterThan(0);
      expect(contract.systemInstruction).toContain("active");
    }
  });

  it("normalizes only known tools and ignores caller-supplied labels", () => {
    expect(normalizeWorkspaceToolSelection({
      id: "meeting",
      title: "spoofed",
      description: "spoofed",
    })).toEqual({
      id: "meeting",
      title: "会议纪要",
      description: "转写、摘要、行动项、风险项",
    });

    expect(getWorkspaceToolContract("browser")).toBeNull();
    expect(normalizeWorkspaceToolSelection({ id: "browser" })).toBeNull();
  });

  it("builds system turn context so current tool references are resolved", () => {
    const context = buildWorkspaceToolTurnContext({ id: "research" });
    expect(context?.system).toContain("Research Mode is active");
    expect(context?.system).toContain("this tool");
    expect(context?.system).toContain("web_search");
    expect(context?.metadata.workspaceTool).toMatchObject({
      id: "research",
      operation: "research_mode",
      backendRoute: "/api/prompts/research",
    });
  });

  it("combines visible UI context with workspace tool system context", () => {
    const turnContext = buildUiContextTurnContext({
      currentViewed: "E:/G-sap/docs",
      activeFile: "E:/G-sap/docs/plan.md",
      pinnedFiles: [],
      workspaceTool: { id: "documents", title: "ignored", description: "ignored" },
    }, "E:/G-sap");

    expect(turnContext?.system).toContain("Document Workspace is active");
    expect(turnContext?.beforeUser).toContain("active_file: E:/G-sap/docs/plan.md");
    expect(turnContext?.beforeUser).not.toContain("selected_workspace_tool");
    expect(turnContext?.metadata.workspaceTool).toMatchObject({
      id: "documents",
      operation: "document_workspace",
    });
  });
});
