// @ts-nocheck
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";

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

describe("SessionCoordinator", () => {
  let tempDir;

  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codia-session-coordinator-"));
    fs.mkdirSync(path.join(tempDir,".git"));
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

  it.each(["same", "changed", "legacy"])("preserves manual project selection and historical snapshot on %s restore", async (mode) => {
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
      productDir: path.join(tempDir, "product"),
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

    fs.writeFileSync(path.join(tempDir,"package.json"),JSON.stringify({version:"1.0.0"}));
    await coordinator.createSession(sessionMgr, tempDir, true);
    const runtimeFile = `${sessionFile}.memory-runtime.json`;
    const initialRuntime = fs.existsSync(runtimeFile) ? JSON.parse(fs.readFileSync(runtimeFile,"utf8")) : null;
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

    await coordinator.writeSessionMeta(sessionFile, { projectId: "project-user-selected" });
    if(mode==="legacy") {
      if(fs.existsSync(runtimeFile))fs.unlinkSync(runtimeFile);
      const legacyMeta=JSON.parse(fs.readFileSync(metaPath,"utf8"));delete legacyMeta[path.basename(sessionFile)].memoryProjectId;fs.writeFileSync(metaPath,JSON.stringify(legacyMeta));
    }
    if(mode==="changed")fs.writeFileSync(path.join(tempDir,"package.json"),JSON.stringify({version:"2.0.0"}));
    await coordinator.createSession(sessionMgr, tempDir, true, null, { restore: true });
    expect(JSON.parse(fs.readFileSync(metaPath, "utf-8"))[path.basename(sessionFile)].projectId).toBe("project-user-selected");

    expect(initialRuntime).toMatchObject({environment:{projectId:`workspace:${tempDir}`,appVersion:"1.0.0"}});
    expect(JSON.parse(fs.readFileSync(metaPath,"utf8"))[path.basename(sessionFile)].memoryProjectId).toBe(mode==="legacy"?undefined:`workspace:${tempDir}`);
    if(mode==="legacy")expect(fs.existsSync(runtimeFile)).toBe(false);
    else expect(JSON.parse(fs.readFileSync(runtimeFile,"utf8"))).toMatchObject({environment:{appVersion:"1.0.0"},...(mode==="changed"?{ambiguous:true}:{})});

    const restoredLoader = createAgentSessionMock.mock.calls[0][0].resourceLoader;
    expect(agent.buildSystemPrompt).not.toHaveBeenCalled();
    expect(restoredLoader.getSystemPrompt()).toBe("PROMPT ONE");
    expect(restoredLoader.getAppendSystemPrompt()).toEqual(persisted.appendSystemPrompt);
    expect(restoredLoader.getSkills().skills.map((skill) => skill.name)).toEqual(["one"]);
    expect(restoredLoader.getAgentsFiles()).toEqual({ agentsFiles: [{ path: "AGENTS.md", content: "original" }] });
  });


});
