// @ts-nocheck
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/memory/memory-ticker.js", () => ({
  createMemoryTicker: () => ({
    start: vi.fn(),
    stop: vi.fn().mockResolvedValue(undefined),
    tick: vi.fn().mockResolvedValue(undefined),
    triggerNow: vi.fn(),
    notifyTurn: vi.fn(),
    notifySessionEnd: vi.fn().mockResolvedValue(undefined),
    notifyPromoted: vi.fn().mockResolvedValue(undefined),
    flushSession: vi.fn().mockResolvedValue(undefined),
    getHealthStatus: vi.fn().mockReturnValue({}),
  }),
}));

vi.mock("../lib/memory/fact-store.js", () => ({
  FactStore: class FactStore {
    constructor() {}
    addBatch() {}
    close() {}
  },
}));

vi.mock("../lib/memory/session-summary.js", () => ({
  SessionSummaryManager: class SessionSummaryManager {
    constructor() {}
  },
}));

vi.mock("../lib/compat/index.js", () => ({
  runCompatChecks: vi.fn().mockResolvedValue(undefined),
}));

import { Agent } from "../core/agent.js";

function bootstrapAgentDir(rootDir) {
  const agentsDir = path.join(rootDir, "agents");
  const agentDir = path.join(agentsDir, "test-agent");
  fs.mkdirSync(path.join(agentDir, "memory", "summaries"), { recursive: true });
  fs.mkdirSync(path.join(agentDir, "desk"), { recursive: true });
  fs.mkdirSync(path.join(agentDir, "sessions"), { recursive: true });
  fs.mkdirSync(path.join(rootDir, "user"), { recursive: true });

  fs.writeFileSync(
    path.join(agentDir, "config.yaml"),
    [
      "agent:",
      "  name: TestAgent",
      "  yuan: codia",
      "user:",
      "  name: Tester",
      "locale: en",
      "memory:",
      "  enabled: true",
      "models:",
      "  chat:",
      "    id: gpt-4",
      "    provider: openai",
    ].join("\n"),
    "utf-8",
  );
  fs.writeFileSync(path.join(agentDir, "identity.md"), "I am the test agent.\n", "utf-8");
  fs.writeFileSync(path.join(agentDir, "ishiki.md"), "ishiki body\n", "utf-8");
  fs.writeFileSync(path.join(agentDir, "pinned.md"), "PINNED_MEMORY_BEACON\n", "utf-8");
  fs.writeFileSync(path.join(agentDir, "memory", "memory.md"), "MEMORY_MD_BEACON\n", "utf-8");
  fs.writeFileSync(path.join(rootDir, "user", "user.md"), "user profile\n", "utf-8");
  return { agentDir, agentsDir };
}

function makeAgent(agentsDir, rootDir) {
  return new Agent({
    id: "test-agent",
    agentsDir,
    userDir: path.join(rootDir, "user"),
    productDir: fileURLToPath(new URL("../lib", import.meta.url)),
  });
}

describe("agent prompt cache decoupling", () => {
  let tmpDir;
  let agentsDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codia-master-decouple-"));
    ({ agentsDir } = bootstrapAgentDir(tmpDir));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does not rebuild the shared prompt cache when session memory is toggled off", async () => {
    const agent = makeAgent(agentsDir, tmpDir);
    await agent.init(() => {});

    const before = agent.systemPrompt;
    expect(before).toContain("MEMORY_MD_BEACON");
    expect(before).toContain("PINNED_MEMORY_BEACON");

    agent.setMemoryEnabled(false);

    expect(agent.sessionMemoryEnabled).toBe(false);
    expect(agent.systemPrompt).toBe(before);
    expect(agent.systemPrompt).toContain("MEMORY_MD_BEACON");

    await agent.dispose();
  });

  it("rebuilds the shared prompt cache when master memory is toggled off", async () => {
    const agent = makeAgent(agentsDir, tmpDir);
    await agent.init(() => {});
    expect(agent.systemPrompt).toContain("MEMORY_MD_BEACON");

    agent.setMemoryMasterEnabled(false);

    expect(agent.memoryMasterEnabled).toBe(false);
    expect(agent.systemPrompt).not.toContain("MEMORY_MD_BEACON");
    expect(agent.systemPrompt).not.toContain("PINNED_MEMORY_BEACON");

    agent.setMemoryMasterEnabled(true);
    expect(agent.systemPrompt).toContain("MEMORY_MD_BEACON");

    await agent.dispose();
  });

  it("keeps master-backed non-session prompts memory-enabled even if a session disables memory", async () => {
    const agent = makeAgent(agentsDir, tmpDir);
    await agent.init(() => {});

    agent.setMemoryEnabled(false);

    expect(agent.memoryMasterEnabled).toBe(true);
    expect(agent.sessionMemoryEnabled).toBe(false);
    expect(agent.systemPrompt).toContain("MEMORY_MD_BEACON");
    expect(agent.systemPrompt).toContain("PINNED_MEMORY_BEACON");

    await agent.dispose();
  });

  it("can build per-session snapshots with forceMemoryEnabled", async () => {
    const agent = makeAgent(agentsDir, tmpDir);
    await agent.init(() => {});

    const onSnapshot = agent.buildSystemPrompt({ forceMemoryEnabled: true });
    const offSnapshot = agent.buildSystemPrompt({ forceMemoryEnabled: false });

    expect(onSnapshot).toContain("MEMORY_MD_BEACON");
    expect(offSnapshot).not.toContain("MEMORY_MD_BEACON");

    await agent.dispose();
  });

  it("workspace instruction files are opt-in and disabled by default", async () => {
    const cwd = path.join(tmpDir, "workspace");
    fs.mkdirSync(cwd, { recursive: true });
    fs.writeFileSync(path.join(cwd, "AGENTS.md"), "DEFAULT_DISABLED_AGENTS_BEACON\n", "utf-8");
    fs.writeFileSync(path.join(cwd, "CLAUDE.md"), "DEFAULT_DISABLED_CLAUDE_BEACON\n", "utf-8");

    const agent = makeAgent(agentsDir, tmpDir);
    await agent.init(() => {});

    const prompt = agent.buildSystemPrompt({
      forceMemoryEnabled: false,
      cwdOverride: cwd,
    });

    expect(prompt).not.toContain("DEFAULT_DISABLED_AGENTS_BEACON");
    expect(prompt).not.toContain("DEFAULT_DISABLED_CLAUDE_BEACON");

    await agent.dispose();
  });

  it("injects enabled workspace instruction files before memory for prompt snapshots", async () => {
    const repoRoot = path.join(tmpDir, "workspace");
    const nestedCwd = path.join(repoRoot, "packages", "app");
    fs.mkdirSync(path.join(repoRoot, ".git"), { recursive: true });
    fs.mkdirSync(nestedCwd, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "AGENTS.md"), "OUTSIDE_WORKSPACE_BEACON\n", "utf-8");
    fs.writeFileSync(path.join(repoRoot, "AGENTS.md"), "ROOT_AGENTS_BEACON\n", "utf-8");
    fs.writeFileSync(path.join(nestedCwd, "CLAUDE.md"), "NESTED_CLAUDE_BEACON\n", "utf-8");

    const agent = makeAgent(agentsDir, tmpDir);
    await agent.init(() => {});
    agent._config.workspace_context = {
      inject_agents_md: true,
      inject_claude_md: true,
    };

    const prompt = agent.buildSystemPrompt({
      forceMemoryEnabled: true,
      cwdOverride: nestedCwd,
    });

    expect(prompt).toContain("## Workspace Instructions");
    expect(prompt).toContain("ROOT_AGENTS_BEACON");
    expect(prompt).toContain("NESTED_CLAUDE_BEACON");
    expect(prompt).not.toContain("OUTSIDE_WORKSPACE_BEACON");
    expect(prompt.indexOf("ROOT_AGENTS_BEACON")).toBeLessThan(prompt.indexOf("NESTED_CLAUDE_BEACON"));
    expect(prompt.indexOf("NESTED_CLAUDE_BEACON")).toBeLessThan(prompt.indexOf("MEMORY_MD_BEACON"));

    await agent.dispose();
  });

  it("does not encourage unsolicited cross-agent calls in the team prompt", async () => {
    const agent = makeAgent(agentsDir, tmpDir);
    await agent.init(() => {});
    agent._listAgents = () => [
      { id: "test-agent", name: "TestAgent", model: "gpt-4", summary: "Primary" },
      { id: "reviewer", name: "Reviewer", model: "gpt-4o", summary: "Code review" },
    ];

    const prompt = agent.buildSystemPrompt({ forceMemoryEnabled: false });

    expect(prompt).toContain("## Team");
    expect(prompt).toContain("`reviewer`");
    expect(prompt).toContain("Only call subagent or dm when the user explicitly asks you to involve another agent");
    expect(prompt).not.toContain("When a task clearly falls within another agent's expertise");

    await agent.dispose();
  });

  it("defines 数据存放 as cwd in the zh-CN system prompt", async () => {
    const agent = makeAgent(agentsDir, tmpDir);
    await agent.init(() => {});
    agent._config.locale = "zh-CN";

    const prompt = agent.buildSystemPrompt({
      forceMemoryEnabled: false,
      cwdOverride: "/workspace/Desktop/project-codia",
    });

    expect(prompt).toContain("## 数据存放");
    expect(prompt).toMatch(/用户所说的.*数据存放.*工作空间.*当前工作目录.*不是系统桌面/s);
    expect(prompt).toContain("当前工作目录：/workspace/Desktop/project-codia");
    expect(prompt).not.toContain("## 书桌");

    await agent.dispose();
  });
});
