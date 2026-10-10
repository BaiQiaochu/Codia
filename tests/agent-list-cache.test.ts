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

describe("AgentManager.listAgents cache", () => {
  let tempDir;
  let agentsDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codia-test-"));
    agentsDir = path.join(tempDir, "agents");
    fs.mkdirSync(agentsDir);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function createTestAgent(id, name) {
    const dir = path.join(agentsDir, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "config.yaml"),
      YAML.dump({ agent: { name, yuan: "codia" } }),
    );
    fs.writeFileSync(path.join(dir, "identity.md"), `# ${name}\nProfile for ${name}`);
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

  it("uses cached agents inside the TTL", () => {
    createTestAgent("alice", "Alice");
    const mgr = makeMgr();

    const first = mgr.listAgents();
    expect(first).toHaveLength(1);
    expect(first[0].name).toBe("Alice");

    createTestAgent("bob", "Bob");

    const second = mgr.listAgents();
    expect(second).toHaveLength(1);
  });

  it("reflects changes after invalidateAgentListCache", () => {
    createTestAgent("alice", "Alice");
    const mgr = makeMgr();

    const first = mgr.listAgents();
    expect(first).toHaveLength(1);

    fs.writeFileSync(
      path.join(agentsDir, "alice", "config.yaml"),
      YAML.dump({ agent: { name: "AliceV2", yuan: "butter" } }),
    );

    const stale = mgr.listAgents();
    expect(stale[0].name).toBe("Alice");

    mgr.invalidateAgentListCache();
    const fresh = mgr.listAgents();
    expect(fresh[0].name).toBe("AliceV2");
  });

  it("reflects identity changes after cache invalidation", () => {
    createTestAgent("alice", "Alice");
    const mgr = makeMgr();

    const first = mgr.listAgents();
    expect(first[0].identity).toContain("Alice");

    fs.writeFileSync(
      path.join(agentsDir, "alice", "identity.md"),
      "# Alice\nUpdated identity",
    );

    mgr.invalidateAgentListCache();
    const fresh = mgr.listAgents();
    expect(fresh[0].identity).toBe("Updated identity");
  });
});
