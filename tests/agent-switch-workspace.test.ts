// Upstream reference test migrated and debranded; skipped until the matching Codia source contract is migrated.
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../core/agent-manager.ts";

describe.skip("AgentManager.switchAgent workspace selection", () => {
  let tempDir = null;

  afterEach(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  function makeDir(name) {
    if (!tempDir) tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codia-agent-switch-"));
    const dir = path.join(tempDir, name);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  function makeManager({ previousCwd, targetHome }) {
    const focusAgent = {
      id: "focus",
      agentName: "Focus",
      config: { models: { chat: { id: "focus-model", provider: "openai" } } },
    };
    const targetAgent = {
      id: "target",
      agentName: "Target",
      config: { models: { chat: { id: "target-model", provider: "openai" } } },
    };
    const createSession = vi.fn(async (_mgr, cwd) => ({
      sessionPath: path.join(makeDir("sessions"), "target.jsonl"),
      agentId: "target",
      session: {
        sessionManager: {
          getCwd: () => cwd,
        },
      },
    }));
    const savePrimaryAgent = vi.fn();
    const manager = new AgentManager({
      agentsDir: makeDir("agents"),
      productDir: makeDir("product"),
      userDir: makeDir("user"),
      channelsDir: makeDir("channels"),
      getPrefs: () => ({ savePrimaryAgent }),
      getModels: () => ({
        availableModels: [
          { id: "focus-model", provider: "openai" },
          { id: "target-model", provider: "openai" },
        ],
        defaultModel: null,
      }),
      getHub: () => ({
        pauseForAgentSwitch: vi.fn(async () => {}),
        resumeAfterAgentSwitch: vi.fn(),
      }),
      getSkills: () => ({ syncAgentSkills: vi.fn() }),
      getSessionCoordinator: () => ({ createSession }),
      getEngine: () => ({
        cwd: previousCwd,
        getExplicitHomeCwd: (agentId) => (agentId === "target" ? targetHome : null),
      }),
    });
    manager.agents.set("focus", focusAgent);
    manager.agents.set("target", targetAgent);
    manager.activeAgentId = "focus";
    return { manager, createSession, savePrimaryAgent };
  }

  it.skip("creates the new focus session in the target agent explicit workspace", async () => {
    const previousCwd = makeDir("previous-workspace");
    const targetHome = makeDir("target-home");
    const { manager, createSession } = makeManager({ previousCwd, targetHome });

    const result = await manager.switchAgent("target");

    expect(createSession).toHaveBeenCalledWith(null, targetHome);
    expect(result.cwd).toBe(targetHome);
    expect(result.homeFolder).toBe(targetHome);
  });

  it.skip("preserves the current cwd when the target agent has no explicit workspace", async () => {
    const previousCwd = makeDir("previous-workspace");
    const { manager, createSession } = makeManager({ previousCwd, targetHome: null });

    const result = await manager.switchAgent("target");

    expect(createSession).toHaveBeenCalledWith(null, previousCwd);
    expect(result.cwd).toBe(previousCwd);
    expect(result.homeFolder).toBeNull();
  });

  it.skip("switching focus does not change the primary agent", async () => {
    const previousCwd = makeDir("previous-workspace");
    const { manager, savePrimaryAgent } = makeManager({ previousCwd, targetHome: null });

    await manager.switchAgent("target");

    expect(manager.activeAgentId).toBe("target");
    expect(savePrimaryAgent).not.toHaveBeenCalled();
  });
});
