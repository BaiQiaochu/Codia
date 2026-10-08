import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

const root = process.cwd();

function read(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function exists(relativePath: string): boolean {
  return fs.existsSync(path.join(root, relativePath));
}

describe("professional assistant settings contract", () => {
  it("does not expose character-card export from the agent settings tab", () => {
    const agentTab = read("desktop/src/react/settings/tabs/AgentTab.tsx");
    const agentCardStack = read("desktop/src/react/settings/tabs/agent/AgentCardStack.tsx");

    expect(agentTab).not.toContain("CharacterCardPreviewOverlay");
    expect(agentTab).not.toContain("createPortal");
    expect(agentTab).not.toContain("/api/character-cards/export");
    expect(agentTab).not.toContain("exportPlanningAgentId");
    expect(agentTab).not.toContain("onExport=");

    expect(agentCardStack).not.toContain("onExport");
    expect(agentCardStack).not.toContain("exportingAgentId");
    expect(agentCardStack).not.toContain("settings.agent.exportAgent");
  });

  it("does not expose character-card import from the professional create dialog", () => {
    const createOverlay = read("desktop/src/react/settings/overlays/AgentCreateOverlay.tsx");
    const settingsCss = read("desktop/src/react/settings/Settings.module.css");

    expect(exists("desktop/src/react/settings/overlays/CharacterCardPreviewOverlay.tsx")).toBe(false);
    expect(createOverlay).not.toContain("CharacterCardPreviewOverlay");
    expect(createOverlay).not.toContain("/api/character-cards/plan");
    expect(createOverlay).not.toContain("/api/character-cards/import");
    expect(createOverlay).not.toContain("character-card-file-input");
    expect(createOverlay).not.toContain("character-card-drop-target");
    expect(createOverlay).not.toContain("角色卡");
    expect(settingsCss).not.toContain("character-card-preview-overlay");
    expect(settingsCss).not.toContain("character-card-drop-target");
  });
});
