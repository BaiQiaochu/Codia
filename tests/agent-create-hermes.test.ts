import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import YAML from "js-yaml";
import { AgentManager } from "../core/agent-manager.js";

vi.mock("../lib/debug-log.js", () => ({
  createModuleLogger: () => ({
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock("../lib/desk/activity-store.js", () => ({
  ActivityStore: vi.fn(),
}));

describe("AgentManager.createAgent yuan handling", () => {
  let tempDir;
  let agentsDir;
  let userDir;
  let channelsDir;
  let manager;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codia-agent-create-"));
    agentsDir = path.join(tempDir, "agents");
    userDir = path.join(tempDir, "user");
    channelsDir = path.join(tempDir, "channels");
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.mkdirSync(userDir, { recursive: true });
    fs.mkdirSync(channelsDir, { recursive: true });

    manager = new AgentManager({
      agentsDir,
      productDir: path.resolve("lib"),
      userDir,
      channelsDir,
      getPrefs: () => ({
        getPrimaryAgent: () => null,
        getPreferences: () => ({}),
        savePrimaryAgent: vi.fn(),
        savePreferences: vi.fn(),
      }),
      getModels: () => ({
        defaultModel: { id: "test-model" },
        resolveModelWithCredentials: vi.fn((id) => ({ id })),
      }),
      getHub: () => null,
      getSkills: () => ({
        syncAgentSkills: vi.fn(),
        reload: vi.fn(),
        computeDefaultEnabledForNewAgent: vi.fn(() => []),
      }),
      getSearchConfig: () => ({}),
      resolveUtilityConfig: () => ({}),
      getSharedModels: () => ({}),
      getChannelManager: () => ({
        setupChannelsForNewAgent: vi.fn(),
        cleanupAgentFromChannels: vi.fn(),
      }),
      getSessionCoordinator: () => ({ createSession: vi.fn() }),
      getEngine: () => null,
      getResourceLoader: () => null,
    });

    manager._createAgentInstance = vi.fn((agentDir) => ({
      agentDir,
      init: vi.fn().mockResolvedValue(undefined),
      setGetOwnerIds: vi.fn(),
      setDmSentHandler: vi.fn(),
      dispose: vi.fn(),
    }));
    manager._agents = new Map();
    manager.activeAgentId = "primary";
    manager._agents.set("primary", {
      userName: "Ghost",
      config: { models: { chat: { id: "chat-primary", provider: "openai" } } },
    });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("rejects the removed Hermes yuan template", async () => {
    await expect(manager.createAgent({
      name: "Removed Worker",
      id: "removed-worker",
      yuan: "hermes",
    })).rejects.toMatchObject({
      code: "INVALID_YUAN",
      statusCode: 400,
    });
  });

  it("persists the requested home folder for newly created agents", async () => {
    const workspace = path.join(tempDir, "workspace-target");
    fs.mkdirSync(workspace, { recursive: true });

    await manager.createAgent({
      name: "Workspace Worker",
      id: "workspace-worker",
      yuan: "codia",
      homeFolder: workspace,
    });

    const config = YAML.load(fs.readFileSync(path.join(agentsDir, "workspace-worker", "config.yaml"), "utf-8"));
    expect(config.desk?.home_folder).toBe(workspace);
  });
});
