// @ts-nocheck
import { afterEach, describe, expect, it, vi } from "vitest";
import path from "path";
import { CodiaEngine } from "../core/engine.js";
import { SettingsManager } from "../lib/pi-sdk/index.js";

describe("CodiaEngine resource loader options", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses explicit Codia-owned Pi SDK cwd, agentDir, and in-memory Pi settings", () => {
    const settings = { kind: "in-memory-settings" };
    const inMemory = vi.spyOn(SettingsManager, "inMemory").mockReturnValue(settings);
    const engine = Object.create(CodiaEngine.prototype);
    engine.codiaHome = "/codia-home";
    engine._agentMgr = {
      activeAgentId: "agent-a",
      agent: {
        agentDir: "/codia-home/agents/agent-a",
        systemPrompt: "agent prompt",
      },
    };
    engine.getHomeCwd = vi.fn(() => "/workspace-a");

    const options = engine._createResourceLoaderOptions("/codia-home/skills");

    expect(options).toMatchObject({
      cwd: path.join("/codia-home", ".pi", "project"),
      agentDir: path.join("/codia-home", ".pi", "agent"),
      settingsManager: settings,
      noContextFiles: true,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      additionalSkillPaths: ["/codia-home/skills"],
    });
    expect(options.agentsFilesOverride()).toEqual({ agentsFiles: [] });
    expect(options.systemPromptOverride()).toBe("agent prompt");
    expect(options.appendSystemPromptOverride(["from-pi"])).toEqual([]);
    expect(engine.getHomeCwd).not.toHaveBeenCalled();
    expect(inMemory).toHaveBeenCalledTimes(1);
  });

  it("respects explicit permission mode overrides when building tools", async () => {
    const engine = Object.create(CodiaEngine.prototype);
    // Tool execution revalidates the live scope through the real engine getters.
    engine._sessionCoord = {
      getSessionByPath: () => null,
      getSessionWorkspaceFolders: () => [],
      getSessionAuthorizedFolders: () => [],
    };
    engine.codiaHome = "/codia-home";
    engine._agentMgr = {
      agent: {
        id: "agent-a",
        agentDir: "/codia-home/agents/agent-a",
        tools: [],
      },
    };
    engine._pluginManager = null;
    engine._prefs = {
      getFileBackup: () => ({ enabled: false }),
    };
    engine._readPreferences = () => ({ sandbox: true });
    engine._confirmStore = null;
    engine._emitEvent = vi.fn();
    engine.getSessionPermissionMode = vi.fn(() => "operate");

    const result = engine.buildTools(
      "/workspace-a",
      [{ name: "write", execute: vi.fn(async () => ({ details: { executed: true } })) }],
      { workspace: "/workspace-a", getPermissionMode: () => "read_only" },
    );

    const writeTool = result.customTools.find((tool) => tool.name === "write")
      || result.tools.find((tool) => tool.name === "write");
    const blocked = await writeTool.execute("call-1", { path: "x" }, null, null, { sessionPath: "/tmp/s.jsonl" });

    expect(blocked.details.errorCode).toBe("ACTION_BLOCKED_BY_READ_ONLY");
    expect(engine.getSessionPermissionMode).not.toHaveBeenCalled();
  });
});
