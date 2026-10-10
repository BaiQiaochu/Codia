// @ts-nocheck
import fs from "fs";
import os from "os";
import path from "path";
import YAML from "js-yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../core/agent-manager.ts";
import { Agent } from "../core/agent.ts";

vi.mock("../lib/debug-log.ts", () => ({
  createModuleLogger: () => ({
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock("../lib/desk/activity-store.ts", () => ({
  ActivityStore: vi.fn(),
}));

describe("active-agent roster provider", () => {
  let tempDir;
  let agentsDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codia-roster-"));
    agentsDir = path.join(tempDir, "agents");
    fs.mkdirSync(agentsDir);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function createAgentDir(id, { name = id, chatModel = null, description = null, tombstone = false } = {}) {
    const dir = path.join(agentsDir, id);
    fs.mkdirSync(dir, { recursive: true });
    const cfg = { agent: { name, yuan: "codia" } };
    if (chatModel) cfg.models = { chat: chatModel };
    fs.writeFileSync(path.join(dir, "config.yaml"), YAML.dump(cfg));
    if (description) fs.writeFileSync(path.join(dir, "description.md"), description, "utf-8");
    if (tombstone) {
      fs.writeFileSync(
        path.join(dir, ".deleted-agent.json"),
        JSON.stringify({ version: 1, agentId: id, deletedAt: new Date().toISOString() }),
        "utf-8",
      );
    }
  }

  function makeMgr() {
    return new AgentManager({
      agentsDir,
      productDir: tempDir,
      userDir: tempDir,
      channelsDir: tempDir,
      getPrefs: () => ({
        getPrimaryAgent: () => null,
        getPreferences: () => ({}),
      }),
      getModels: () => ({}),
      getHub: () => null,
      getSkills: () => ({}),
      getSearchConfig: () => ({}),
      resolveUtilityConfig: () => ({}),
      getSharedModels: () => ({}),
      getChannelManager: () => ({ setupChannelsForNewAgent: vi.fn(), cleanupAgentFromChannels: vi.fn() }),
      getSessionCoordinator: () => ({}),
    });
  }

  it("excludes tombstoned and config-less directories from the roster", () => {
    createAgentDir("alive", { name: "Alive" });
    createAgentDir("deleted", { name: "Deleted", tombstone: true });
    fs.mkdirSync(path.join(agentsDir, "junk", "phone"), { recursive: true });

    const roster = makeMgr().listActiveAgentsForRoster();

    expect(roster.map((a) => a.id)).toEqual(["alive"]);
  });

  it("returns the legacy roster entry shape: id / name / summary / model", () => {
    createAgentDir("scholar", {
      name: "Scholar",
      chatModel: { id: "qwen-max", provider: "dashscope" },
      description: "<!-- hash:abc -->\nResearch assistant",
    });
    createAgentDir("plain", { name: "Plain", chatModel: "gpt-4o-mini" });

    const roster = makeMgr().listActiveAgentsForRoster();
    const scholar = roster.find((a) => a.id === "scholar");
    const plain = roster.find((a) => a.id === "plain");

    expect(scholar).toEqual({
      id: "scholar",
      name: "Scholar",
      summary: "Research assistant",
      model: "qwen-max",
    });
    expect(plain).toEqual({ id: "plain", name: "Plain", summary: "", model: "gpt-4o-mini" });
  });

  it("injects the provider into Agent callbacks so the agent roster shares the same truth source", () => {
    createAgentDir("alive", { name: "Alive" });
    createAgentDir("deleted", { name: "Deleted", tombstone: true });

    const mgr = makeMgr();
    const ag = mgr._createAgentInstance("alive", () => ({}));

    const fromAgentCallback = ag._cb.listActiveAgents();
    expect(fromAgentCallback.map((a) => a.id)).toEqual(["alive"]);
  });

  it("builds the team roster from the injected provider instead of scanning the disk", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codia-roster-agent-"));
    const localAgentsDir = path.join(root, "agents");
    const productDir = path.join(root, "product");
    const userDir = path.join(root, "user");
    fs.mkdirSync(path.join(localAgentsDir, "codia"), { recursive: true });
    fs.mkdirSync(path.join(localAgentsDir, "deleted"), { recursive: true });
    fs.writeFileSync(path.join(localAgentsDir, "deleted", "config.yaml"), "agent:\n  name: Deleted\n", "utf-8");
    fs.mkdirSync(path.join(productDir, "yuan"), { recursive: true });
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(path.join(productDir, "yuan", "codia.md"), "Yuan prompt", "utf-8");

    const agent = new Agent({
      id: "codia",
      agentsDir: localAgentsDir,
      productDir,
      userDir,
      channelsDir: path.join(root, "channels"),
    });
    agent._config = { locale: "en", agent: { yuan: "codia" } };
    agent._cb = {
      listActiveAgents: () => [
        { id: "codia", name: "Codia", summary: "", model: "" },
        { id: "butter", name: "Butter", summary: "Bread specialist", model: "qwen-max" },
      ],
    };

    const roster = agent._formatTeamRoster(true);

    expect(roster).toContain("butter");
    expect(roster).toContain("Bread specialist");
    expect(roster).not.toContain("deleted");
    expect(roster).not.toContain("Deleted");

    fs.rmSync(root, { recursive: true, force: true });
  });
});
