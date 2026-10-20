// @ts-nocheck
import { createRunBudget } from "../lib/workflow/run-budget.ts";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";

/* global AbortController */

const { createAgentSessionMock, sessionManagerCreateMock, sessionManagerOpenMock, settingsInMemoryMock } = vi.hoisted(() => ({
  createAgentSessionMock: vi.fn(),
  sessionManagerCreateMock: vi.fn(),
  sessionManagerOpenMock: vi.fn(),
  settingsInMemoryMock: vi.fn(() => ({})),
}));

vi.mock("../lib/pi-sdk/index.js", async () => ({
  createAssistantMessageEventStream: (await vi.importActual("../lib/pi-sdk/index.ts")).createAssistantMessageEventStream,
  createAgentSession: createAgentSessionMock,
  SessionManager: {
    create: sessionManagerCreateMock,
    open: sessionManagerOpenMock,
  },
  estimateTokens: vi.fn(() => 1),
  findCutPoint: vi.fn(),
  generateSummary: vi.fn(),
  emitSessionShutdown: vi.fn(),
  refreshSessionModelFromRegistry: vi.fn(),
  SettingsManager: {
    inMemory: settingsInMemoryMock,
  },
}));

vi.mock("../lib/debug-log.js", () => ({
  createModuleLogger: () => ({
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { SessionCoordinator } from "../core/session-coordinator.js";
import { RunController } from "../lib/execution/run-controller.ts";

describe("SessionCoordinator", () => {
  let tempDir;

  it("does not delegate a bounded local task to an unaccounted external runtime", async () => {
    const agent = { id: "external", config: { runtime: { target: "wukong" } } };
    const coordinator = new SessionCoordinator({ getAgent: () => agent });
    const run = new RunController(); run.begin();
    try {
      const result = await run.run(() => coordinator.executeIsolated("delegate"));
      expect(result.error).toMatch(/cannot enforce.*shared/);
      expect(createAgentSessionMock).not.toHaveBeenCalled();
    } finally { run.cancel(); }
  });

  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codia-session-coordinator-"));
    sessionManagerCreateMock.mockReturnValue({ getCwd: () => "/tmp/workspace" });
    sessionManagerOpenMock.mockReturnValue({ getCwd: () => "/tmp/workspace" });
    createAgentSessionMock.mockResolvedValue({
      session: {
        sessionManager: { getSessionFile: () => "/tmp/session.jsonl" },
        subscribe: vi.fn(() => vi.fn()),
        setActiveToolsByName: vi.fn(),
      },
    });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("applies session memory before creating the agent session", async () => {
    const agent = {
      sessionDir: "/tmp/agent-sessions",
      setMemoryEnabled: vi.fn(),
      refreshAppearanceSummary: vi.fn().mockResolvedValue("appearance summary"),
      buildSystemPrompt: vi.fn(({ forceMemoryEnabled } = {}) =>
        forceMemoryEnabled === false ? "MEMORY OFF" : "MEMORY ON"),
    };

    const resourceLoader = {
      getSystemPrompt: () => "MEMORY ON",
    };

    const coordinator = new SessionCoordinator({
      agentsDir: "/tmp/agents",
      getAgent: () => agent,
      getActiveAgentId: () => "codia",
      getModels: () => ({
        currentModel: { name: "test-model" },
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => resourceLoader,
      getSkills: () => null,
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: () => {},
      getHomeCwd: () => "/tmp/home",
      agentIdFromSessionPath: () => null,
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => null,
      listAgents: () => [],
    });

    await coordinator.createSession(null, "/tmp/workspace", false);

    expect(agent.setMemoryEnabled).not.toHaveBeenCalled();
    expect(agent.refreshAppearanceSummary).toHaveBeenCalledWith(expect.objectContaining({
      targetModel: { name: "test-model" },
      rebuildSystemPrompt: true,
    }));
    expect(agent.buildSystemPrompt).toHaveBeenCalledWith(expect.objectContaining({
      forceMemoryEnabled: false,
      targetModel: { name: "test-model" },
    }));
    expect(createAgentSessionMock).toHaveBeenCalledOnce();
    expect(createAgentSessionMock.mock.calls[0][0].resourceLoader.getSystemPrompt()).toBe("MEMORY OFF");
  });

  it("persists and restores per-session prompt and skill snapshots", async () => {
    const agentDir = path.join(tempDir, "agents", "codia");
    const sessionDir = path.join(agentDir, "sessions");
    const sessionFile = path.join(sessionDir, "main.jsonl");
    fs.mkdirSync(sessionDir, { recursive: true });

    const skillOneDir = path.join(tempDir, "skills", "one");
    const skillTwoDir = path.join(tempDir, "skills", "two");
    fs.mkdirSync(skillOneDir, { recursive: true });
    fs.mkdirSync(skillTwoDir, { recursive: true });
    fs.writeFileSync(path.join(skillOneDir, "SKILL.md"), "---\nname: one\n---\n# One\n", "utf-8");
    fs.writeFileSync(path.join(skillTwoDir, "SKILL.md"), "---\nname: two\n---\n# Two\n", "utf-8");

    let promptText = "PROMPT ONE";
    let runtimeSkillsResult = {
      skills: [{ name: "one", filePath: path.join(skillOneDir, "SKILL.md"), baseDir: skillOneDir, source: "user" }],
      diagnostics: [],
    };
    const sessionMgr = { getCwd: () => tempDir, getSessionFile: () => sessionFile };
    const agent = {
      id: "codia",
      agentDir,
      sessionDir,
      config: { locale: "en", tools: { disabled: [] } },
      memoryMasterEnabled: true,
      sessionMemoryEnabled: true,
      setMemoryEnabled: vi.fn(),
      buildSystemPrompt: vi.fn(() => promptText),
      getToolsSnapshot: vi.fn(() => []),
    };
    const session = {
      model: { id: "default-model", provider: "test-provider", name: "Default" },
      sessionManager: { getSessionFile: () => sessionFile },
      subscribe: vi.fn(() => vi.fn()),
      setActiveToolsByName: vi.fn(),
    };
    createAgentSessionMock.mockResolvedValue({ session });

    const coordinator = new SessionCoordinator({
      agentsDir: path.join(tempDir, "agents"),
      getAgent: () => agent,
      getActiveAgentId: () => "codia",
      getModels: () => ({
        currentModel: { id: "default-model", provider: "test-provider", name: "Default" },
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({
        getSystemPrompt: () => "BASE PROMPT",
        getAppendSystemPrompt: () => ["base append"],
        getAgentsFiles: () => ({ agentsFiles: [{ path: "AGENTS.md", content: "original" }] }),
      }),
      getSkills: () => ({ getSkillsForAgent: () => runtimeSkillsResult }),
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: () => {},
      emitDevLog: () => {},
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => null,
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [],
    });

    await coordinator.createSession(sessionMgr, tempDir, true);
    const metaPath = path.join(sessionDir, "session-meta.json");
    const persisted = JSON.parse(fs.readFileSync(metaPath, "utf-8"))[path.basename(sessionFile)].promptSnapshot;
    expect(persisted.systemPrompt).toBe("PROMPT ONE");
    expect(persisted.appendSystemPrompt[0]).toBe("base append");
    expect(persisted.appendSystemPrompt[1]).toContain("## Workspace Scope");
    expect(persisted.appendSystemPrompt[1]).toContain(tempDir);
    expect(persisted.skillsResult.skills[0].runtimeIdentity.kind).toBe("skill_pointer");
    expect(persisted.skillsResult.skills[0].name).toBe("one");
    expect(persisted.agentsFilesResult.agentsFiles).toEqual([{ path: "AGENTS.md", content: "original" }]);

    promptText = "PROMPT TWO";
    runtimeSkillsResult = {
      skills: [{ name: "two", filePath: path.join(skillTwoDir, "SKILL.md"), baseDir: skillTwoDir, source: "user" }],
      diagnostics: [],
    };
    agent.buildSystemPrompt.mockClear();
    createAgentSessionMock.mockClear();

    await coordinator.createSession(sessionMgr, tempDir, true, null, { restore: true });

    const restoredLoader = createAgentSessionMock.mock.calls[0][0].resourceLoader;
    expect(agent.buildSystemPrompt).not.toHaveBeenCalled();
    expect(restoredLoader.getSystemPrompt()).toBe("PROMPT ONE");
    expect(restoredLoader.getAppendSystemPrompt()).toEqual(persisted.appendSystemPrompt);
    expect(restoredLoader.getSkills().skills.map((skill) => skill.name)).toEqual(["one"]);
    expect(restoredLoader.getAgentsFiles()).toEqual({ agentsFiles: [{ path: "AGENTS.md", content: "original" }] });
  });

  it("keeps newly created sessions hidden from the sidebar until the first prompt", async () => {
    const agentsDir = path.join(tempDir, "agents");
    const agentDir = path.join(agentsDir, "codia");
    const sessionDir = path.join(agentDir, "sessions");
    const sessionFile = path.join(sessionDir, "hidden-new.jsonl");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(sessionFile, [
      JSON.stringify({ type: "session", id: "sess_hidden", timestamp: "2026-06-24T01:00:00.000Z", cwd: tempDir }),
    ].join("\n"), "utf-8");

    const session = {
      sessionManager: { getSessionFile: () => sessionFile, getCwd: () => tempDir },
      subscribe: vi.fn(() => vi.fn()),
      setActiveToolsByName: vi.fn(),
      setThinkingLevel: vi.fn(),
      getContextUsage: vi.fn(() => ({ tokens: 0, contextWindow: 1000 })),
      prompt: vi.fn(async () => {}),
      model: { id: "model-a", provider: "test" },
      messages: [],
    };
    createAgentSessionMock.mockResolvedValue({ session });
    sessionManagerCreateMock.mockReturnValue(session.sessionManager);

    const agent = {
      id: "codia",
      name: "Codia",
      agentName: "Codia",
      agentDir,
      sessionDir,
      sessionMemoryEnabled: true,
      setMemoryEnabled: vi.fn(),
      buildSystemPrompt: () => "SYSTEM",
      getToolsSnapshot: () => [],
      config: { tools: { disabled: [] } },
      tools: [],
    };

    const coordinator = new SessionCoordinator({
      agentsDir,
      getAgent: () => agent,
      getActiveAgentId: () => "codia",
      getModels: () => ({
        currentModel: { id: "model-a", provider: "test" },
        availableModels: [{ id: "model-a", provider: "test" }],
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: (level) => level,
      }),
      getResourceLoader: () => ({
        getSystemPrompt: () => "SYSTEM",
        getAppendSystemPrompt: () => [],
        getExtensions: () => ({ extensions: [], errors: [] }),
      }),
      getSkills: () => null,
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: () => {},
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => "codia",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [{ id: "codia", name: "Codia" }],
    });

    await coordinator.createSession(null, tempDir, true);

    expect(await coordinator.listSessions()).toEqual([]);

    await coordinator.promptSession(sessionFile, "hello", {});

    expect(await coordinator.listSessions()).toEqual([
      expect.objectContaining({ path: sessionFile, visibleInSessionList: true }),
    ]);
    const meta = JSON.parse(fs.readFileSync(path.join(sessionDir, "session-meta.json"), "utf-8"));
    expect(meta[path.basename(sessionFile)].visibleInSessionList).toBe(true);
  });

  it("restores the final SDK prompt snapshot without rebuilding current agent state", async () => {
    const agentDir = path.join(tempDir, "agents", "codia");
    const sessionDir = path.join(agentDir, "sessions");
    const sessionFile = path.join(sessionDir, "final-prompt.jsonl");
    fs.mkdirSync(sessionDir, { recursive: true });

    let promptText = "SYSTEM PROMPT V1";
    const agent = {
      id: "codia",
      agentDir,
      sessionDir,
      config: { locale: "en", tools: { disabled: [] } },
      memoryMasterEnabled: true,
      sessionMemoryEnabled: true,
      setMemoryEnabled: vi.fn(),
      buildSystemPrompt: vi.fn(() => promptText),
      getToolsSnapshot: vi.fn(() => []),
    };
    const freshSession = {
      model: { id: "default-model", provider: "test-provider", name: "Default" },
      sessionManager: { getSessionFile: () => sessionFile },
      subscribe: vi.fn(() => vi.fn()),
      setActiveToolsByName: vi.fn(),
      _baseSystemPrompt: "FINAL PROMPT V1",
      agent: { state: { systemPrompt: "FINAL PROMPT V1" } },
    };
    const restoredSession = {
      model: { id: "default-model", provider: "test-provider", name: "Default" },
      sessionManager: { getSessionFile: () => sessionFile },
      subscribe: vi.fn(() => vi.fn()),
      setActiveToolsByName: vi.fn(function () {
        this._baseSystemPrompt = "FINAL PROMPT CURRENT";
        this.agent.state.systemPrompt = "FINAL PROMPT CURRENT";
      }),
      _baseSystemPrompt: "FINAL PROMPT CURRENT",
      agent: { state: { systemPrompt: "FINAL PROMPT CURRENT" } },
    };
    createAgentSessionMock
      .mockResolvedValueOnce({ session: freshSession })
      .mockResolvedValueOnce({ session: restoredSession });

    const coordinator = new SessionCoordinator({
      agentsDir: path.join(tempDir, "agents"),
      getAgent: () => agent,
      getActiveAgentId: () => "codia",
      getModels: () => ({
        currentModel: { id: "default-model", provider: "test-provider", name: "Default" },
        availableModels: [{ id: "default-model", provider: "test-provider", name: "Default" }],
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({
        getAppendSystemPrompt: () => ["BASE APPEND V1"],
        getAgentsFiles: () => ({ agentsFiles: [] }),
      }),
      getSkills: () => ({ getSkillsForAgent: () => ({ skills: [], diagnostics: [] }) }),
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: () => {},
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => null,
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [],
    });

    const sessionMgr = {
      getCwd: () => tempDir,
      getSessionFile: () => sessionFile,
      buildSessionContext: () => ({ model: { provider: "test-provider", modelId: "default-model" } }),
    };

    await coordinator.createSession(sessionMgr, tempDir, true);
    promptText = "SYSTEM PROMPT V2";
    agent.buildSystemPrompt.mockClear();
    await coordinator.createSession(sessionMgr, tempDir, true, null, { restore: true });

    const restoredLoader = createAgentSessionMock.mock.calls[1][0].resourceLoader;
    expect(restoredLoader.getSystemPrompt()).toBe("SYSTEM PROMPT V1");
    expect(restoredSession._baseSystemPrompt).toBe("FINAL PROMPT V1");
    expect(restoredSession.agent.state.systemPrompt).toBe("FINAL PROMPT V1");
    expect(agent.buildSystemPrompt).not.toHaveBeenCalled();
  });

  it("refreshes the desktop session capability baseline after a fresh compact", async () => {
    const agentDir = path.join(tempDir, "agents", "codia");
    const sessionDir = path.join(agentDir, "sessions");
    const sessionFile = path.join(sessionDir, "fresh-compact-baseline.jsonl");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "session-meta.json"), JSON.stringify({
      [path.basename(sessionFile)]: {
        toolNames: ["read"],
        promptSnapshot: {
          version: 1,
          systemPrompt: "SYSTEM PROMPT V1",
          appendSystemPrompt: [],
          skillsResult: { skills: [], diagnostics: [] },
          agentsFilesResult: { agentsFiles: [] },
          finalSystemPrompt: "FINAL PROMPT V1",
        },
      },
    }, null, 2));

    const readTool = { name: "read", description: "Read files", parameters: { type: "object" } };
    const browserTool = { name: "browser", description: "Use browser", parameters: { type: "object" } };
    const session = {
      model: { id: "default-model", provider: "test-provider", name: "Default" },
      sessionManager: { getSessionFile: () => sessionFile },
      subscribe: vi.fn(() => vi.fn()),
      setActiveToolsByName: vi.fn((names) => {
        session.agent.state.tools = names
          .map((name) => ({ read: readTool, browser: browserTool })[name])
          .filter(Boolean);
      }),
      compact: vi.fn(async () => {}),
      getContextUsage: vi.fn(() => ({ tokens: 1000, contextWindow: 200000 })),
      _baseSystemPrompt: "FINAL PROMPT V2",
      agent: {
        state: {
          systemPrompt: "FINAL PROMPT V2",
          tools: [readTool, browserTool],
          messages: [],
        },
      },
    };
    createAgentSessionMock.mockResolvedValue({ session });

    const agent = {
      id: "codia",
      agentDir,
      sessionDir,
      config: { locale: "en", tools: { disabled: [] } },
      memoryMasterEnabled: true,
      sessionMemoryEnabled: true,
      setMemoryEnabled: vi.fn(),
      buildSystemPrompt: vi.fn(() => "SYSTEM PROMPT V2"),
      getToolsSnapshot: vi.fn(() => []),
    };
    const coordinator = new SessionCoordinator({
      agentsDir: path.join(tempDir, "agents"),
      getAgent: () => agent,
      getActiveAgentId: () => "codia",
      getModels: () => ({
        currentModel: { id: "default-model", provider: "test-provider", name: "Default" },
        availableModels: [{ id: "default-model", provider: "test-provider", name: "Default" }],
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({
        getAppendSystemPrompt: () => [],
        getAgentsFiles: () => ({ agentsFiles: [] }),
      }),
      getSkills: () => ({ getSkillsForAgent: () => ({ skills: [], diagnostics: [] }) }),
      buildTools: () => ({ tools: [readTool], customTools: [browserTool] }),
      emitEvent: () => {},
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => "codia",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [],
    });

    await coordinator.createSession({
      getCwd: () => tempDir,
      getSessionFile: () => sessionFile,
      buildSessionContext: () => ({ model: { provider: "test-provider", modelId: "default-model" } }),
    }, tempDir, true, null, { restore: true });

    expect(coordinator.getSessionCapabilityDriftNotice(sessionFile)).toMatchObject({
      addedToolNames: ["browser"],
      promptChanged: false,
    });

    await session.compact();
    session._baseSystemPrompt = "FINAL PROMPT V2";
    session.agent.state.systemPrompt = "FINAL PROMPT V2";
    await coordinator.refreshSessionCapabilityBaseline(sessionFile);

    expect(coordinator.getSessionCapabilityDriftNotice(sessionFile)).toBeNull();
    expect(session.setActiveToolsByName).toHaveBeenLastCalledWith(["read", "browser"]);
    const meta = JSON.parse(fs.readFileSync(path.join(sessionDir, "session-meta.json"), "utf-8"));
    expect(meta[path.basename(sessionFile)].toolNames).toEqual(["read", "browser"]);
    expect(meta[path.basename(sessionFile)].promptSnapshot.finalSystemPrompt).toBe("FINAL PROMPT V2");
    expect(meta[path.basename(sessionFile)].capabilityDriftDismissedFingerprint).toBeNull();
  });

  it("reloads a desktop session runtime through the original restore path", async () => {
    const agentDir = path.join(tempDir, "agents", "codia");
    const sessionDir = path.join(agentDir, "sessions");
    const sessionFile = path.join(sessionDir, "reload.jsonl");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(sessionFile, "", "utf-8");

    const oldSession = {
      isStreaming: false,
      isCompacting: false,
      sessionManager: { getSessionFile: () => sessionFile },
      subscribe: vi.fn(() => vi.fn()),
      dispose: vi.fn(),
      setActiveToolsByName: vi.fn(),
      agent: { state: { tools: [] } },
    };
    const reloadedSession = {
      isStreaming: false,
      isCompacting: false,
      sessionManager: { getSessionFile: () => sessionFile },
      subscribe: vi.fn(() => vi.fn()),
      setActiveToolsByName: vi.fn(),
      agent: { state: { tools: [] } },
    };
    createAgentSessionMock
      .mockResolvedValueOnce({ session: oldSession })
      .mockResolvedValueOnce({ session: reloadedSession });

    const agent = {
      id: "codia",
      agentDir,
      sessionDir,
      config: { locale: "en", tools: { disabled: [] } },
      memoryMasterEnabled: true,
      sessionMemoryEnabled: true,
      setMemoryEnabled: vi.fn(),
      buildSystemPrompt: vi.fn(() => "SYSTEM PROMPT"),
      getToolsSnapshot: vi.fn(() => []),
    };
    const coordinator = new SessionCoordinator({
      agentsDir: path.join(tempDir, "agents"),
      getAgent: () => agent,
      getActiveAgentId: () => "codia",
      getModels: () => ({
        currentModel: { id: "default-model", provider: "test-provider", name: "Default" },
        availableModels: [{ id: "default-model", provider: "test-provider", name: "Default" }],
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({
        getAppendSystemPrompt: () => [],
        getAgentsFiles: () => ({ agentsFiles: [] }),
      }),
      getSkills: () => ({ getSkillsForAgent: () => ({ skills: [], diagnostics: [] }) }),
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: () => {},
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => "codia",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [],
    });

    await coordinator.createSession({
      getCwd: () => tempDir,
      getSessionFile: () => sessionFile,
      buildSessionContext: () => ({ model: { provider: "test-provider", modelId: "default-model" } }),
    }, tempDir, true, null, { restore: true });

    coordinator._session = null;
    coordinator._currentSessionPath = null;

    const result = await coordinator.reloadSessionRuntime(sessionFile, {
      refreshCapabilitySnapshots: true,
    });

    expect(result).toBe(reloadedSession);
    expect(oldSession.dispose).toHaveBeenCalled();
    expect(sessionManagerOpenMock).toHaveBeenCalledWith(sessionFile, sessionDir);
    expect(createAgentSessionMock).toHaveBeenCalledTimes(2);
    expect(coordinator.getSessionByPath(sessionFile)).toBe(reloadedSession);
    expect(coordinator.currentSessionPath).toBe(sessionFile);
    const meta = JSON.parse(fs.readFileSync(path.join(sessionDir, "session-meta.json"), "utf-8"));
    expect(meta[path.basename(sessionFile)].capabilityDriftDismissedFingerprint).toBeNull();
  });

  it("keeps legacy create_artifact out of fresh sessions but restores it for old sessions", async () => {
    const agentDir = path.join(tempDir, "agents", "codia");
    const sessionDir = path.join(agentDir, "sessions");
    const freshFile = path.join(sessionDir, "fresh.jsonl");
    const legacyFile = path.join(sessionDir, "legacy.jsonl");
    fs.mkdirSync(sessionDir, { recursive: true });

    const session = (sessionFile) => ({
      model: { id: "default-model", provider: "test-provider", name: "Default" },
      sessionManager: { getSessionFile: () => sessionFile },
      subscribe: vi.fn(() => vi.fn()),
      setActiveToolsByName: vi.fn(),
    });
    createAgentSessionMock
      .mockResolvedValueOnce({ session: session(freshFile) })
      .mockResolvedValueOnce({ session: session(legacyFile) })
      .mockResolvedValueOnce({ session: session(legacyFile) });

    const agent = {
      id: "codia",
      agentDir,
      sessionDir,
      config: { tools: { disabled: [] } },
      memoryMasterEnabled: true,
      sessionMemoryEnabled: true,
      experienceEnabled: false,
      setMemoryEnabled: vi.fn(),
      buildSystemPrompt: vi.fn(() => "prompt"),
      getToolsSnapshot: vi.fn((options = {}) => [
        { name: "stage_files" },
        ...(options.includeLegacyArtifactTool ? [{ name: "create_artifact" }] : []),
      ]),
    };

    const coordinator = new SessionCoordinator({
      agentsDir: path.join(tempDir, "agents"),
      getAgent: () => agent,
      getActiveAgentId: () => "codia",
      getModels: () => ({
        currentModel: { id: "default-model", provider: "test-provider", name: "Default" },
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({ getAppendSystemPrompt: () => [] }),
      getSkills: () => ({ getSkillsForAgent: () => ({ skills: [], diagnostics: [] }) }),
      buildTools: (_cwd, customTools) => ({ tools: [], customTools }),
      emitEvent: () => {},
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => null,
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [],
    });

    await coordinator.createSession({ getCwd: () => tempDir, getSessionFile: () => freshFile }, tempDir, true);
    expect(agent.getToolsSnapshot.mock.calls[0][0]).not.toHaveProperty("includeLegacyArtifactTool", true);

    await coordinator.createSession({ getCwd: () => tempDir, getSessionFile: () => legacyFile }, tempDir, true, null, { restore: true });
    expect(agent.getToolsSnapshot.mock.calls[1][0]).toMatchObject({ includeLegacyArtifactTool: true });

    await coordinator.writeSessionMeta(legacyFile, { toolNames: ["stage_files"] });
    await coordinator.createSession({ getCwd: () => tempDir, getSessionFile: () => legacyFile }, tempDir, true, null, { restore: true });
    expect(agent.getToolsSnapshot.mock.calls[2][0]).not.toHaveProperty("includeLegacyArtifactTool", true);
  });

  it("excludes tools disabled by runtime agent-config checks from new session snapshots", async () => {
    const sessionFile = path.join(tempDir, "agents", "codia", "sessions", "main.jsonl");
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    const sessionMgr = { getCwd: () => tempDir, getSessionFile: () => sessionFile };
    const session = {
      model: { id: "default-model", provider: "test-provider", name: "Default" },
      sessionManager: { getSessionFile: () => sessionFile },
      subscribe: vi.fn(() => vi.fn()),
      setActiveToolsByName: vi.fn(),
    };
    createAgentSessionMock.mockResolvedValue({ session });

    const agent = {
      id: "codia",
      agentDir: path.dirname(path.dirname(sessionFile)),
      sessionDir: path.dirname(sessionFile),
      config: { tools: { disabled: [] } },
      memoryMasterEnabled: true,
      sessionMemoryEnabled: true,
      setMemoryEnabled: vi.fn(),
      buildSystemPrompt: vi.fn(() => "prompt"),
      getToolsSnapshot: vi.fn(() => []),
    };

    const coordinator = new SessionCoordinator({
      agentsDir: path.join(tempDir, "agents"),
      getAgent: () => agent,
      getActiveAgentId: () => "codia",
      getModels: () => ({
        currentModel: { id: "default-model", provider: "test-provider", name: "Default" },
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({ getAppendSystemPrompt: () => [] }),
      getSkills: () => ({ getSkillsForAgent: () => ({ skills: [], diagnostics: [] }) }),
      buildTools: () => ({
        tools: [
          { name: "read" },
          { name: "runtime_off", isEnabledForAgentConfig: () => false },
        ],
        customTools: [{ name: "custom_on", isEnabledForAgentConfig: () => true }],
      }),
      emitEvent: () => {},
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => null,
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [],
    });

    await coordinator.createSession(sessionMgr, tempDir, true);

    expect(session.setActiveToolsByName).toHaveBeenCalledWith(["read", "custom_on"]);
  });

  it("keeps default media generation plugin tools when restoring a legacy session without toolNames", async () => {
    const sessionFile = path.join(tempDir, "agents", "codia", "sessions", "legacy.jsonl");
    const metaPath = path.join(path.dirname(sessionFile), "session-meta.json");
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(metaPath, JSON.stringify({
      [path.basename(sessionFile)]: { memoryEnabled: true },
    }, null, 2), "utf-8");

    const sessionMgr = { getCwd: () => tempDir, getSessionFile: () => sessionFile };
    const session = {
      model: { id: "default-model", provider: "test-provider", name: "Default" },
      sessionManager: { getSessionFile: () => sessionFile },
      subscribe: vi.fn(() => vi.fn()),
      setActiveToolsByName: vi.fn(),
    };
    createAgentSessionMock.mockResolvedValue({ session });

    const imageTool = { name: "image-gen_generate-image", _pluginId: "image-gen" };
    const providerVideoTool = { name: "image-gen_generate-video", _pluginId: "image-gen" };
    const arbitraryPluginTool = { name: "other-plugin_do-work", _pluginId: "other-plugin" };
    const agent = {
      id: "codia",
      agentDir: path.dirname(path.dirname(sessionFile)),
      sessionDir: path.dirname(sessionFile),
      config: { tools: { disabled: [] } },
      memoryMasterEnabled: true,
      sessionMemoryEnabled: true,
      setMemoryEnabled: vi.fn(),
      buildSystemPrompt: vi.fn(() => "prompt"),
      getToolsSnapshot: vi.fn(() => []),
    };

    const coordinator = new SessionCoordinator({
      agentsDir: path.join(tempDir, "agents"),
      getAgent: () => agent,
      getActiveAgentId: () => "codia",
      getModels: () => ({
        currentModel: { id: "default-model", provider: "test-provider", name: "Default" },
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({ getAppendSystemPrompt: () => [] }),
      getSkills: () => ({ getSkillsForAgent: () => ({ skills: [], diagnostics: [] }) }),
      buildTools: () => ({
        tools: [{ name: "read" }],
        customTools: [
          { name: "custom_on" },
          imageTool,
          providerVideoTool,
          arbitraryPluginTool,
        ],
      }),
      emitEvent: () => {},
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => null,
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [],
    });

    await coordinator.createSession(sessionMgr, tempDir, true, null, { restore: true });

    expect(session.setActiveToolsByName).toHaveBeenCalledWith([
      "read",
      "custom_on",
      "image-gen_generate-image",
      "image-gen_generate-video",
    ]);

    const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
    expect(meta[path.basename(sessionFile)].toolNames).toEqual([
      "read",
      "custom_on",
      "image-gen_generate-image",
      "image-gen_generate-video",
    ]);
  });

  it("deduplicates restored toolNames before applying them back to the session", async () => {
    const sessionFile = path.join(tempDir, "agents", "codia", "sessions", "restored.jsonl");
    const metaPath = path.join(path.dirname(sessionFile), "session-meta.json");
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(metaPath, JSON.stringify({
      [path.basename(sessionFile)]: { toolNames: ["read", "generate-image", "read", "generate-image"] },
    }, null, 2), "utf-8");

    const sessionMgr = { getCwd: () => tempDir, getSessionFile: () => sessionFile };
    const session = {
      model: { id: "default-model", provider: "test-provider", name: "Default" },
      sessionManager: { getSessionFile: () => sessionFile },
      subscribe: vi.fn(() => vi.fn()),
      setActiveToolsByName: vi.fn(),
    };
    createAgentSessionMock.mockResolvedValue({ session });

    const agent = {
      id: "codia",
      agentDir: path.dirname(path.dirname(sessionFile)),
      sessionDir: path.dirname(sessionFile),
      config: { tools: { disabled: [] } },
      memoryMasterEnabled: true,
      sessionMemoryEnabled: true,
      setMemoryEnabled: vi.fn(),
      buildSystemPrompt: vi.fn(() => "prompt"),
      getToolsSnapshot: vi.fn(() => []),
    };

    const coordinator = new SessionCoordinator({
      agentsDir: path.join(tempDir, "agents"),
      getAgent: () => agent,
      getActiveAgentId: () => "codia",
      getModels: () => ({
        currentModel: { id: "default-model", provider: "test-provider", name: "Default" },
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({ getAppendSystemPrompt: () => [] }),
      getSkills: () => ({ getSkillsForAgent: () => ({ skills: [], diagnostics: [] }) }),
      buildTools: () => ({
        tools: [{ name: "read" }],
        customTools: [{ name: "generate-image", _pluginId: "image-gen" }],
      }),
      emitEvent: () => {},
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => null,
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [],
    });

    await coordinator.createSession(sessionMgr, tempDir, true, null, { restore: true });

    expect(session.setActiveToolsByName).toHaveBeenCalledWith(["read", "generate-image"]);

    const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
    expect(meta[path.basename(sessionFile)].toolNames).toEqual(["read", "generate-image"]);
  });

  it("switches only the current session permission mode without changing the default", async () => {
    const sessionFile = path.join(tempDir, "agents", "codia", "sessions", "main.jsonl");
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    const sessionMgr = { getCwd: () => tempDir, getSessionFile: () => sessionFile };
    const session = {
      model: { id: "default-model", provider: "test-provider", name: "Default" },
      sessionManager: { getSessionFile: () => sessionFile },
      subscribe: vi.fn(() => vi.fn()),
      setActiveToolsByName: vi.fn(),
    };
    createAgentSessionMock.mockResolvedValue({ session });

    const defaultModeSave = vi.fn();
    const agent = {
      id: "codia",
      agentDir: path.dirname(path.dirname(sessionFile)),
      sessionDir: path.dirname(sessionFile),
      config: { tools: { disabled: [] } },
      memoryMasterEnabled: true,
      sessionMemoryEnabled: true,
      setMemoryEnabled: vi.fn(),
      buildSystemPrompt: vi.fn(() => "prompt"),
      getToolsSnapshot: vi.fn(() => []),
    };

    const coordinator = new SessionCoordinator({
      agentsDir: path.join(tempDir, "agents"),
      getAgent: () => agent,
      getActiveAgentId: () => "codia",
      getModels: () => ({
        currentModel: { id: "default-model", provider: "test-provider", name: "Default" },
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({ getAppendSystemPrompt: () => [] }),
      getSkills: () => ({ getSkillsForAgent: () => ({ skills: [], diagnostics: [] }) }),
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: () => {},
      emitDevLog: () => {},
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => null,
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({
        getThinkingLevel: () => "medium",
        getSessionPermissionModeDefault: () => "ask",
        setSessionPermissionModeDefault: defaultModeSave,
      }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [],
    });

    await coordinator.createSession(sessionMgr, tempDir, true);
    const result = coordinator.setCurrentSessionPermissionMode("operate");

    expect(result).toMatchObject({ ok: true, mode: "operate", enabled: false });
    expect(coordinator.getPermissionMode(sessionFile)).toBe("operate");
    expect(coordinator.getPermissionModeDefault()).toBe("ask");
    expect(defaultModeSave).not.toHaveBeenCalled();

    await coordinator._metaWriteQueue;
    const meta = JSON.parse(fs.readFileSync(path.join(path.dirname(sessionFile), "session-meta.json"), "utf-8"));
    expect(meta[path.basename(sessionFile)]).toMatchObject({
      permissionMode: "operate",
      accessMode: "operate",
      planMode: false,
    });
  });

  it("auto-compacts a nearly full context before sending the next prompt", async () => {
    const sessionFile = path.join(tempDir, "agents", "codia", "sessions", "auto-compact.jsonl");
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    const sessionMgr = { getCwd: () => tempDir, getSessionFile: () => sessionFile };
    const events = [];
    let usageTokens = 92_000;
    const session = {
      model: { id: "relay-gpt", provider: "relay", name: "Relay GPT", contextWindow: 100_000 },
      sessionManager: { getSessionFile: () => sessionFile },
      subscribe: vi.fn(() => vi.fn()),
      setActiveToolsByName: vi.fn(),
      getContextUsage: vi.fn(() => ({
        tokens: usageTokens,
        contextWindow: 100_000,
        percent: usageTokens / 100_000,
      })),
      compact: vi.fn(async () => {
        usageTokens = 30_000;
      }),
      prompt: vi.fn(async () => {}),
      isStreaming: false,
      isCompacting: false,
    };
    createAgentSessionMock.mockResolvedValue({ session });

    const agent = {
      id: "codia",
      agentDir: path.dirname(path.dirname(sessionFile)),
      sessionDir: path.dirname(sessionFile),
      config: { tools: { disabled: [] } },
      memoryMasterEnabled: true,
      sessionMemoryEnabled: true,
      setMemoryEnabled: vi.fn(),
      buildSystemPrompt: vi.fn(() => "prompt"),
      getToolsSnapshot: vi.fn(() => []),
      _memoryTicker: { notifyTurn: vi.fn() },
    };

    const coordinator = new SessionCoordinator({
      agentsDir: path.join(tempDir, "agents"),
      getAgent: () => agent,
      getActiveAgentId: () => "codia",
      getModels: () => ({
        currentModel: { id: "relay-gpt", provider: "relay", name: "Relay GPT", contextWindow: 100_000 },
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({ getAppendSystemPrompt: () => [] }),
      getSkills: () => ({ getSkillsForAgent: () => ({ skills: [], diagnostics: [] }) }),
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: (event, sp) => events.push({ event, sp }),
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => null,
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [],
    });

    await coordinator.createSession(sessionMgr, tempDir, true);
    await coordinator.promptSession(sessionFile, "continue", {});

    expect(session.compact).toHaveBeenCalledOnce();
    expect(session.prompt).toHaveBeenCalledWith("continue", undefined);
    expect(events).toEqual(expect.arrayContaining([
      { event: { type: "auto_compaction_start" }, sp: sessionFile },
      { event: expect.objectContaining({ type: "auto_compaction_end" }), sp: sessionFile },
    ]));
  });

  it("does not auto-compact when SDK reports percent as a low 0-100 percentage", async () => {
    const sessionFile = path.join(tempDir, "agents", "codia", "sessions", "auto-compact-low-percent.jsonl");
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    const sessionMgr = { getCwd: () => tempDir, getSessionFile: () => sessionFile };
    const events = [];
    const session = {
      model: { id: "relay-gpt", provider: "relay", name: "Relay GPT", contextWindow: 100_000 },
      sessionManager: { getSessionFile: () => sessionFile },
      subscribe: vi.fn(() => vi.fn()),
      setActiveToolsByName: vi.fn(),
      getContextUsage: vi.fn(() => ({
        tokens: 10_000,
        contextWindow: 100_000,
        percent: 10,
      })),
      compact: vi.fn(async () => {}),
      prompt: vi.fn(async () => {}),
      isStreaming: false,
      isCompacting: false,
    };
    createAgentSessionMock.mockResolvedValue({ session });

    const agent = {
      id: "codia",
      agentDir: path.dirname(path.dirname(sessionFile)),
      sessionDir: path.dirname(sessionFile),
      config: { tools: { disabled: [] } },
      memoryMasterEnabled: true,
      sessionMemoryEnabled: true,
      setMemoryEnabled: vi.fn(),
      buildSystemPrompt: vi.fn(() => "prompt"),
      getToolsSnapshot: vi.fn(() => []),
      _memoryTicker: { notifyTurn: vi.fn() },
    };

    const coordinator = new SessionCoordinator({
      agentsDir: path.join(tempDir, "agents"),
      getAgent: () => agent,
      getActiveAgentId: () => "codia",
      getModels: () => ({
        currentModel: { id: "relay-gpt", provider: "relay", name: "Relay GPT", contextWindow: 100_000 },
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({ getAppendSystemPrompt: () => [] }),
      getSkills: () => ({ getSkillsForAgent: () => ({ skills: [], diagnostics: [] }) }),
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: (event, sp) => events.push({ event, sp }),
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => null,
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [],
    });

    await coordinator.createSession(sessionMgr, tempDir, true);
    await coordinator.promptSession(sessionFile, "continue", {});

    expect(session.compact).not.toHaveBeenCalled();
    expect(session.prompt).toHaveBeenCalledWith("continue", undefined);
    expect(events).not.toContainEqual({ event: { type: "auto_compaction_start" }, sp: sessionFile });
  });

  it("records a lifecycle trace around promptSession and exposes it to tool wrappers", async () => {
    const sessionFile = path.join(tempDir, "agents", "codia", "sessions", "trace.jsonl");
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    const sessionMgr = { getCwd: () => tempDir, getSessionFile: () => sessionFile };
    let buildToolsOpts = null;
    const traceStore = {
      startTrace: vi.fn(() => ({
        traceId: "trace-session",
        sessionPath: sessionFile,
        agentId: "codia",
        status: "running",
      })),
      recordPhase: vi.fn(),
      endTrace: vi.fn(),
    };
    const session = {
      model: { id: "relay-gpt", provider: "relay", name: "Relay GPT" },
      sessionManager: { getSessionFile: () => sessionFile },
      subscribe: vi.fn(() => vi.fn()),
      setActiveToolsByName: vi.fn(),
      prompt: vi.fn(async () => {
        expect(buildToolsOpts.getTraceContext()).toMatchObject({
          traceId: "trace-session",
          sessionPath: sessionFile,
          agentId: "codia",
        });
      }),
      isStreaming: false,
      isCompacting: false,
    };
    createAgentSessionMock.mockResolvedValue({ session });

    const agent = {
      id: "codia",
      agentDir: path.dirname(path.dirname(sessionFile)),
      sessionDir: path.dirname(sessionFile),
      config: { tools: { disabled: [] } },
      memoryMasterEnabled: true,
      sessionMemoryEnabled: true,
      setMemoryEnabled: vi.fn(),
      buildSystemPrompt: vi.fn(() => "prompt"),
      getToolsSnapshot: vi.fn(() => []),
      _memoryTicker: { notifyTurn: vi.fn() },
    };

    const coordinator = new SessionCoordinator({
      agentsDir: path.join(tempDir, "agents"),
      getAgent: () => agent,
      getActiveAgentId: () => "codia",
      getModels: () => ({
        currentModel: { id: "relay-gpt", provider: "relay", name: "Relay GPT" },
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({ getAppendSystemPrompt: () => [] }),
      getSkills: () => ({ getSkillsForAgent: () => ({ skills: [], diagnostics: [] }) }),
      buildTools: (_cwd, _customTools, opts) => {
        buildToolsOpts = opts;
        return { tools: [], customTools: [] };
      },
      emitEvent: () => {},
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => null,
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [],
      runtimeTraceStore: traceStore,
    });

    await coordinator.createSession(sessionMgr, tempDir, true);
    await coordinator.promptSession(sessionFile, "continue", { traceId: "trace-session" });

    expect(traceStore.startTrace).toHaveBeenCalledWith(expect.objectContaining({
      traceId: "trace-session",
      sessionPath: sessionFile,
      agentId: "codia",
      kind: "chat_turn",
    }));
    expect(traceStore.recordPhase.mock.calls.map((call) => call[1])).toEqual(expect.arrayContaining([
      "input.received",
      "message.parsed",
      "context.assembled",
      "model.route",
      "model.stream.start",
      "state.updated",
      "render.emitted",
    ]));
    expect(traceStore.endTrace).toHaveBeenCalledWith("trace-session", expect.objectContaining({
      status: "completed",
    }));
  });

  it("uses the agent system prompt for isolated execution and reserves subagent prompt building for subagents only", async () => {
    createAgentSessionMock.mockResolvedValue({
      session: {
        sessionManager: { getSessionFile: () => null },
        subscribe: vi.fn(() => vi.fn()),
        prompt: vi.fn(async () => {}),
      },
    });

    const targetAgent = {
      agentDir: tempDir,
      sessionDir: tempDir,
      agentName: "test-agent",
      config: {
        locale: "zh",
        models: { chat: "default-model" },
      },
      tools: [],
      memoryEnabled: false,
      sessionMemoryEnabled: false,
      setMemoryEnabled: vi.fn(),
      systemPrompt: "MASTER PROMPT",
      buildSystemPrompt: vi.fn(() => "SUBAGENT PROMPT"),
    };

    const coordinator = new SessionCoordinator({
      agentsDir: "/tmp/agents",
      getAgent: () => targetAgent,
      getActiveAgentId: () => "codia",
      getModels: () => ({
        authStorage: {},
        modelRegistry: {},
        defaultModel: { id: "default-model", provider: "test-provider" },
        availableModels: [{ id: "default-model", provider: "test-provider" }],
        resolveExecutionModel: (model) => model,
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({ getSystemPrompt: () => "BASE PROMPT" }),
      getSkills: () => ({ getSkillsForAgent: () => [] }),
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: () => {},
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => null,
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => targetAgent,
      listAgents: () => [],
    });

    await coordinator.executeIsolated("hello", { withMemory: true });

    expect(targetAgent.setMemoryEnabled).not.toHaveBeenCalled();
    expect(targetAgent.buildSystemPrompt).not.toHaveBeenCalled();
    expect(createAgentSessionMock.mock.calls[0][0].resourceLoader.getSystemPrompt()).toBe("MASTER PROMPT");

    createAgentSessionMock.mockClear();
    await coordinator.executeIsolated("hello", { subagentContext: true });

    expect(targetAgent.buildSystemPrompt).toHaveBeenCalledWith({ forSubagent: true });
    expect(createAgentSessionMock.mock.calls[0][0].resourceLoader.getSystemPrompt()).toBe("SUBAGENT PROMPT");

    // Exercise the real execution gate: it must run before session.prompt,
    // rather than merely attaching hashes to a completed action.
    const prompt = vi.fn();
    const dispose = vi.fn();
    createAgentSessionMock.mockResolvedValue({ session: {
      model: { id: "resolved", provider: "actual-provider" },
      agent: { state: { systemPrompt: "FINAL RESOLVED PROMPT", tools: [] } },
      sessionManager: { getSessionFile: () => null }, prompt, dispose,
    } });
    const rejected = await coordinator.executeIsolated("guarded", {
      subagentContext: true,
      workflowRuntimeGuard: () => { throw new Error("runtime mismatch"); },
    });
    expect(rejected.error).toBe("runtime mismatch");
    expect(prompt).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledTimes(1);
    const guard = vi.fn(() => ({ replay: true, result: "cached" }));
    const replay = await coordinator.executeIsolated("guarded", { subagentContext: true, workflowRuntimeGuard: guard });
    expect(replay.workflowReplay).toBe(true);
    expect(guard).toHaveBeenCalledWith(expect.objectContaining({ version: 1, model: expect.any(String), tools: expect.any(String), prompt: expect.any(String) }));
    expect(prompt).not.toHaveBeenCalled();

    const budgetModel = { id: "bounded", provider: "test-provider", api: "openai-completions", contextWindow: 1000, maxTokens: 100, cost: { input: 1, output: 2 } };
    // Live pricing validation only accepts models in the trusted current registry.
    const configuredModels = coordinator._d.getModels();
    coordinator._d.getModels = () => ({ ...configuredModels, availableModels: [...configuredModels.availableModels, budgetModel] });
    const limits = { maxTokens: 2000, maxUsd: 1, maxSteps: 2, maxDurationMs: 10000, maxOutputTokensPerCall: 20 };
    const budget = createRunBudget(limits, budgetModel);
    const boundedTools = vi.spyOn(coordinator._d, "buildTools");
    const noControl = await coordinator.executeIsolated("bounded", { model: budgetModel, runBudget: budget, subagentContext: true, toolFilter: [], builtinFilter: [] });
    expect(noControl.error).toMatch(/controllable SDK/);
    expect(prompt).not.toHaveBeenCalled();

    const originalStream = vi.fn(async (_model, _context, options) => {
      const payload = await options.onPayload({ max_tokens: 999 }, budgetModel);
      expect(payload.max_tokens).toBe(20);
      return (async function* () { yield { type: "done", reason: "stop", message: {
        role: "assistant", content: [{ type: "text", text: "ok" }], api: budgetModel.api, provider: budgetModel.provider, model: budgetModel.id,
        stopReason: "stop", timestamp: Date.now(), usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12 },
      } }; })();
    });
    const boundedSession = {
      model: budgetModel, agent: { state: { systemPrompt: "BOUNDED", tools: [] }, streamFn: originalStream },
      sessionManager: { getSessionFile: () => null }, subscribe: vi.fn(() => vi.fn()), dispose: vi.fn(),
      setAutoCompactionEnabled: vi.fn(), setAutoRetryEnabled: vi.fn(),
      prompt: async () => { const stream = await boundedSession.agent.streamFn(budgetModel, { messages: [] }, {}); await stream.result(); },
    };
    createAgentSessionMock.mockResolvedValue({ session: boundedSession });
    await coordinator.executeIsolated("bounded", { model: budgetModel, runBudget: budget, subagentContext: true, toolFilter: [], builtinFilter: [] });
    expect(boundedSession.setAutoCompactionEnabled).toHaveBeenCalledWith(false);
    expect(boundedSession.setAutoRetryEnabled).toHaveBeenCalledWith(false);
    expect(originalStream).toHaveBeenCalledTimes(1);
    expect(budget.snapshot()).toMatchObject({ calls: 1, committedTokens: 12, pendingCalls: 0 });
    expect(boundedTools.mock.calls.at(-1)[2].getPermissionMode()).toBe("ask");
    expect(boundedTools.mock.calls.at(-1)[2].permissionContext).toEqual({ isSubagent: true, requireInteractiveApproval: true });
    const ordinarySession = { ...boundedSession, agent: { ...boundedSession.agent, streamFn: originalStream },
      setAutoCompactionEnabled: vi.fn(), setAutoRetryEnabled: vi.fn(), prompt: vi.fn(async () => {}) };
    createAgentSessionMock.mockResolvedValue({ session: ordinarySession });
    await coordinator.executeIsolated("ordinary", { subagentContext: true });
    expect(ordinarySession.setAutoCompactionEnabled).not.toHaveBeenCalled();
    expect(ordinarySession.setAutoRetryEnabled).not.toHaveBeenCalled();
    expect(ordinarySession.agent.streamFn).toBe(originalStream);
    expect(boundedTools.mock.calls.at(-1)[2].getPermissionMode()).toBe("operate");
    expect(boundedTools.mock.calls.at(-1)[2].permissionContext).toEqual({ isSubagent: true });

  });

  it("does not inherit the focused session workspace unless parentSessionPath is explicit", async () => {
    createAgentSessionMock.mockResolvedValue({
      session: {
        sessionManager: { getSessionFile: () => null },
        subscribe: vi.fn(() => vi.fn()),
        prompt: vi.fn(async () => {}),
      },
    });

    const focusSessionPath = path.join(tempDir, "agents", "codia", "sessions", "focus.jsonl");
    const buildTools = vi.fn(() => ({ tools: [], customTools: [] }));
    const targetAgent = {
      id: "codia",
      agentDir: path.join(tempDir, "agents", "codia"),
      sessionDir: path.join(tempDir, "agents", "codia", "sessions"),
      agentName: "test-agent",
      config: { locale: "en", models: { chat: "default-model" } },
      tools: [],
      systemPrompt: "MASTER PROMPT",
    };
    const coordinator = new SessionCoordinator({
      agentsDir: path.join(tempDir, "agents"),
      getAgent: () => targetAgent,
      getActiveAgentId: () => "codia",
      getModels: () => ({
        authStorage: {},
        modelRegistry: {},
        defaultModel: { id: "default-model", provider: "test-provider" },
        availableModels: [{ id: "default-model", provider: "test-provider" }],
        resolveExecutionModel: (model) => model,
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({ getSystemPrompt: () => "BASE PROMPT", getAppendSystemPrompt: () => [] }),
      getSkills: () => ({ getSkillsForAgent: () => [] }),
      buildTools,
      emitEvent: () => {},
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => null,
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => targetAgent,
      listAgents: () => [],
    });

    coordinator._session = {
      sessionManager: { getSessionFile: () => focusSessionPath },
    };
    coordinator._sessions.set(focusSessionPath, {
      session: coordinator._session,
      workspaceFolders: [path.join(tempDir, "private-other-session")],
    });

    await coordinator.executeIsolated("background check");

    expect(buildTools.mock.calls[0][2].workspaceFolders).toEqual([]);

    buildTools.mockClear();
    await coordinator.executeIsolated("explicit parent check", {
      parentSessionPath: focusSessionPath,
    });

    expect(buildTools.mock.calls[0][2].workspaceFolders).toEqual([
      path.join(tempDir, "private-other-session"),
    ]);
  });

  it("resumes isolated sessions, injects extra tools, and returns produced files and tool errors", async () => {
    const resumeFile = path.join(tempDir, "agents", "codia", "sessions", "child.jsonl");
    fs.mkdirSync(path.dirname(resumeFile), { recursive: true });
    fs.writeFileSync(resumeFile, '{"type":"message"}\n', "utf-8");
    const producedFile = { filePath: path.join(tempDir, "report.md"), label: "report.md" };
    const injectedTool = { name: "channel_reply", execute: vi.fn() };
    const subscribers = [];
    const prompt = vi.fn(async () => {
      for (const subscriber of subscribers) {
        subscriber({
          type: "tool_execution_end",
          result: { details: { sessionFile: producedFile } },
        });
        subscriber({
          type: "tool_execution_end",
          isError: true,
          toolName: "browser",
          error: "boom",
        });
        subscriber({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "final answer" }],
            stopReason: "stop",
          },
        });
      }
    });

    sessionManagerOpenMock.mockReturnValue({
      getCwd: () => tempDir,
      getSessionFile: () => resumeFile,
    });
    createAgentSessionMock.mockResolvedValue({
      session: {
        sessionManager: { getSessionFile: () => resumeFile },
        subscribe: vi.fn((subscriber) => {
          subscribers.push(subscriber);
          return vi.fn();
        }),
        prompt,
        abort: vi.fn(),
      },
    });

    const targetAgent = {
      id: "codia",
      agentDir: path.join(tempDir, "agents", "codia"),
      sessionDir: path.join(tempDir, "agents", "codia", "sessions"),
      agentName: "test-agent",
      config: { locale: "en", models: { chat: "default-model" } },
      tools: [],
      systemPrompt: "MASTER PROMPT",
    };
    const coordinator = new SessionCoordinator({
      agentsDir: path.join(tempDir, "agents"),
      getAgent: () => targetAgent,
      getActiveAgentId: () => "codia",
      getModels: () => ({
        authStorage: {},
        modelRegistry: {},
        defaultModel: { id: "default-model", provider: "test-provider" },
        availableModels: [{ id: "default-model", provider: "test-provider" }],
        resolveExecutionModel: (model) => model,
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({ getSystemPrompt: () => "BASE PROMPT", getAppendSystemPrompt: () => [] }),
      getSkills: () => ({ getSkillsForAgent: () => [] }),
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: () => {},
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => null,
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => targetAgent,
      listAgents: () => [],
    });

    const result = await coordinator.executeIsolated("continue task", {
      resumeSessionPath: resumeFile,
      persist: path.dirname(resumeFile),
      extraCustomTools: [injectedTool],
    });

    expect(sessionManagerOpenMock).toHaveBeenCalledWith(resumeFile, path.dirname(resumeFile));
    expect(sessionManagerCreateMock).not.toHaveBeenCalled();
    expect(createAgentSessionMock.mock.calls[0][0].customTools).toContain(injectedTool);
    expect(prompt).toHaveBeenCalledWith("continue task");
    expect(result).toMatchObject({
      sessionPath: resumeFile,
      replyText: "final answer",
      error: null,
      sessionFiles: [producedFile],
      toolErrors: ["browser: boom"],
    });
  });

  it("cleans up the temporary session file when aborted after session creation", async () => {
    const sessionFile = path.join(tempDir, "isolated.jsonl");
    fs.writeFileSync(sessionFile, "temp");

    const controller = new AbortController();
    sessionManagerCreateMock.mockReturnValue({
      getCwd: () => tempDir,
      getSessionFile: () => sessionFile,
    });
    createAgentSessionMock.mockImplementation(async () => {
      controller.abort();
      return {
        session: {
          sessionManager: { getSessionFile: () => sessionFile },
          subscribe: vi.fn(() => vi.fn()),
          abort: vi.fn(),
        },
      };
    });

    const coordinator = new SessionCoordinator({
      agentsDir: "/tmp/agents",
      getAgent: () => ({
        agentDir: tempDir,
        sessionDir: tempDir,
        agentName: "test-agent",
        config: { models: { chat: "default-model" } },
        tools: [],
      }),
      getActiveAgentId: () => "codia",
      getModels: () => ({
        authStorage: {},
        modelRegistry: {},
        defaultModel: { id: "default-model" },
        availableModels: [{ id: "default-model" }],
        resolveExecutionModel: (model) => model,
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({ getSystemPrompt: () => "prompt" }),
      getSkills: () => ({ getSkillsForAgent: () => [] }),
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: () => {},
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => null,
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => null,
      listAgents: () => [],
    });

    const result = await coordinator.executeIsolated("subagent task", {
      signal: controller.signal,
    });

    expect(result).toEqual({
      sessionPath: null,
      replyText: "",
      error: "aborted",
      sessionFiles: [],
      toolErrors: [],
    });
    expect(fs.existsSync(sessionFile)).toBe(false);
  });

  it("resolves cached sessions even when callers send normalized or basename-only paths", () => {
    const coordinator = new SessionCoordinator({});
    const sessionFile = path.join(tempDir, "AgentA", "sessions", "session-123.jsonl");
    const session = { isStreaming: false };

    coordinator._sessions.set(sessionFile, {
      session,
      _switching: true,
    });

    const normalizedAlias = process.platform === "win32"
      ? sessionFile.toUpperCase()
      : `${path.dirname(sessionFile)}/./${path.basename(sessionFile)}`;
    expect(coordinator.getSessionByPath(normalizedAlias)).toBe(session);
    expect(coordinator.getSessionByPath("session-123.jsonl")).toBe(session);
    expect(coordinator.isSessionSwitching(normalizedAlias)).toBe(true);
  });

  it.skipIf(process.platform === "win32")("keeps case-distinct session filenames separate", () => {
    const coordinator = new SessionCoordinator({});
    const sessionFile = path.join(tempDir, "AgentA", "sessions", "session-123.jsonl");
    const upperSessionFile = path.join(path.dirname(sessionFile), "SESSION-123.JSONL");
    const lowerSession = { isStreaming: false };
    const upperSession = { isStreaming: false };
    coordinator._sessions.set(sessionFile, { session: lowerSession });

    expect(coordinator.getSessionByPath(upperSessionFile)).toBeNull();
    coordinator._sessions.set(upperSessionFile, { session: upperSession });
    expect(coordinator.getSessionByPath(sessionFile)).toBe(lowerSession);
    expect(coordinator.getSessionByPath(upperSessionFile)).toBe(upperSession);
  });

  it("uses normalized session lookup for prompt/steer/abort paths", async () => {
    const coordinator = new SessionCoordinator({
      getAgent: () => ({ _memoryTicker: { notifyTurn: vi.fn() } }),
      getAgentById: () => null,
    });
    const sessionFile = path.join(tempDir, "AgentA", "sessions", "session-456.jsonl");
    const session = {
      isStreaming: true,
      model: { vision: true },
      prompt: vi.fn(async () => {}),
      steer: vi.fn(),
      abort: vi.fn(async () => {}),
    };

    coordinator._sessions.set(sessionFile, {
      session,
      agentId: "agent-a",
      lastTouchedAt: 0,
    });

    const normalizedAlias = process.platform === "win32"
      ? sessionFile.toUpperCase()
      : `${path.dirname(sessionFile)}/./${path.basename(sessionFile)}`;
    await coordinator.promptSession(normalizedAlias, "hello");
    expect(session.prompt).toHaveBeenCalledWith("hello", undefined);

    expect(coordinator.steerSession("session-456.jsonl", "wait")).toBe(true);
    expect(session.steer).toHaveBeenCalled();

    await coordinator.abortSession(normalizedAlias);
    expect(session.abort).toHaveBeenCalled();
  });

  it("passes direct audio inputs through promptSession media options", async () => {
    const memoryTicker = { notifyTurn: vi.fn() };
    const coordinator = new SessionCoordinator({
      getAgent: () => ({ _memoryTicker: memoryTicker }),
      getAgentById: () => null,
      emitEvent: vi.fn(),
    });
    const sessionFile = path.join(tempDir, "AgentA", "sessions", "session-audio.jsonl");
    const audio = { type: "audio", data: "BASE64", mimeType: "audio/wav" };
    const session = {
      isStreaming: false,
      model: { id: "gpt-audio", provider: "openai", api: "openai-completions", audio: true },
      prompt: vi.fn(async () => {}),
    };

    coordinator._sessions.set(sessionFile, {
      session,
      agentId: "agent-a",
      lastTouchedAt: 0,
    });

    await coordinator.promptSession(sessionFile, "listen", {
      audios: [audio],
      audioAttachmentPaths: ["/tmp/voice.wav"],
    });

    expect(session.prompt).toHaveBeenCalledWith("listen", {
      images: [audio],
      audioAttachmentPaths: ["/tmp/voice.wav"],
    });
    expect(memoryTicker.notifyTurn).toHaveBeenCalledWith(sessionFile);
  });

  it("releases prompt busy state even if the SDK streaming flag stays true", async () => {
    let finishPrompt;
    const emitEvent = vi.fn();
    const memoryTicker = { notifyTurn: vi.fn() };
    const coordinator = new SessionCoordinator({
      getAgent: () => ({ _memoryTicker: memoryTicker }),
      getAgentById: () => null,
      emitEvent,
    });
    const sessionFile = path.join(tempDir, "AgentA", "sessions", "session-sticky.jsonl");
    const session = {
      isStreaming: true,
      model: { input: [] },
      prompt: vi.fn(() => new Promise((resolve) => { finishPrompt = resolve; })),
    };

    coordinator._sessions.set(sessionFile, {
      session,
      agentId: "agent-a",
      lastTouchedAt: 0,
      _promptInFlight: false,
    });

    expect(coordinator.isSessionStreaming(sessionFile)).toBe(false);
    const firstPrompt = coordinator.promptSession(sessionFile, "first");
    await Promise.resolve();

    expect(coordinator.isSessionStreaming(sessionFile)).toBe(true);
    await expect(coordinator.promptSession(sessionFile, "second")).rejects.toThrow("session_busy");

    finishPrompt();
    await firstPrompt;

    expect(session.isStreaming).toBe(true);
    expect(coordinator.isSessionStreaming(sessionFile)).toBe(false);
    expect(emitEvent).toHaveBeenCalledWith(
      { type: "session_status", isStreaming: false },
      sessionFile,
    );

    session.prompt.mockResolvedValueOnce();
    await coordinator.promptSession(sessionFile, "second");
    expect(session.prompt).toHaveBeenCalledTimes(2);
    expect(memoryTicker.notifyTurn).toHaveBeenCalledWith(sessionFile);
  });

  it("rejects SDK processing races instead of appending a normal chat as a follow-up", async () => {
    const emitEvent = vi.fn();
    const memoryTicker = { notifyTurn: vi.fn() };
    const coordinator = new SessionCoordinator({
      getAgent: () => ({ _memoryTicker: memoryTicker }),
      getAgentById: () => null,
      emitEvent,
    });
    const sessionFile = path.join(tempDir, "AgentA", "sessions", "session-sdk-race.jsonl");
    const sdkBusy = new Error("Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.");
    const session = {
      isStreaming: true,
      model: { input: [] },
      prompt: vi.fn(async (_text, opts) => {
        if (!opts?.streamingBehavior) throw sdkBusy;
      }),
    };

    coordinator._sessions.set(sessionFile, {
      session,
      agentId: "agent-a",
      lastTouchedAt: 0,
      _promptInFlight: false,
    });

    await expect(coordinator.promptSession(sessionFile, "new independent message", {}))
      .rejects.toThrow("session_busy");

    expect(session.prompt).toHaveBeenCalledTimes(1);
    expect(session.prompt).toHaveBeenNthCalledWith(1, "new independent message", undefined);
    expect(memoryTicker.notifyTurn).not.toHaveBeenCalled();
    expect(emitEvent).toHaveBeenCalledWith(
      { type: "session_status", isStreaming: false },
      sessionFile,
    );
  });

  it("switches an existing session model without referencing missing locals", async () => {
    const coordinator = new SessionCoordinator({});
    const sessionFile = path.join(tempDir, "AgentA", "sessions", "session-789.jsonl");
    const nextModel = { id: "vision-model", provider: "e2e", contextWindow: 128000 };
    const session = {
      isCompacting: false,
      model: { id: "text-model", provider: "e2e", contextWindow: 128000 },
      setModel: vi.fn(async () => {}),
      getContextUsage: vi.fn(() => ({ tokens: 12 })),
      agent: { state: { messages: [{ role: "user", content: "hello" }] } },
    };

    coordinator._sessions.set(sessionFile, {
      session,
      modelId: "text-model",
      modelProvider: "e2e",
      _switching: false,
    });

    const result = await coordinator.switchSessionModel(sessionFile, nextModel);

    expect(result).toEqual({ adaptations: [] });
    expect(session.setModel).toHaveBeenCalledWith(nextModel);
    expect(coordinator._sessions.get(sessionFile).modelId).toBe("vision-model");
    expect(coordinator._sessions.get(sessionFile).modelProvider).toBe("e2e");
  });

  it("uses model-aware compaction settings for SGLang sessions", () => {
    const coordinator = new SessionCoordinator({});

    coordinator._createSettings({
      id: "qwen3-32b",
      provider: "sglang",
      contextWindow: 8192,
      maxTokens: 16384,
    });

    expect(settingsInMemoryMock).toHaveBeenLastCalledWith(expect.objectContaining({
      compaction: {
        enabled: true,
        reserveTokens: 4096,
        keepRecentTokens: 3072,
      },
      defaultTools: ["+codemode", "+tool_search"],
    }));
  });

  it("adds visual context for tool result image blocks through the session resource loader", async () => {
    const sessionFile = path.join(tempDir, "agents", "codia", "sessions", "main.jsonl");
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    const sessionMgr = { getCwd: () => tempDir, getSessionFile: () => sessionFile };
    const chatModel = { id: "deepseek-chat", provider: "deepseek", input: ["text"] };
    const session = {
      model: chatModel,
      sessionManager: { getSessionFile: () => sessionFile },
      subscribe: vi.fn(() => vi.fn()),
      setActiveToolsByName: vi.fn(),
    };
    createAgentSessionMock.mockResolvedValue({ session });
    const agent = {
      id: "codia",
      agentDir: path.dirname(path.dirname(sessionFile)),
      sessionDir: path.dirname(sessionFile),
      config: { tools: { disabled: [] } },
      memoryMasterEnabled: true,
      sessionMemoryEnabled: true,
      setMemoryEnabled: vi.fn(),
      buildSystemPrompt: vi.fn(() => "prompt"),
      getToolsSnapshot: vi.fn(() => []),
    };
    const visionBridge = {
      prepareResources: vi.fn(async ({ resources }) => ({
        notes: resources.map((resource) => ({
          key: resource.key,
          label: resource.label,
          note: "image_overview: main session screenshot",
        })),
      })),
      injectNotes: vi.fn((messages) => ({ messages, injected: 0 })),
    };
    const engine = {
      isVisionAuxiliaryEnabled: () => true,
      getVisionBridge: () => visionBridge,
      getSessionFile: vi.fn(),
      getSessionFileByPath: vi.fn(),
    };
    const coordinator = new SessionCoordinator({
      agentsDir: path.join(tempDir, "agents"),
      getAgent: () => agent,
      getActiveAgentId: () => "codia",
      getModels: () => ({
        currentModel: chatModel,
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({ getAppendSystemPrompt: () => [] }),
      getSkills: () => ({ getSkillsForAgent: () => ({ skills: [], diagnostics: [] }) }),
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: () => {},
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => null,
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [],
      getEngine: () => engine,
    });

    await coordinator.createSession(sessionMgr, tempDir, true);
    const resourceLoader = createAgentSessionMock.mock.calls[0][0].resourceLoader;
    const { extensions } = resourceLoader.getExtensions();
    const visionExtension = extensions.find((extension) => extension.path === "codia-vision-context-injection");
    const contextHandler = visionExtension?.handlers.get("context")?.[0];
    expect(contextHandler).toBeTypeOf("function");
    const messages = [
      { role: "user", content: "review the screenshot" },
      {
        role: "toolResult",
        content: [
          { type: "text", text: "browser screenshot captured" },
          { type: "image", mimeType: "image/png", data: "SCREENSHOT_BASE64" },
        ],
      },
    ];

    const result = await contextHandler({ messages }, { model: chatModel, sessionManager: session.sessionManager });

    expect(visionBridge.prepareResources).toHaveBeenCalledOnce();
    expect(result.messages[1].content[0].text).toContain("<vision-context>");
    expect(result.messages[1].content[0].text).toContain("image_overview: main session screenshot");
  });

  it("blocks provider calls when an existing session cache prefix mutates without renew", async () => {
    const sessionFile = path.join(tempDir, "codia", "sessions", "cache-contract.jsonl");
    const model = {
      id: "deepseek-v4-pro",
      provider: "deepseek",
      api: "openai-completions",
      baseUrl: "https://api.deepseek.com",
      contextWindow: 1000000,
      maxTokens: 32000,
    };
    const readTool = { name: "read", description: "Read files", parameters: { type: "object" } };
    const bashTool = { name: "bash", description: "Run shell", parameters: { type: "object" } };
    const activeTools = new Map([["read", readTool], ["bash", bashTool]]);
    const originalStreamFn = vi.fn(async () => "ok");
    const session = {
      sessionManager: { getSessionFile: () => sessionFile },
      subscribe: vi.fn(() => vi.fn()),
      model,
      getContextUsage: () => ({ tokens: 0 }),
      setActiveToolsByName: vi.fn((names) => {
        session.agent.state.tools = names.map((name) => activeTools.get(name)).filter(Boolean);
      }),
      agent: {
        streamFn: originalStreamFn,
        state: {
          model,
          systemPrompt: "FINAL CACHE PREFIX",
          tools: [readTool, bashTool],
          messages: [],
        },
      },
    };
    createAgentSessionMock.mockResolvedValue({ session });

    const agent = {
      id: "codia",
      agentDir: path.dirname(path.dirname(sessionFile)),
      sessionDir: path.dirname(sessionFile),
      sessionMemoryEnabled: true,
      setMemoryEnabled: vi.fn(),
      buildSystemPrompt: () => "FROZEN BASE",
      getToolsSnapshot: () => [],
      config: { tools: {} },
      tools: [],
    };
    const coordinator = new SessionCoordinator({
      agentsDir: path.join(tempDir, "codia"),
      getAgent: () => agent,
      getActiveAgentId: () => "codia",
      getModels: () => ({
        currentModel: model,
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({
        getSystemPrompt: () => "BASE",
        getAppendSystemPrompt: () => [],
        getExtensions: () => ({ extensions: [], errors: [] }),
      }),
      getSkills: () => null,
      buildTools: () => ({ tools: [readTool, bashTool], customTools: [] }),
      emitEvent: () => {},
      getHomeCwd: () => "/tmp/home",
      agentIdFromSessionPath: () => "codia",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [],
    });

    await coordinator.createSession(null, "/tmp/workspace", true);

    await expect(session.agent.streamFn(model, {
      systemPrompt: "FINAL CACHE PREFIX",
      tools: [readTool, bashTool],
      messages: [{ role: "user", content: "hello" }],
    }, {})).resolves.toBe("ok");

    await expect(session.agent.streamFn(model, {
      systemPrompt: "MUTATED CACHE PREFIX",
      tools: [readTool, bashTool],
      messages: [
        { role: "user", content: "hello" },
        { role: "toolResult", content: [{ type: "text", text: "dynamic" }] },
      ],
    }, {})).rejects.toThrow(/Cache prefix contract violated/);
    expect(originalStreamFn).toHaveBeenCalledTimes(1);
  });

  it("renews the cache prefix contract for an explicit model switch", async () => {
    const sessionFile = path.join(tempDir, "codia", "sessions", "cache-contract-model-switch.jsonl");
    const initialModel = {
      id: "deepseek-v4-flash",
      provider: "deepseek",
      api: "openai-completions",
      baseUrl: "https://api.deepseek.com",
      contextWindow: 1000000,
      maxTokens: 32000,
    };
    const nextModel = { ...initialModel, id: "deepseek-v4-pro" };
    const readTool = { name: "read", description: "Read files", parameters: { type: "object" } };
    const originalStreamFn = vi.fn(async () => "ok");
    const session = {
      sessionManager: { getSessionFile: () => sessionFile },
      subscribe: vi.fn(() => vi.fn()),
      model: initialModel,
      getContextUsage: () => ({ tokens: 0 }),
      setActiveToolsByName: vi.fn((names) => {
        session.agent.state.tools = names.includes("read") ? [readTool] : [];
      }),
      setModel: vi.fn(async (model) => {
        session.model = model;
        session.agent.state.model = model;
      }),
      setThinkingLevel: vi.fn(),
      agent: {
        streamFn: originalStreamFn,
        state: {
          model: initialModel,
          systemPrompt: "FINAL CACHE PREFIX",
          tools: [readTool],
          messages: [],
        },
      },
    };
    createAgentSessionMock.mockResolvedValue({ session });

    const agent = {
      id: "codia",
      agentDir: path.dirname(path.dirname(sessionFile)),
      sessionDir: path.dirname(sessionFile),
      sessionMemoryEnabled: true,
      setMemoryEnabled: vi.fn(),
      buildSystemPrompt: () => "FROZEN BASE",
      getToolsSnapshot: () => [],
      config: { tools: {} },
      tools: [],
    };
    const coordinator = new SessionCoordinator({
      agentsDir: path.join(tempDir, "codia"),
      getAgent: () => agent,
      getActiveAgentId: () => "codia",
      getModels: () => ({
        currentModel: initialModel,
        availableModels: [initialModel, nextModel],
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: (level) => level,
      }),
      getResourceLoader: () => ({
        getSystemPrompt: () => "BASE",
        getAppendSystemPrompt: () => [],
        getExtensions: () => ({ extensions: [], errors: [] }),
      }),
      getSkills: () => null,
      buildTools: () => ({ tools: [readTool], customTools: [] }),
      emitEvent: () => {},
      getHomeCwd: () => "/tmp/home",
      agentIdFromSessionPath: () => "codia",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [],
    });

    await coordinator.createSession(null, "/tmp/workspace", true);
    await coordinator.switchSessionModel(sessionFile, nextModel);

    await expect(session.agent.streamFn(nextModel, {
      systemPrompt: "FINAL CACHE PREFIX",
      tools: [readTool],
      messages: [{ role: "user", content: "hello" }],
    }, {})).resolves.toBe("ok");
  });
});
