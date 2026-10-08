import { describe, expect, it, vi } from "vitest";

import { BridgeSessionManager } from "../core/bridge-session-manager.js";

function createManager() {
  return new BridgeSessionManager({
    getPreferences: () => ({ bridge: { readOnly: false }, thinking_level: "auto" }),
    getResourceLoader: () => ({
      getSystemPrompt: () => "BASE",
    }),
    getVisionBridge: () => null,
    isVisionAuxiliaryEnabled: () => false,
    buildTools: vi.fn(() => ({
      tools: [
        { name: "read" },
        { name: "bash" },
        { name: "browser" },
      ],
      customTools: [
        { name: "search_memory" },
        { name: "web_fetch" },
      ],
    })),
  });
}

function createAgent() {
  return {
    id: "agent-1",
    agentDir: "/tmp/agent-1",
    memoryMasterEnabled: true,
    experienceEnabled: false,
    config: { models: { chat: "chat" } },
    tools: [],
    getToolsSnapshot: () => [],
    buildSystemPrompt: () => "OWNER",
  };
}

function createModelManager() {
  const model = { id: "chat", provider: "test" };
  return {
    availableModels: [model],
    resolveExecutionModel: () => model,
    resolveThinkingLevel: (level) => level,
  };
}

describe("BridgeSessionManager owner tool snapshots", () => {
  it("repairs restored bridge tool snapshots without reviving retired tools", () => {
    const manager = createManager();

    const opts = manager._buildOwnerSessionOpts(
      createAgent(),
      createModelManager(),
      process.cwd(),
      { current: null },
      { toolNames: ["search_memory", "retired_tool", "read", "read"] },
    );

    expect(opts.activeToolNames).toEqual(["search_memory", "read", "bash"]);
    expect(opts.activeToolNames).not.toContain("retired_tool");
  });

  it("freezes currently available safe bridge tools for new owner sessions", () => {
    const manager = createManager();

    const opts = manager._buildOwnerSessionOpts(
      createAgent(),
      createModelManager(),
      process.cwd(),
      { current: null },
      {},
    );

    expect(opts.activeToolNames).toEqual([
      "read",
      "bash",
      "search_memory",
      "web_fetch",
    ]);
    expect(opts.activeToolNames).not.toContain("browser");
  });
});
