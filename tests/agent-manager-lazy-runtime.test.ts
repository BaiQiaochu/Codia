// @ts-nocheck
import fs from "fs";
import os from "os";
import path from "path";
import YAML from "js-yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { instances } = vi.hoisted(() => ({
  instances: [],
}));

vi.mock("../core/agent.js", () => ({
  Agent: vi.fn().mockImplementation(function (opts) {
    this.id = opts.id;
    this.agentDir = path.join(opts.agentsDir, opts.id);
    this.sessionDir = path.join(this.agentDir, "sessions");
    this.deskDir = path.join(this.agentDir, "desk");
    this.agentName = opts.id;
    this.runtimeInitialized = false;
    this.config = {};
    this.loadConfigOnly = vi.fn(() => {
      const cfgPath = path.join(this.agentDir, "config.yaml");
      this.config = YAML.load(fs.readFileSync(cfgPath, "utf-8")) || {};
      this.agentName = this.config.agent?.name || opts.id;
    });
    this.init = vi.fn(async () => {
      this.loadConfigOnly();
      this.runtimeInitialized = true;
    });
    this.setGetOwnerIds = vi.fn();
    this.setCallbacks = vi.fn();
    this.setOnInstallCallback = vi.fn();
    this.setNotifyHandler = vi.fn();
    this.setDescriptionRefreshHandler = vi.fn();
    this.dispose = vi.fn();
    instances.push(this);
  }),
}));

vi.mock("../lib/debug-log.js", () => ({
  createModuleLogger: () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock("../lib/desk/activity-store.js", () => ({
  ActivityStore: vi.fn(),
}));

vi.mock("../lib/memory/config-loader.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, clearConfigCache: vi.fn() };
});

vi.mock("../core/llm-utils.js", () => ({
  generateAgentId: vi.fn(),
  generateDescription: vi.fn(),
}));

import { AgentManager } from "../core/agent-manager.js";

describe("AgentManager lazy runtime initialization", () => {
  let rootDir;
  let agentsDir;
  let manager;
  let skills;

  beforeEach(() => {
    vi.clearAllMocks();
    instances.length = 0;
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "codia-agent-lazy-"));
    agentsDir = path.join(rootDir, "agents");
    fs.mkdirSync(agentsDir, { recursive: true });
    for (const id of ["focus", "background", "third"]) {
      fs.mkdirSync(path.join(agentsDir, id), { recursive: true });
      fs.writeFileSync(
        path.join(agentsDir, id, "config.yaml"),
        YAML.dump({
          agent: { name: id },
          models: { chat: { id: `${id}-model`, provider: "openai" } },
        }),
        "utf-8",
      );
    }
    skills = {
      syncAgentSkills: vi.fn(),
      computeDefaultEnabledForNewAgent: vi.fn(() => []),
      reload: vi.fn(),
    };
    manager = new AgentManager({
      agentsDir,
      productDir: rootDir,
      userDir: path.join(rootDir, "user"),
      channelsDir: path.join(rootDir, "channels"),
      getPrefs: () => ({
        getPrimaryAgent: () => "focus",
        getPreferences: () => ({}),
        savePrimaryAgent: vi.fn(),
      }),
      getModels: () => ({
        resolveModelWithCredentials: vi.fn(),
        availableModels: [
          { id: "focus-model", provider: "openai" },
          { id: "background-model", provider: "openai" },
          { id: "third-model", provider: "openai" },
        ],
        defaultModel: null,
      }),
      getHub: () => null,
      getSkills: () => skills,
      getSearchConfig: () => ({}),
      resolveUtilityConfig: () => ({}),
      getSharedModels: () => ({}),
      getChannelManager: () => ({}),
      getSessionCoordinator: () => ({}),
      getEngine: () => ({}),
      getResourceLoader: () => null,
    });
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it("startup loads every agent config but initializes only the active runtime", async () => {
    await manager.initAllAgents(() => {}, "focus");

    const byId = Object.fromEntries(instances.map((agent) => [agent.id, agent]));
    expect(Object.keys(byId).sort()).toEqual(["background", "focus", "third"]);
    expect(byId.focus.loadConfigOnly).toHaveBeenCalled();
    expect(byId.background.loadConfigOnly).toHaveBeenCalled();
    expect(byId.third.loadConfigOnly).toHaveBeenCalled();
    expect(byId.focus.init).toHaveBeenCalledTimes(1);
    expect(byId.background.init).not.toHaveBeenCalled();
    expect(byId.third.init).not.toHaveBeenCalled();
  });

  it("runtime activation is single-flight for concurrent callers", async () => {
    await manager.initAllAgents(() => {}, "focus");
    const background = manager.getAgent("background");

    await Promise.all([
      manager.ensureAgentRuntime("background"),
    ]);

    expect(background.init).toHaveBeenCalledTimes(1);
    expect(background.runtimeInitialized).toBe(true);
    expect(skills.syncAgentSkills).toHaveBeenCalledWith(background);
  });

  it("switchAgentOnly activates the target runtime before changing focus", async () => {
    await manager.initAllAgents(() => {}, "focus");
    const target = manager.getAgent("background");
    expect(target.runtimeInitialized).toBe(false);

    await manager.switchAgentOnly("background");

    expect(target.init).toHaveBeenCalledTimes(1);
    expect(target.runtimeInitialized).toBe(true);
    expect(manager.activeAgentId).toBe("background");
  });

  it("flushes active session memory ticks before disposing agents", async () => {
    await manager.initAllAgents(() => {}, "focus");
    const focus = manager.getAgent("focus");
    focus._memoryTicker = {
      notifySessionEnd: vi.fn(async () => {}),
    };

    await expect(manager.disposeAll({
      _sessions: new Map([
        ["E:/sessions/focus/one.jsonl", { agentId: "focus" }],
      ]),
    })).resolves.toBeUndefined();

    expect(focus._memoryTicker.notifySessionEnd).toHaveBeenCalledWith("E:/sessions/focus/one.jsonl");
    expect(focus.dispose).toHaveBeenCalled();
    expect(manager.agents.size).toBe(0);
  });
});
