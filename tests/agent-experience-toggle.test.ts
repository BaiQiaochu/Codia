// @ts-nocheck
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/memory/config-loader.js", () => ({
  loadConfig: vi.fn(() => ({})),
  saveConfig: vi.fn(),
}));

vi.mock("../lib/compat/index.js", () => ({
  runCompatChecks: vi.fn(async () => ({})),
}));

function tool(name) {
  return { name, execute: vi.fn(async () => ({ content: [] })) };
}

function makeAgent({ experienceEnabled = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-agent-exp-"));
  const agentsDir = path.join(root, "agents");
  const productDir = path.join(root, "product");
  const userDir = path.join(root, "user");
  const agentDir = path.join(agentsDir, "gsap");
  fs.mkdirSync(path.join(productDir, "yuan"), { recursive: true });
  fs.mkdirSync(path.join(productDir, "identity-templates"), { recursive: true });
  fs.mkdirSync(path.join(productDir, "ishiki-templates"), { recursive: true });
  fs.mkdirSync(path.join(agentDir, "memory"), { recursive: true });
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(path.join(productDir, "yuan", "gsap.md"), "yuan", "utf-8");
  fs.writeFileSync(path.join(productDir, "identity.example.md"), "identity {{agentName}}", "utf-8");
  fs.writeFileSync(path.join(productDir, "ishiki.example.md"), "ishiki {{userName}}", "utf-8");
  fs.writeFileSync(path.join(agentDir, "config.yaml"), "", "utf-8");

  return import("../core/agent.js").then(({ Agent }) => {
    const agent = new Agent({ id: "gsap", agentsDir, productDir, userDir });
    agent._config = {
      locale: "en",
      agent: { name: "G-SAP", yuan: "gsap" },
      user: { name: "User" },
      memory: { enabled: true },
      experience: { enabled: experienceEnabled },
    };
    agent.agentName = "G-SAP";
    agent.userName = "User";
    agent._memoryMasterEnabled = true;
    agent._memorySessionEnabled = true;
    agent._experienceEnabled = experienceEnabled === true;
    agent._memorySearchTool = tool("search_memory");
    agent._pinnedMemoryTools = [tool("pin_memory")];
    agent._experienceTools = [tool("record_experience"), tool("recall_experience")];
    agent._webSearchTool = tool("web_search");
    agent._todoTool = tool("todo_write");
    return { agent, root };
  });
}

describe("agent experience toggle", () => {
  const roots = [];

  afterEach(() => {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
    roots.length = 0;
  });

  it("keeps experience tools and prompt guidance disabled by default", async () => {
    const { agent, root } = await makeAgent({ experienceEnabled: false });
    roots.push(root);

    const toolNames = agent.getToolsSnapshot().map((item) => item.name);
    expect(toolNames).not.toContain("record_experience");
    expect(toolNames).not.toContain("recall_experience");
    expect(agent.buildSystemPrompt()).not.toContain("Experience Library");
  }, 30000);

  it("includes experience tools and prompt guidance when enabled", async () => {
    const { agent, root } = await makeAgent({ experienceEnabled: true });
    roots.push(root);

    const toolNames = agent.getToolsSnapshot().map((item) => item.name);
    expect(toolNames).toContain("record_experience");
    expect(toolNames).toContain("recall_experience");
    expect(agent.buildSystemPrompt()).toContain("Experience Library");
  }, 30000);

  it("lets session creation force the frozen experience tool state", async () => {
    const { agent, root } = await makeAgent({ experienceEnabled: true });
    roots.push(root);

    expect(agent.getToolsSnapshot({ forceExperienceEnabled: false }).map((item) => item.name)).not.toContain("record_experience");
    expect(agent.getToolsSnapshot({ forceExperienceEnabled: true }).map((item) => item.name)).toContain("record_experience");
  });

  it("keeps create_artifact as a legacy compatibility tool only", async () => {
    const { agent, root } = await makeAgent({ experienceEnabled: false });
    roots.push(root);
    agent._artifactTool = tool("create_artifact");

    expect(agent.getToolsSnapshot().map((item) => item.name)).not.toContain("create_artifact");
    expect(agent.getToolsSnapshot({ includeLegacyArtifactTool: true }).map((item) => item.name)).toContain("create_artifact");
  });

  it("uses a no-screenshot browser schema for text-only models without auxiliary vision", async () => {
    const { agent, root } = await makeAgent({ experienceEnabled: false });
    roots.push(root);
    agent._browserTool = tool("browser");
    agent._browserTool.parameters = { properties: { action: { enum: ["snapshot", "screenshot"] } } };
    agent._browserToolNoScreenshot = tool("browser");
    agent._browserToolNoScreenshot.parameters = { properties: { action: { enum: ["snapshot"] } } };
    agent.setCallbacks({ getEngine: () => ({ isVisionAuxiliaryEnabled: () => false }) });

    const browserTool = agent.getToolsSnapshot({ model: { input: ["text"] } }).find((item) => item.name === "browser");

    expect(browserTool.parameters.properties.action.enum).not.toContain("screenshot");
  });

  it("does not expose computer control when the platform runtime is unsupported", async () => {
    const { agent, root } = await makeAgent({ experienceEnabled: false });
    roots.push(root);
    agent._computerUseTool = tool("computer");
    agent.setCallbacks({
      getEngine: () => ({
        getComputerUseSettings: () => ({ enabled: true }),
        getPrimaryAgentId: () => "gsap",
        isComputerUseSupported: () => false,
        isVisionAuxiliaryEnabled: () => false,
      }),
    });

    expect(agent.getToolsSnapshot().map((item) => item.name)).not.toContain("computer");
  });

  it("includes current-view and file-delivery routing guidance", async () => {
    const { agent, root } = await makeAgent({ experienceEnabled: false });
    roots.push(root);

    const prompt = agent.buildSystemPrompt();

    expect(prompt).toContain("## Current View");
    expect(prompt).toContain("call current_status for ui_context");
    expect(prompt).toContain("## File Delivery");
    expect(prompt).toContain("call stage_files");
    expect(prompt).toContain("After write/edit creates or modifies a file, call stage_files");
    expect(prompt).toContain("registration does not mean the file has been delivered");
  });
});
