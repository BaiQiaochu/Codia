import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function read(relPath) {
  return fs.readFileSync(path.join(root, relPath), "utf8");
}

describe("desktop UI interaction contracts", () => {
  it("binds every markdown typography setting to autosaved editor preferences", () => {
    const source = read("desktop/src/react/settings/tabs/InterfaceTab.tsx");

    for (const key of [
      "bodyFontSize",
      "heading1FontSize",
      "heading2FontSize",
      "heading3FontSize",
      "heading4FontSize",
      "heading5FontSize",
      "heading6FontSize",
    ]) {
      expect(source).toContain(key);
    }

    expect(source).toContain("EDITOR_FONT_SIZE_ROWS.map(row");
    expect(source).toContain("editorTypography.markdown[row.key]");
    expect(source).toContain("saveEditorTypography({ [row.key]: value })");
    expect(source).toContain("saveEditorTypography({ lineHeight: value })");
    expect(source).toContain("saveEditorTypography({ contentPadding: value })");
    expect(source).toContain("applyEditorTypography(next)");
    expect(source).toContain("settingsChanged?.('editor-typography-changed'");
    expect(source).toContain("autoSaveConfig({ editor: next }");
  });

  it("lets the channel task tree clear all tasks through the company task clear route", () => {
    const source = read("desktop/src/react/components/channels/ChannelWorkspacePanel.tsx");

    expect(source).toContain("handleClearTaskTrees");
    expect(source).toContain("/api/plugins/company/tasks/clear");
    expect(source).toContain("companyId: 'company_default'");
    expect(source).toContain("setCompanyStatus((prev) => prev ? { ...prev, tasks: [] } : prev)");
    expect(source).toContain("channel.clearTaskTree");
    expect(source).toContain("allTaskTrees.length === 0");
  });

  it("keeps the workflow canvas executable and scroll-contained", () => {
    const source = read("desktop/src/react/components/channels/ChannelWorkflowWindow.tsx");
    const css = read("desktop/src/react/components/channels/Channels.module.css");

    expect(source).toContain("handleExecuteWorkflow");
    expect(source).toContain("workflow_window");
    expect(source).toContain("onClick={() => void handleExecuteWorkflow()}");
    expect(source).toContain("styles.workflowWindowRunButton");
    expect(source).toContain("styles.workflowWindowCanvasScroll");
    expect(source).toContain("styles.workflowInspector");
    expect(css).toMatch(/\.workflowWindowPanel\s*\{[\s\S]*?overflow:\s*hidden/);
    expect(css).toMatch(/\.workflowWindowMain\s*\{[\s\S]*?min-height:\s*0/);
    expect(css).toMatch(/\.workflowWindowCanvasScroll\s*\{[\s\S]*?overflow:\s*auto/);
    expect(css).toMatch(/\.workflowInspector\s*\{[\s\S]*?overflow:\s*auto/);
  });

  it("queues Enter submissions during active chat processing without exposing a queue-add button", () => {
    const source = read("desktop/src/react/components/InputArea.tsx");
    const controlBar = read("desktop/src/react/components/input/InputControlBar.tsx");
    const css = read("desktop/src/react/components/input/InputArea.module.css");

    expect(source).toContain("interface QueuedPrompt");
    expect(source).toContain("const enqueuePromptDraft");
    expect(source).toContain("if (isStreaming) {");
    expect(source).toContain("enqueuePromptDraft(draft)");
    expect(source).toContain("setQueueRunning(true)");
    expect(source).toContain("e.key === 'Enter' && (e.ctrlKey || e.metaKey)");
    expect(source).toContain("handleQueueAdd()");
    expect(source).toContain("prompt-queue-panel");
    expect(source).not.toContain("queue-add-btn");
    expect(controlBar).not.toContain("queue-add-btn");
    expect(css).toMatch(/\.prompt-queue-list\s*\{[\s\S]*?overflow-y:\s*auto/);
    expect(css).toMatch(/\.input-surface-reader \.input-bottom-bar\s*\{[\s\S]*?overflow:\s*hidden/);
  });
});
