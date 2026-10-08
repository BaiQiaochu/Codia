// @ts-nocheck
// Upstream reference test migrated and debranded; skipped until the matching G-SAP source contract is migrated.
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createAgentSessionMock = vi.fn();
const sessionManagerCreateMock = vi.fn();
const sessionManagerOpenMock = vi.fn();
const emitSessionShutdownMock = vi.fn(async (session) => {
  const runner = session?.extensionRunner;
  if (runner?.hasHandlers?.("session_shutdown")) {
    await runner.emit({ type: "session_shutdown" });
    return true;
  }
  return false;
});
const PNG_BASE64 = "iVBORw0KGgo=";

vi.mock("../lib/pi-sdk/index.js", async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    createAgentSession: (...args: any[]) => createAgentSessionMock(...args),
    SessionManager: {
      ...actual.SessionManager,
      create: (...args: any[]) => sessionManagerCreateMock(...args),
      open: (...args: any[]) => sessionManagerOpenMock(...args),
    },
    emitSessionShutdown: (...args: any[]) => (emitSessionShutdownMock as any)(...args),
    resizeModelImageInput: async (image) => ({
      data: image.data,
      mimeType: image.mimeType,
      originalWidth: 1,
      originalHeight: 1,
      width: 1,
      height: 1,
      wasResized: false,
    }),
    formatModelImageDimensionNote: () => undefined,
  };
});

import { BridgeSessionManager } from "../core/bridge-session-manager.ts";
import { VisionBridge, VISION_CONTEXT_START } from "../core/vision-bridge.ts";
import { CORE_TOOL_NAMES } from "../shared/tool-categories.ts";

function makeAgent(rootDir, id = "agent-a") {
  const sessionDir = path.join(rootDir, "sessions");
  const agentDir = path.join(rootDir, "agent");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  return {
    id,
    agentName: "Agent A",
    sessionDir,
    agentDir,
    tools: [],
    yuanPrompt: "yuan",
    publicIshiki: "public-ishiki",
    config: {
      models: { chat: { id: "gpt-4o", provider: "openai" } },
      bridge: {},
    },
    buildSystemPrompt: () => "system prompt",
  };
}

function makeDeps(agent) {
  return {
    getHanakoHome: () => rootDir,
    getAgent: () => agent,
    getAgentById: (id) => (id === agent.id ? agent : null),
    getAgents: () => new Map([[agent.id, agent]]),
    getModelManager: () => ({
      availableModels: [{ id: "gpt-4o", provider: "openai", name: "GPT-4o" }],
      authStorage: {},
      modelRegistry: {},
      resolveThinkingLevel: () => "medium",
    }),
    getResourceLoader: () => ({ getSystemPrompt: () => "fallback prompt" }),
    getPreferences: () => ({ thinking_level: "medium" }),
    buildTools: () => ({ tools: [], customTools: [] }),
    getHomeCwd: () => rootCwd,
    registerSessionFile: vi.fn(({ sessionPath, filePath, label, origin, storageKind }) => ({
      id: "sf_bridge_inbound",
      fileId: "sf_bridge_inbound",
      sessionPath,
      filePath,
      realPath: filePath,
      displayName: label,
      filename: path.basename(filePath),
      label,
      ext: "png",
      mime: "image/png",
      size: 4,
      kind: "image",
      origin,
      storageKind,
      createdAt: 1,
    })),
  };
}

function makeTool(name) {
  return {
    name,
    description: `${name} tool`,
    parameters: { type: "object", properties: {} },
  };
}

function makeDepsWithTools(agent) {
  const coreTools = CORE_TOOL_NAMES.map(makeTool);
  const customTools = [makeTool("todo_write")];
  return {
    ...makeDeps(agent),
    buildTools: () => ({ tools: coreTools, customTools }),
  };
}

function repairedBridgeToolSnapshot(names) {
  return [
    ...names,
    ...CORE_TOOL_NAMES.filter((name) => !names.includes(name)),
  ];
}

let rootDir;
let rootCwd;

describe.skip("BridgeSessionManager teardown", () => {
  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-session-teardown-"));
    rootCwd = path.join(rootDir, "cwd");
    fs.mkdirSync(rootCwd, { recursive: true });
    createAgentSessionMock.mockReset();
    sessionManagerCreateMock.mockReset();
    sessionManagerOpenMock.mockReset();
    emitSessionShutdownMock.mockClear();
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it.skip("passes bridge steer text to the SDK without adding an internal prefix", () => {
    const agent = makeAgent(rootDir);
    const manager = new BridgeSessionManager(makeDeps(agent));
    const session = {
      isStreaming: true,
      steer: vi.fn(),
    };
    manager.activeSessions.set("telegram:dm:owner", session);

    expect(manager.steerSession("telegram:dm:owner", "先停一下，直接回答这个")).toBe(true);
    expect(session.steer).toHaveBeenCalledWith("先停一下，直接回答这个");
  });

  it.skip("does not steer an active bridge session across role boundaries", () => {
    const agent = makeAgent(rootDir);
    const manager = new BridgeSessionManager(makeDeps(agent));
    const sessionKey = "qq_dm_same-person@agent-a";
    const session = {
      isStreaming: true,
      steer: vi.fn(),
    };
    manager.activeSessions.set(sessionKey, session);
    manager._activeSessionRoles.set(sessionKey, "guest");

    expect(manager.isSessionStreaming(sessionKey, { role: "owner" })).toBe(false);
    expect(manager.steerSession(sessionKey, "owner message", { role: "owner" })).toBe(false);
    expect(session.steer).not.toHaveBeenCalled();
    expect(manager.steerSession(sessionKey, "guest message", { role: "guest" })).toBe(true);
    expect(session.steer).toHaveBeenCalledWith("guest message");
  });

  it.skip("executeExternalMessage 结束后走 emit -> unsub -> dispose", async () => {
    const agent = makeAgent(rootDir);
    const mgrPath = path.join(agent.sessionDir, "bridge", "owner", "s1.jsonl");
    const manager = new BridgeSessionManager(makeDeps(agent));
    sessionManagerCreateMock.mockReturnValue({ getSessionFile: () => mgrPath });

    const callOrder = [];
    const session = {
      model: { input: ["text"] },
      prompt: vi.fn(async () => {}),
      subscribe: vi.fn(() => () => { callOrder.push("unsub"); }),
      dispose: vi.fn(() => { callOrder.push("dispose"); }),
      sessionManager: { getSessionFile: () => mgrPath },
      extensionRunner: {
        hasHandlers: vi.fn(() => true),
        emit: vi.fn(async () => { callOrder.push("emit"); }),
      },
    };
    createAgentSessionMock.mockResolvedValue({ session });

    await manager.executeExternalMessage("hello", "bridge-k1", null, { agentId: "agent-a" });

    expect(callOrder).toEqual(["emit", "unsub", "dispose"]);
    expect(emitSessionShutdownMock).toHaveBeenCalledWith(session);
    expect(session.dispose).toHaveBeenCalledOnce();
    expect(manager.activeSessions.has("bridge-k1")).toBe(false);
  });

  it.skip("emits normal bridge turns through the desktop chat stream contract", async () => {
    const agent = makeAgent(rootDir);
    const mgrPath = path.join(agent.sessionDir, "bridge", "owner", "stream.jsonl");
    const deps = makeDeps(agent) as any;
    deps.emitEvent = vi.fn();
    const manager = new BridgeSessionManager(deps);
    sessionManagerCreateMock.mockReturnValue({ getSessionFile: () => mgrPath });

    const subscribers = [];
    const session = {
      model: { input: ["text"] },
      prompt: vi.fn(async () => {
        for (const fn of subscribers) {
          fn({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hello" } });
          fn({ type: "tool_execution_start", toolName: "read", args: { file_path: "/tmp/a.txt" } });
          fn({ type: "tool_execution_end", toolName: "read", isError: false, result: { details: {} } });
        }
      }),
      subscribe: vi.fn((fn) => {
        subscribers.push(fn);
        return vi.fn();
      }),
      dispose: vi.fn(),
      sessionManager: { getSessionFile: () => mgrPath },
    };
    createAgentSessionMock.mockResolvedValue({ session });

    const reply = await manager.executeExternalMessage("model prompt", "tg_dm_owner@agent-a", null, {
      agentId: "agent-a",
      displayMessage: { text: "visible bridge message", source: "bridge" },
    });

    expect(reply).toBe("Hello");
    expect(deps.emitEvent).toHaveBeenCalledWith(
      { type: "session_status", isStreaming: true },
      mgrPath,
    );
    expect(deps.emitEvent).toHaveBeenCalledWith(
      {
        type: "session_user_message",
        message: expect.objectContaining({
          text: "visible bridge message",
          source: "bridge",
          bridgeSessionKey: "tg_dm_owner@agent-a",
        }),
      },
      mgrPath,
    );
    expect(deps.emitEvent).toHaveBeenCalledWith(
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hello" } },
      mgrPath,
    );
    expect(deps.emitEvent).toHaveBeenCalledWith(
      { type: "tool_execution_start", toolName: "read", args: { file_path: "/tmp/a.txt" } },
      mgrPath,
    );
    expect(deps.emitEvent).toHaveBeenCalledWith(
      { type: "tool_execution_end", toolName: "read", isError: false, result: { details: {} } },
      mgrPath,
    );
    expect(deps.emitEvent).toHaveBeenLastCalledWith(
      { type: "session_status", isStreaming: false },
      mgrPath,
    );
  });

  it.skip("notifies the owner bridge memory ticker after a successful external turn", async () => {
    const agent = makeAgent(rootDir) as any;
    agent.memoryTicker = {
      notifyTurn: vi.fn(),
    };
    const mgrPath = path.join(agent.sessionDir, "bridge", "owner", "memory-turn.jsonl");
    const manager = new BridgeSessionManager(makeDeps(agent));
    sessionManagerCreateMock.mockReturnValue({ getSessionFile: () => mgrPath });

    const session = {
      model: { input: ["text"] },
      prompt: vi.fn(async () => {}),
      subscribe: vi.fn(() => vi.fn()),
      dispose: vi.fn(),
      sessionManager: { getSessionFile: () => mgrPath },
      extensionRunner: { hasHandlers: vi.fn(() => false) },
    };
    createAgentSessionMock.mockResolvedValue({ session });

    await manager.executeExternalMessage("hello", "tg_dm_owner@agent-a", null, { agentId: "agent-a" });

    expect(agent.memoryTicker.notifyTurn).toHaveBeenCalledOnce();
    expect(agent.memoryTicker.notifyTurn).toHaveBeenCalledWith(mgrPath);
  });

  it.skip("returns provider message_end errors to bridge adapters instead of swallowing them", async () => {
    const agent = makeAgent(rootDir);
    const mgrPath = path.join(agent.sessionDir, "bridge", "owner", "error.jsonl");
    const manager = new BridgeSessionManager(makeDeps(agent));
    sessionManagerCreateMock.mockReturnValue({ getSessionFile: () => mgrPath });

    const subscribers = [];
    const session = {
      model: { input: ["text"] },
      prompt: vi.fn(async () => {
        for (const fn of subscribers) {
          fn({
            type: "message_end",
            message: {
              stopReason: "error",
              errorMessage: "400 Param Incorrect",
            },
          });
        }
      }),
      subscribe: vi.fn((fn) => {
        subscribers.push(fn);
        return vi.fn();
      }),
      dispose: vi.fn(),
      sessionManager: { getSessionFile: () => mgrPath },
    };
    createAgentSessionMock.mockResolvedValue({ session });

    await expect(
      manager.executeExternalMessage("hello", "bridge-error", null, { agentId: "agent-a" }),
    ).resolves.toEqual({
      __bridgeError: true,
      message: "400 Param Incorrect",
    });
  });

  it.skip("freshCompactSession compacts with the current owner prompt and records freshness metadata", async () => {
    const agent = makeAgent(rootDir);
    agent.buildSystemPrompt = vi.fn(() => "system prompt v2");
    const sessionFile = path.join(agent.sessionDir, "bridge", "owner", "fresh.jsonl");
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, "{}\n", "utf-8");
    const manager = new BridgeSessionManager(makeDeps(agent));
    manager.writeIndex({
      "tg_dm_fresh@agent-a": { file: "owner/fresh.jsonl", name: "Owner" },
    }, agent);
    sessionManagerOpenMock.mockReturnValue({ getSessionFile: () => sessionFile });

    const usage = vi.fn()
      .mockReturnValueOnce({ tokens: 12000, contextWindow: 128000 })
      .mockReturnValueOnce({ tokens: 4200, contextWindow: 128000 });
    const session = {
      compact: vi.fn(async () => {}),
      dispose: vi.fn(),
      sessionManager: { getSessionFile: () => sessionFile },
      getContextUsage: usage,
      extensionRunner: { hasHandlers: vi.fn(() => true), emit: vi.fn(async () => {}) },
    };
    createAgentSessionMock.mockImplementation(async (options) => {
      expect(options.resourceLoader.getSystemPrompt()).toContain("system prompt v2");
      return { session };
    });

    const result = await manager.freshCompactSession("tg_dm_fresh@agent-a", {
      agentId: "agent-a",
      reason: "manual",
      now: new Date("2026-05-15T09:00:00.000Z"),
    });

    expect(session.compact).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      tokensBefore: 12000,
      tokensAfter: 4200,
      contextWindow: 128000,
      fresh: true,
      reason: "manual",
    });
    const index = manager.readIndex(agent);
    expect(index["tg_dm_fresh@agent-a"].freshCompact).toMatchObject({
      lastFreshCompactDate: "2026-05-15",
      freshCompactReason: "manual",
      freshCompactTokensBefore: 12000,
      freshCompactTokensAfter: 4200,
    });
    expect(index["tg_dm_fresh@agent-a"].name).toBe("Owner");
  });

  it.skip("repairs restored owner bridge tool snapshots before applying active tools", async () => {
    const agent = makeAgent(rootDir);
    const manager = new BridgeSessionManager(makeDepsWithTools(agent));
    const sessionFile = path.join(agent.sessionDir, "bridge", "owner", "restore-tools.jsonl");
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, "{}\n", "utf-8");
    manager.writeIndex({
      "tg_dm_restore_tools@agent-a": {
        file: "owner/restore-tools.jsonl",
        toolNames: ["todo_write", "retired_tool", "todo_write"],
      },
    }, agent);
    sessionManagerOpenMock.mockReturnValue({ getSessionFile: () => sessionFile });

    const setActiveToolsByName = vi.fn();
    const session = {
      model: { input: ["text"] },
      prompt: vi.fn(async () => {}),
      subscribe: vi.fn(() => () => {}),
      dispose: vi.fn(),
      sessionManager: { getSessionFile: () => sessionFile },
      extensionRunner: {
        assertActive: vi.fn(),
        hasHandlers: vi.fn((event) => event === "session_before_compact"),
        emit: vi.fn(async () => {}),
      },
      setActiveToolsByName,
    };
    createAgentSessionMock.mockResolvedValue({ session });

    await manager.executeExternalMessage("hello", "tg_dm_restore_tools@agent-a", null, { agentId: "agent-a" });

    expect(setActiveToolsByName).toHaveBeenCalledWith(repairedBridgeToolSnapshot(["todo_write"]));
    expect(setActiveToolsByName.mock.calls[0][0]).not.toContain("retired_tool");
    expect(manager.readIndex(agent)["tg_dm_restore_tools@agent-a"].toolNames)
      .toEqual(repairedBridgeToolSnapshot(["todo_write"]));
  });

  it.skip("repairs bridge compact tool snapshots before reopening temporary owner sessions", async () => {
    const agent = makeAgent(rootDir);
    const manager = new BridgeSessionManager(makeDepsWithTools(agent));
    const sessionFile = path.join(agent.sessionDir, "bridge", "owner", "compact-tools.jsonl");
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, "{}\n", "utf-8");
    manager.writeIndex({
      "tg_dm_compact_tools@agent-a": {
        file: "owner/compact-tools.jsonl",
        toolNames: ["todo_write", "retired_tool"],
      },
    }, agent);
    sessionManagerOpenMock.mockReturnValue({ getSessionFile: () => sessionFile });

    const setActiveToolsByName = vi.fn();
    const session = {
      isCompacting: false,
      compact: vi.fn(async () => {}),
      getContextUsage: vi.fn()
        .mockReturnValueOnce({ tokens: 900, contextWindow: 128000 })
        .mockReturnValueOnce({ tokens: 300, contextWindow: 128000 }),
      dispose: vi.fn(),
      sessionManager: { getSessionFile: () => sessionFile },
      extensionRunner: {
        assertActive: vi.fn(),
        hasHandlers: vi.fn((event) => event === "session_before_compact"),
        emit: vi.fn(async () => {}),
      },
      setActiveToolsByName,
    };
    createAgentSessionMock.mockResolvedValue({ session });

    await manager.compactSession("tg_dm_compact_tools@agent-a", { agentId: "agent-a" });

    expect(setActiveToolsByName).toHaveBeenCalledWith(repairedBridgeToolSnapshot(["todo_write"]));
    const indexEntry = manager.readIndex(agent)["tg_dm_compact_tools@agent-a"];
    expect(indexEntry.toolNames).toEqual(repairedBridgeToolSnapshot(["todo_write"]));
  });

  it.skip("freshCompactSession records daily freshness when the bridge session is already compacted", async () => {
    const agent = makeAgent(rootDir);
    agent.buildSystemPrompt = vi.fn(() => "system prompt v3");
    const sessionFile = path.join(agent.sessionDir, "bridge", "owner", "already.jsonl");
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, [
      JSON.stringify({ type: "message", role: "user", content: "hello" }),
      JSON.stringify({ type: "compaction", summary: "earlier bridge turns" }),
      "",
    ].join("\n"), "utf-8");
    const manager = new BridgeSessionManager(makeDeps(agent));
    manager.writeIndex({
      "tg_dm_already@agent-a": {
        file: "owner/already.jsonl",
        name: "Owner",
        freshCompact: { lastFreshCompactDate: "2026-05-14" },
      },
    }, agent);
    sessionManagerOpenMock.mockReturnValue({ getSessionFile: () => sessionFile });

    const usage = vi.fn(() => ({ tokens: 4200, contextWindow: 128000 }));
    const session = {
      compact: vi.fn(async () => { throw new Error("Already compacted"); }),
      dispose: vi.fn(),
      sessionManager: { getSessionFile: () => sessionFile },
      getContextUsage: usage,
      extensionRunner: { hasHandlers: vi.fn(() => true), emit: vi.fn(async () => {}) },
    };
    createAgentSessionMock.mockImplementation(async (options) => {
      expect(options.resourceLoader.getSystemPrompt()).toContain("system prompt v3");
      return { session };
    });

    const result = await manager.freshCompactSession("tg_dm_already@agent-a", {
      agentId: "agent-a",
      reason: "daily",
      now: new Date("2026-05-15T09:00:00.000Z"),
    });

    expect(session.compact).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      fresh: true,
      reason: "daily",
      noop: true,
      noopReason: "already_compacted",
      tokensBefore: 4200,
      tokensAfter: 4200,
      contextWindow: 128000,
    });
    const index = manager.readIndex(agent);
    expect(index["tg_dm_already@agent-a"].freshCompact).toMatchObject({
      lastFreshCompactDate: "2026-05-15",
      freshCompactReason: "daily",
      freshCompactTokensBefore: 4200,
      freshCompactTokensAfter: 4200,
    });
    expect(index["tg_dm_already@agent-a"].promptSnapshot.systemPrompt).toContain("system prompt v3");
  });

  it.skip("freshCompactSession records daily freshness when the bridge session is too small to compact", async () => {
    const agent = makeAgent(rootDir);
    agent.buildSystemPrompt = vi.fn(() => "system prompt small");
    const sessionFile = path.join(agent.sessionDir, "bridge", "owner", "small.jsonl");
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, JSON.stringify({ type: "message", role: "user", content: "hi" }) + "\n", "utf-8");
    const manager = new BridgeSessionManager(makeDeps(agent));
    manager.writeIndex({
      "tg_dm_small@agent-a": {
        file: "owner/small.jsonl",
        freshCompact: { lastFreshCompactDate: "2026-05-14" },
      },
    }, agent);
    sessionManagerOpenMock.mockReturnValue({ getSessionFile: () => sessionFile });

    const session = {
      compact: vi.fn(async () => { throw new Error("Nothing to compact (session too small)"); }),
      dispose: vi.fn(),
      sessionManager: { getSessionFile: () => sessionFile },
      getContextUsage: vi.fn(() => ({ tokens: 300, contextWindow: 128000 })),
      extensionRunner: { hasHandlers: vi.fn(() => true), emit: vi.fn(async () => {}) },
    };
    createAgentSessionMock.mockResolvedValue({ session });

    const result = await manager.freshCompactSession("tg_dm_small@agent-a", {
      agentId: "agent-a",
      reason: "daily",
      now: new Date("2026-05-15T09:00:00.000Z"),
    });

    expect(result).toMatchObject({
      fresh: true,
      noop: true,
      noopReason: "nothing_to_compact",
      tokensBefore: 300,
      tokensAfter: 300,
    });
    expect(manager.readIndex(agent)["tg_dm_small@agent-a"].freshCompact).toMatchObject({
      lastFreshCompactDate: "2026-05-15",
      freshCompactTokensBefore: 300,
      freshCompactTokensAfter: 300,
    });
  });

  it.skip("executeExternalMessage does not fresh-compact inline for an existing owner bridge session", async () => {
    const agent = makeAgent(rootDir);
    agent.buildSystemPrompt = vi.fn(() => "system prompt current");
    const sessionFile = path.join(agent.sessionDir, "bridge", "owner", "existing.jsonl");
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, "{}\n", "utf-8");
    const manager = new BridgeSessionManager(makeDeps(agent));
    manager.writeIndex({
      "tg_dm_existing@agent-a": {
        file: "owner/existing.jsonl",
        freshCompact: { lastFreshCompactDate: "2026-05-14" },
      },
    }, agent);
    sessionManagerOpenMock.mockReturnValue({ getSessionFile: () => sessionFile });

    const liveSession = {
      model: { input: ["text"] },
      prompt: vi.fn(async () => {}),
      subscribe: vi.fn(() => () => {}),
      dispose: vi.fn(),
      sessionManager: { getSessionFile: () => sessionFile },
      extensionRunner: { hasHandlers: vi.fn(() => false) },
    };
    const compactSession = {
      compact: vi.fn(async () => {}),
      dispose: vi.fn(),
      sessionManager: { getSessionFile: () => sessionFile },
      getContextUsage: vi.fn()
        .mockReturnValueOnce({ tokens: 9000, contextWindow: 128000 })
        .mockReturnValueOnce({ tokens: 3600, contextWindow: 128000 }),
      extensionRunner: { hasHandlers: vi.fn(() => true), emit: vi.fn(async () => {}) },
    };
    createAgentSessionMock
      .mockResolvedValueOnce({ session: liveSession })
      .mockResolvedValueOnce({ session: compactSession });

    await manager.executeExternalMessage("hello", "tg_dm_existing@agent-a", null, { agentId: "agent-a" });

    expect(compactSession.compact).not.toHaveBeenCalled();
    const index = manager.readIndex(agent);
    expect(index["tg_dm_existing@agent-a"].freshCompact).toEqual({ lastFreshCompactDate: "2026-05-14" });
    expect(manager.listDailyFreshCompactTargets(agent, {
      now: new Date("2026-05-15T09:00:00"),
    })).toEqual([{ sessionKey: "tg_dm_existing@agent-a", sessionPath: sessionFile, reason: "daily" }]);
  });

  it.skip("recordAssistantMessage records without fresh-compacting inline for an existing owner bridge session", async () => {
    const agent = makeAgent(rootDir);
    const sessionFile = path.join(agent.sessionDir, "bridge", "owner", "assistant.jsonl");
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, "{}\n", "utf-8");
    const manager = new BridgeSessionManager(makeDeps(agent));
    manager.writeIndex({
      "tg_dm_assistant@agent-a": {
        file: "owner/assistant.jsonl",
        freshCompact: { lastFreshCompactDate: "2026-05-14" },
      },
    }, agent);

    const appendMessage = vi.fn();
    sessionManagerOpenMock
      .mockReturnValueOnce({ getSessionFile: () => sessionFile, appendMessage })
      .mockReturnValue({ getSessionFile: () => sessionFile });
    const compactSession = {
      compact: vi.fn(async () => {}),
      dispose: vi.fn(),
      sessionManager: { getSessionFile: () => sessionFile },
      getContextUsage: vi.fn()
        .mockReturnValueOnce({ tokens: 7000, contextWindow: 128000 })
        .mockReturnValueOnce({ tokens: 3000, contextWindow: 128000 }),
      extensionRunner: { hasHandlers: vi.fn(() => true), emit: vi.fn(async () => {}) },
    };
    createAgentSessionMock.mockResolvedValue({ session: compactSession });

    expect(manager.recordAssistantMessage("tg_dm_assistant@agent-a", "hello", {
      agentId: "agent-a",
    })).toBe(true);

    expect(appendMessage).toHaveBeenCalledOnce();
    expect(compactSession.compact).not.toHaveBeenCalled();
    const index = manager.readIndex(agent);
    expect(index["tg_dm_assistant@agent-a"].freshCompact).toEqual({ lastFreshCompactDate: "2026-05-14" });
    expect(manager.listDailyFreshCompactTargets(agent, {
      now: new Date("2026-05-15T09:00:00"),
    })).toEqual([{ sessionKey: "tg_dm_assistant@agent-a", sessionPath: sessionFile, reason: "daily" }]);
  });

  it.skip("records non-context custom entries into an existing bridge session file", () => {
    const agent = makeAgent(rootDir);
    const sessionFile = path.join(agent.sessionDir, "bridge", "owner", "assistant.jsonl");
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, "{}\n", "utf-8");
    const manager = new BridgeSessionManager(makeDeps(agent));
    manager.writeIndex({
      "tg_dm_assistant@agent-a": { file: "owner/assistant.jsonl" },
    }, agent);

    const appendCustomEntry = vi.fn();
    sessionManagerOpenMock.mockReturnValueOnce({ appendCustomEntry });

    const result = manager.recordCustomEntryForSessionPath(
      sessionFile,
      "hana-deferred-result",
      { taskId: "task-img" },
      { agentId: "agent-a" },
    );

    expect(result).toMatchObject({ ok: true, mode: "bridge-file" });
    expect(sessionManagerOpenMock).toHaveBeenCalledWith(sessionFile, path.dirname(sessionFile));
    expect(appendCustomEntry).toHaveBeenCalledWith("hana-deferred-result", { taskId: "task-img" });
  });

  it.skip("records non-context custom entries through the live bridge session manager when loaded", () => {
    const agent = makeAgent(rootDir);
    const sessionFile = path.join(agent.sessionDir, "bridge", "owner", "assistant.jsonl");
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, "{}\n", "utf-8");
    const manager = new BridgeSessionManager(makeDeps(agent));
    manager.writeIndex({
      "tg_dm_assistant@agent-a": { file: "owner/assistant.jsonl" },
    }, agent);

    const appendCustomEntry = vi.fn();
    manager.activeSessions.set("tg_dm_assistant@agent-a", {
      sessionManager: {
        getSessionFile: () => sessionFile,
        appendCustomEntry,
      },
    });

    const result = manager.recordCustomEntryForSessionPath(
      sessionFile,
      "hana-deferred-result",
      { taskId: "task-img" },
      { agentId: "agent-a" },
    );

    expect(result).toMatchObject({ ok: true, mode: "bridge-live" });
    expect(sessionManagerOpenMock).not.toHaveBeenCalled();
    expect(appendCustomEntry).toHaveBeenCalledWith("hana-deferred-result", { taskId: "task-img" });
  });

  it.skip("registers bridge inbound image files after the bridge session path exists", async () => {
    const agent = makeAgent(rootDir);
    const mgrPath = path.join(agent.sessionDir, "bridge", "owner", "s-inbound.jsonl");
    const deps = makeDeps(agent);
    const manager = new BridgeSessionManager(deps);
    sessionManagerCreateMock.mockReturnValue({ getSessionFile: () => mgrPath });

    const session = {
      model: { input: ["text", "image"] },
      prompt: vi.fn(async () => {}),
      subscribe: vi.fn(() => () => {}),
      dispose: vi.fn(),
      sessionManager: { getSessionFile: () => mgrPath },
    };
    createAgentSessionMock.mockResolvedValue({ session });

    await manager.executeExternalMessage("hello", "bridge-inbound", null, {
      agentId: "agent-a",
      images: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }],
      inboundFiles: [{
        type: "image",
        filename: "photo.png",
        mimeType: "image/png",
        buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      }],
    });

    expect(deps.registerSessionFile).toHaveBeenCalledWith({
      sessionPath: mgrPath,
      filePath: expect.stringContaining(path.join(rootDir, "session-files")),
      label: "photo.png",
      origin: "bridge_inbound",
      storageKind: "managed_cache",
    });
    expect(session.prompt).toHaveBeenCalledWith(
      `[attached_image: ${deps.registerSessionFile.mock.calls[0][0].filePath}]\nhello`,
      expect.objectContaining({
        images: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }],
        imageAttachmentPaths: [deps.registerSessionFile.mock.calls[0][0].filePath],
      }),
    );
  });

  it.skip("abortSession releases a bridge session immediately when provider abort never settles", async () => {
    const agent = makeAgent(rootDir);
    const manager = new BridgeSessionManager(makeDeps(agent));
    const abort = vi.fn(() => new Promise(() => {}));
    const dispose = vi.fn();

    manager.activeSessions.set("bridge-k1", {
      isStreaming: true,
      abort,
      dispose,
    });

    const result = await Promise.race([
      manager.abortSession("bridge-k1"),
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 25)),
    ]);

    expect(result).toBe(true);
    expect(abort).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalled();
    expect(manager.activeSessions.has("bridge-k1")).toBe(false);
  });

  it.skip("abortSession cancels pre-prompt vision prepare before bridge streaming starts", async () => {
    const agent = makeAgent(rootDir);
    const mgrPath = path.join(agent.sessionDir, "bridge", "owner", "pre-vision.jsonl");
    let resolvePrepareStarted;
    const prepareStarted = new Promise((resolve) => { resolvePrepareStarted = resolve; });
    let prepareSignal;
    const deps = {
      ...makeDeps(agent),
      isVisionAuxiliaryEnabled: () => true,
      getVisionBridge: () => ({
        prepare: vi.fn(({ signal }) => {
          prepareSignal = signal;
          resolvePrepareStarted();
          return new Promise((_, reject) => {
            signal.addEventListener("abort", () => {
              const err = new Error("This operation was aborted");
              err.name = "AbortError";
              (err as any).type = "aborted";
              reject(err);
            }, { once: true });
          });
        }),
      }),
    };
    const manager = new BridgeSessionManager(deps);
    sessionManagerCreateMock.mockReturnValue({ getSessionFile: () => mgrPath });
    const session = {
      model: { input: ["text"] },
      isStreaming: false,
      prompt: vi.fn(async () => {}),
      subscribe: vi.fn(() => () => {}),
      dispose: vi.fn(),
      sessionManager: { getSessionFile: () => mgrPath },
      extensionRunner: {
        hasHandlers: vi.fn(() => false),
      },
    };
    createAgentSessionMock.mockResolvedValue({ session });

    const task = manager.executeExternalMessage("hello", "bridge-pre", null, {
      agentId: "agent-a",
      images: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }],
    });
    await prepareStarted;

    expect(manager.isSessionStreaming("bridge-pre")).toBe(true);
    await expect(manager.abortSession("bridge-pre")).resolves.toBe(true);
    await expect(task).resolves.toBeNull();
    expect(prepareSignal.aborted).toBe(true);
    expect(session.prompt).not.toHaveBeenCalled();
    expect(session.dispose).toHaveBeenCalled();
    expect(manager.activeSessions.has("bridge-pre")).toBe(false);
  });

  it.skip("owner bridge session prompt snapshot uses the same home cwd as execution", async () => {
    const agent = makeAgent(rootDir);
    agent.buildSystemPrompt = vi.fn(({ cwdOverride }: any = {}) => `system prompt @ ${cwdOverride ?? "missing"}`);
    const mgrPath = path.join(agent.sessionDir, "bridge", "owner", "s-home.jsonl");
    const manager = new BridgeSessionManager(makeDeps(agent));
    sessionManagerCreateMock.mockReturnValue({ getSessionFile: () => mgrPath });

    const session = {
      model: { input: ["text"] },
      prompt: vi.fn(async () => {}),
      subscribe: vi.fn(() => () => {}),
      dispose: vi.fn(),
      sessionManager: { getSessionFile: () => mgrPath },
      extensionRunner: {
        hasHandlers: vi.fn(() => false),
      },
    };
    createAgentSessionMock.mockResolvedValue({ session });

    await manager.executeExternalMessage("hello", "bridge-k-home", null, { agentId: "agent-a" });

    expect(agent.buildSystemPrompt).toHaveBeenCalledWith(expect.objectContaining({ cwdOverride: rootCwd }));
    const createArgs = createAgentSessionMock.mock.calls.at(-1)[0];
    expect(createArgs.cwd).toBe(rootCwd);
    expect(createArgs.resourceLoader.getSystemPrompt()).toBe(`system prompt @ ${rootCwd}`);
  });

  it.skip("owner bridge sessions persist and reuse their prompt snapshot", async () => {
    const agent = makeAgent(rootDir);
    agent.buildSystemPrompt = vi.fn()
      .mockReturnValueOnce("owner prompt v1")
      .mockReturnValueOnce("owner prompt v2");
    const mgrPath = path.join(agent.sessionDir, "bridge", "owner", "snapshot.jsonl");
    fs.mkdirSync(path.dirname(mgrPath), { recursive: true });
    fs.writeFileSync(mgrPath, "", "utf-8");
    const manager = new BridgeSessionManager(makeDeps(agent));
    sessionManagerCreateMock.mockReturnValue({ getSessionFile: () => mgrPath });
    sessionManagerOpenMock.mockReturnValue({ getSessionFile: () => mgrPath });

    const makeSession = () => ({
      model: { input: ["text"] },
      prompt: vi.fn(async () => {}),
      subscribe: vi.fn(() => () => {}),
      dispose: vi.fn(),
      sessionManager: { getSessionFile: () => mgrPath },
      extensionRunner: { hasHandlers: vi.fn(() => false) },
    });
    createAgentSessionMock
      .mockResolvedValueOnce({ session: makeSession() })
      .mockResolvedValueOnce({ session: makeSession() });

    await manager.executeExternalMessage("hello", "tg_dm_snapshot@agent-a", null, { agentId: "agent-a" });
    const snapshot = manager.readIndex(agent)["tg_dm_snapshot@agent-a"].promptSnapshot;
    expect(snapshot?.systemPrompt).toContain("owner prompt v1");
    expect(snapshot?.systemPrompt).not.toContain("owner prompt v2");

    await manager.executeExternalMessage("hello again", "tg_dm_snapshot@agent-a", null, { agentId: "agent-a" });
    const secondCreateArgs = createAgentSessionMock.mock.calls.at(-1)[0];
    expect(secondCreateArgs.resourceLoader.getSystemPrompt()).toBe(snapshot.systemPrompt);
    expect(agent.buildSystemPrompt).toHaveBeenCalledTimes(1);
  });

  it.skip("guest bridge sessions persist and reuse their prompt snapshot", async () => {
    const agent = makeAgent(rootDir);
    const mgrPath = path.join(agent.sessionDir, "bridge", "guests", "guest-snapshot.jsonl");
    fs.mkdirSync(path.dirname(mgrPath), { recursive: true });
    fs.writeFileSync(mgrPath, "", "utf-8");
    const manager = new BridgeSessionManager(makeDeps(agent));
    sessionManagerCreateMock.mockReturnValue({ getSessionFile: () => mgrPath });
    sessionManagerOpenMock.mockReturnValue({ getSessionFile: () => mgrPath });

    const makeSession = () => ({
      model: { input: ["text"] },
      prompt: vi.fn(async () => {}),
      subscribe: vi.fn(() => () => {}),
      dispose: vi.fn(),
      sessionManager: { getSessionFile: () => mgrPath },
      extensionRunner: { hasHandlers: vi.fn(() => false) },
    });
    createAgentSessionMock
      .mockResolvedValueOnce({ session: makeSession() })
      .mockResolvedValueOnce({ session: makeSession() });

    await manager.executeExternalMessage("hello", "fs_group_guest-snapshot@agent-a", {
      userId: "guest-user",
      chatId: "guest-chat",
    }, { agentId: "agent-a", guest: true, contextTag: "group v1" });
    const snapshot = manager.readIndex(agent)["fs_group_guest-snapshot@agent-a"].promptSnapshot;
    expect(snapshot?.systemPrompt).toContain("public-ishiki");
    expect(snapshot?.systemPrompt).toContain("group v1");

    agent.publicIshiki = "public-ishiki v2";
    await manager.executeExternalMessage("hello again", "fs_group_guest-snapshot@agent-a", {
      userId: "guest-user",
      chatId: "guest-chat",
    }, { agentId: "agent-a", guest: true, contextTag: "group v2" });
    const secondCreateArgs = createAgentSessionMock.mock.calls.at(-1)[0];
    expect(secondCreateArgs.resourceLoader.getSystemPrompt()).toBe(snapshot.systemPrompt);
    expect(secondCreateArgs.resourceLoader.getSystemPrompt()).not.toContain("group v2");
  });

  it.skip("creates a new owner bridge session when an existing guest session becomes owner", async () => {
    const agent = makeAgent(rootDir);
    agent.buildSystemPrompt = vi.fn(() => "owner prompt");
    const sessionKey = "qq_dm_c2c-openid@agent-a";
    const guestPath = path.join(agent.sessionDir, "bridge", "guests", "guest-first.jsonl");
    const ownerPath = path.join(agent.sessionDir, "bridge", "owner", "owner-after.jsonl");
    fs.mkdirSync(path.dirname(guestPath), { recursive: true });
    fs.mkdirSync(path.dirname(ownerPath), { recursive: true });
    fs.writeFileSync(guestPath, "", "utf-8");
    fs.writeFileSync(ownerPath, "", "utf-8");
    const manager = new BridgeSessionManager(makeDeps(agent));
    sessionManagerCreateMock
      .mockReturnValueOnce({ getSessionFile: () => guestPath })
      .mockReturnValueOnce({ getSessionFile: () => ownerPath });
    sessionManagerOpenMock.mockReturnValue({ getSessionFile: () => guestPath });
    createAgentSessionMock.mockImplementation(async ({ sessionManager }) => ({
      session: {
        model: { input: ["text"] },
        prompt: vi.fn(async () => {}),
        subscribe: vi.fn(() => () => {}),
        dispose: vi.fn(),
        sessionManager,
        extensionRunner: { hasHandlers: vi.fn(() => false) },
      },
    }));

    await manager.executeExternalMessage("guest hello", sessionKey, {
      userId: "qq-user",
      chatId: "c2c-openid",
    }, { agentId: "agent-a", guest: true, contextTag: "guest context" });
    expect(manager.readIndex(agent)[sessionKey]).toMatchObject({
      file: "guests/guest-first.jsonl",
      role: "guest",
    });

    sessionManagerCreateMock.mockClear();
    sessionManagerOpenMock.mockClear();
    createAgentSessionMock.mockClear();

    await manager.executeExternalMessage("owner hello", sessionKey, {
      userId: "qq-user",
      chatId: "c2c-openid",
    }, { agentId: "agent-a" });

    expect(sessionManagerOpenMock).not.toHaveBeenCalled();
    expect(sessionManagerCreateMock).toHaveBeenCalledOnce();
    const ownerCreateArgs = createAgentSessionMock.mock.calls.at(-1)[0];
    expect(ownerCreateArgs.resourceLoader.getSystemPrompt()).toContain("owner prompt");
    expect(ownerCreateArgs.resourceLoader.getSystemPrompt()).not.toContain("public-ishiki");
    const entry = manager.readIndex(agent)[sessionKey];
    expect(entry).toMatchObject({
      file: "owner/owner-after.jsonl",
      role: "owner",
    });
    expect(entry.promptSnapshot.systemPrompt).toContain("owner prompt");
    expect(entry.promptSnapshot.systemPrompt).not.toContain("public-ishiki");
  });

  it.skip("adds a low-salience platform line and records bridge context metadata for owner sessions", async () => {
    const agent = makeAgent(rootDir);
    const mgrPath = path.join(agent.sessionDir, "bridge", "owner", "s-wechat.jsonl");
    const manager = new BridgeSessionManager(makeDeps(agent));
    sessionManagerCreateMock.mockReturnValue({ getSessionFile: () => mgrPath });

    const session = {
      model: { input: ["text"] },
      prompt: vi.fn(async () => {}),
      subscribe: vi.fn(() => () => {}),
      dispose: vi.fn(),
      sessionManager: { getSessionFile: () => mgrPath },
      extensionRunner: {
        hasHandlers: vi.fn(() => false),
      },
    };
    createAgentSessionMock.mockResolvedValue({ session });

    await manager.executeExternalMessage(
      "hello",
      "wx_dm_wx-user@agent-a",
      { userId: "wx-user", chatId: "wx-user", name: "微信用户" },
      { agentId: "agent-a" },
    );

    const createArgs = createAgentSessionMock.mock.calls.at(-1)[0];
    expect(createArgs.resourceLoader.getSystemPrompt()).toContain(
      "当前用户正通过微信与你对话，仅在需要理解当前平台或“这里”等指代时参考。",
    );
    expect(manager.readIndex(agent)["wx_dm_wx-user@agent-a"]).toMatchObject({
      file: "owner/s-wechat.jsonl",
      platform: "wechat",
      chatType: "dm",
      role: "owner",
      userId: "wx-user",
      chatId: "wx-user",
    });
    expect(manager.getBridgeContextForSessionPath(mgrPath, { agentId: "agent-a" })).toMatchObject({
      isBridgeSession: true,
      platform: "wechat",
      platformLabel: "微信",
      chatType: "dm",
      role: "owner",
      notificationHint: {
        channels: ["bridge_owner"],
        bridgePlatforms: ["wechat"],
        contextPolicy: "record_when_delivered",
      },
    });
  });

  it.skip("infers guest bridge context from legacy guest session file location", () => {
    const agent = makeAgent(rootDir);
    const sessionFile = path.join(agent.sessionDir, "bridge", "guests", "legacy-group.jsonl");
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, "{}\n", "utf-8");
    const manager = new BridgeSessionManager(makeDeps(agent));
    manager.writeIndex({
      "tg_group_g1@agent-a": {
        file: "guests/legacy-group.jsonl",
        userId: "guest-user",
        chatId: "g1",
      },
    }, agent);

    expect(manager.getBridgeContextForSessionPath(sessionFile, { agentId: "agent-a" })).toMatchObject({
      isBridgeSession: true,
      platform: "telegram",
      chatType: "group",
      role: "guest",
      notificationHint: null,
    });
  });

  it.skip("owner bridge tools follow the master memory switch instead of session memory state", async () => {
    const agent = makeAgent(rootDir) as any;
    agent.memoryMasterEnabled = true;
    const plainTool = { name: "plain_custom" };
    const memoryTool = { name: "search_memory" };
    agent.tools = [plainTool];
    agent.getToolsSnapshot = vi.fn(({ forceMemoryEnabled }: any = {}) => (
      forceMemoryEnabled ? [plainTool, memoryTool] : [plainTool]
    ));
    const buildTools = vi.fn((_cwd, customTools) => ({
      tools: [],
      customTools,
    }));
    const deps = {
      ...makeDeps(agent),
      buildTools,
    };
    const mgrPath = path.join(agent.sessionDir, "bridge", "owner", "s-master-tools.jsonl");
    const manager = new BridgeSessionManager(deps);
    sessionManagerCreateMock.mockReturnValue({ getSessionFile: () => mgrPath });

    createAgentSessionMock.mockResolvedValue({
      session: {
        model: { input: ["text"] },
        prompt: vi.fn(async () => {}),
        subscribe: vi.fn(() => () => {}),
        dispose: vi.fn(),
        sessionManager: { getSessionFile: () => mgrPath },
        extensionRunner: { hasHandlers: vi.fn(() => false) },
      },
    });

    await manager.executeExternalMessage("hello", "bridge-k-master-tools", null, { agentId: "agent-a" });

    expect(agent.getToolsSnapshot).toHaveBeenCalledWith({ forceMemoryEnabled: true });
    expect(buildTools.mock.calls[0][1].map((tool) => tool.name)).toEqual([
      "plain_custom",
      "search_memory",
    ]);
    expect(createAgentSessionMock.mock.calls[0][0].customTools.map((tool) => tool.name)).toContain("search_memory");
  });

  it.skip("owner bridge sessions default to auto permission mode when bridge read-only is off", async () => {
    const agent = makeAgent(rootDir);
    const buildTools = vi.fn(() => ({
      tools: [],
      customTools: [],
    }));
    const deps = {
      ...makeDeps(agent),
      getPreferences: () => ({ thinking_level: "medium", bridge: { readOnly: false } }),
      buildTools,
    };
    const mgrPath = path.join(agent.sessionDir, "bridge", "owner", "s-permission.jsonl");
    const manager = new BridgeSessionManager(deps);
    sessionManagerCreateMock.mockReturnValue({ getSessionFile: () => mgrPath });

    createAgentSessionMock.mockResolvedValue({
      session: {
        model: { input: ["text"] },
        prompt: vi.fn(async () => {}),
        subscribe: vi.fn(() => () => {}),
        dispose: vi.fn(),
        sessionManager: { getSessionFile: () => mgrPath },
        extensionRunner: { hasHandlers: vi.fn(() => false) },
      },
    });

    await manager.executeExternalMessage("hello", "bridge-k-permission", null, { agentId: "agent-a" });

    expect(buildTools).toHaveBeenCalledOnce();
    const buildOpts = (buildTools.mock.calls[0] as any)[2];
    expect(buildOpts!.getPermissionMode()).toBe("auto");
  });

  it.skip("owner bridge sessions honor explicit bridge auto permission mode", async () => {
    const agent = makeAgent(rootDir);
    const buildTools = vi.fn(() => ({
      tools: [],
      customTools: [],
    }));
    const deps = {
      ...makeDeps(agent),
      getPreferences: () => ({ thinking_level: "medium", bridge: { permissionMode: "auto", readOnly: true } }),
      buildTools,
    };
    const mgrPath = path.join(agent.sessionDir, "bridge", "owner", "s-permission-auto.jsonl");
    const manager = new BridgeSessionManager(deps);
    sessionManagerCreateMock.mockReturnValue({ getSessionFile: () => mgrPath });

    createAgentSessionMock.mockResolvedValue({
      session: {
        model: { input: ["text"] },
        prompt: vi.fn(async () => {}),
        subscribe: vi.fn(() => () => {}),
        dispose: vi.fn(),
        sessionManager: { getSessionFile: () => mgrPath },
        extensionRunner: { hasHandlers: vi.fn(() => false) },
      },
    });

    await manager.executeExternalMessage("hello", "bridge-k-permission-auto", null, { agentId: "agent-a" });

    expect(buildTools).toHaveBeenCalledOnce();
    const buildOpts = (buildTools.mock.calls[0] as any)[2];
    expect(buildOpts!.getPermissionMode()).toBe("auto");
  });

  it.skip("owner bridge tools expose the bridge session path instead of relying on desktop focus", async () => {
    const agent = makeAgent(rootDir);
    const buildTools = vi.fn(() => ({
      tools: [],
      customTools: [],
    }));
    const deps = {
      ...makeDeps(agent),
      buildTools,
    };
    const mgrPath = path.join(agent.sessionDir, "bridge", "owner", "s-owner-tools.jsonl");
    const manager = new BridgeSessionManager(deps);
    sessionManagerCreateMock.mockReturnValue({ getSessionFile: () => mgrPath });

    createAgentSessionMock.mockResolvedValue({
      session: {
        model: { input: ["text"] },
        prompt: vi.fn(async () => {}),
        subscribe: vi.fn(() => () => {}),
        dispose: vi.fn(),
        sessionManager: { getSessionFile: () => mgrPath },
        extensionRunner: { hasHandlers: vi.fn(() => false) },
      },
    });

    await manager.executeExternalMessage("hello", "bridge-k-owner-tools", null, { agentId: "agent-a" });

    expect(buildTools).toHaveBeenCalledOnce();
    const buildOpts = (buildTools.mock.calls[0] as any)[2];
    expect(buildOpts!.getSessionPath()).toBe(mgrPath);
  });

  it.skip("guest bridge sessions pass canonical off thinking level to the SDK", async () => {
    const agent = makeAgent(rootDir);
    agent.config.models.chat = { id: "minimax-m2.5", provider: "scnet" };
    const deps = {
      ...makeDeps(agent),
      getModelManager: () => ({
        availableModels: [{
          id: "minimax-m2.5",
          provider: "scnet",
          name: "MiniMax M2.5",
          api: "openai-completions",
          baseUrl: "https://example.test/v1",
          reasoning: true,
        }],
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "medium",
      }),
    };
    const mgrPath = path.join(agent.sessionDir, "bridge", "guests", "guest-thinking.jsonl");
    const manager = new BridgeSessionManager(deps);
    sessionManagerCreateMock.mockReturnValue({ getSessionFile: () => mgrPath });

    createAgentSessionMock.mockResolvedValue({
      session: {
        model: { input: ["text"] },
        prompt: vi.fn(async () => {}),
        subscribe: vi.fn(() => () => {}),
        dispose: vi.fn(),
        sessionManager: { getSessionFile: () => mgrPath },
        extensionRunner: { hasHandlers: vi.fn(() => false) },
      },
    });

    await manager.executeExternalMessage("hello", "fs_group_guest@agent-a", {
      userId: "guest-user",
      chatId: "guest-chat",
    }, { agentId: "agent-a", guest: true });

    const createArgs = createAgentSessionMock.mock.calls.at(-1)[0];
    expect(createArgs.thinkingLevel).toBe("off");
    expect(createArgs.tools).toEqual([]);
    expect(createArgs.customTools).toEqual([]);
  });

  it.skip("owner bridge read-only sessions pass read-only permission mode to tool wrappers", async () => {
    const agent = makeAgent(rootDir);
    const buildTools = vi.fn(() => ({
      tools: [],
      customTools: [],
    }));
    const deps = {
      ...makeDeps(agent),
      getPreferences: () => ({ thinking_level: "medium", bridge: { readOnly: true } }),
      buildTools,
    };
    const mgrPath = path.join(agent.sessionDir, "bridge", "owner", "s-read-only.jsonl");
    const manager = new BridgeSessionManager(deps);
    sessionManagerCreateMock.mockReturnValue({ getSessionFile: () => mgrPath });

    createAgentSessionMock.mockResolvedValue({
      session: {
        model: { input: ["text"] },
        prompt: vi.fn(async () => {}),
        subscribe: vi.fn(() => () => {}),
        dispose: vi.fn(),
        sessionManager: { getSessionFile: () => mgrPath },
        extensionRunner: { hasHandlers: vi.fn(() => false) },
      },
    });

    await manager.executeExternalMessage("hello", "bridge-k-read-only", null, { agentId: "agent-a" });

    expect(buildTools).toHaveBeenCalledOnce();
    const buildOpts = (buildTools.mock.calls[0] as any)[2];
    expect(buildOpts!.getPermissionMode()).toBe("read_only");
  });

  it.skip("owner bridge read-only sessions keep full schema and rely on permission wrappers", async () => {
    const agent = makeAgent(rootDir);
    agent.tools = [{ name: "search_memory" }, { name: "record_experience" }];
    const buildTools = vi.fn((_cwd, customTools) => ({
      tools: [{ name: "read" }, { name: "write" }],
      customTools,
    }));
    const deps = {
      ...makeDeps(agent),
      getPreferences: () => ({ thinking_level: "medium", bridge: { readOnly: true } }),
      buildTools,
    };
    const mgrPath = path.join(agent.sessionDir, "bridge", "owner", "s-read-only-full-tools.jsonl");
    const manager = new BridgeSessionManager(deps);
    sessionManagerCreateMock.mockReturnValue({ getSessionFile: () => mgrPath });

    createAgentSessionMock.mockResolvedValue({
      session: {
        model: { input: ["text"] },
        prompt: vi.fn(async () => {}),
        subscribe: vi.fn(() => () => {}),
        dispose: vi.fn(),
        sessionManager: { getSessionFile: () => mgrPath },
        extensionRunner: { hasHandlers: vi.fn(() => false) },
      },
    });

    await manager.executeExternalMessage("hello", "bridge-k-read-only-full-tools", null, { agentId: "agent-a" });

    const createArgs = createAgentSessionMock.mock.calls.at(-1)[0];
    expect(createArgs.tools.map((tool) => tool.name)).toEqual(["read", "write"]);
    expect(createArgs.customTools.map((tool) => tool.name)).toEqual([
      "search_memory",
      "record_experience",
    ]);
  });

  it.skip("owner bridge text-only model prepares images through the vision bridge", async () => {
    const agent = makeAgent(rootDir);
    const visionBridge = {
      prepare: vi.fn(async ({ text }) => ({ text, images: undefined })),
      injectNotes: vi.fn(() => ({ injected: 0 })),
    };
    const deps = {
      ...makeDeps(agent),
      getVisionBridge: () => visionBridge,
      isVisionAuxiliaryEnabled: () => true,
      getModelManager: () => ({
        availableModels: [{ id: "gpt-4o", provider: "openai", name: "GPT-4o", input: ["text"] }],
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "medium",
      }),
    };
    const mgrPath = path.join(agent.sessionDir, "bridge", "owner", "s-vision.jsonl");
    const manager = new BridgeSessionManager(deps);
    sessionManagerCreateMock.mockReturnValue({ getSessionFile: () => mgrPath });

    const session = {
      model: { id: "gpt-4o", provider: "openai", input: ["text"] },
      prompt: vi.fn(async () => {}),
      subscribe: vi.fn(() => () => {}),
      dispose: vi.fn(),
      sessionManager: { getSessionFile: () => mgrPath },
      extensionRunner: { hasHandlers: vi.fn(() => false) },
    };
    createAgentSessionMock.mockResolvedValue({ session });
    const images = [{ type: "image", data: PNG_BASE64, mimeType: "image/png" }];

    await manager.executeExternalMessage("hello", "bridge-k-vision", null, {
      agentId: "agent-a",
      images,
      imageAttachmentPaths: ["/tmp/upload.png"],
    });

    expect(visionBridge.prepare).toHaveBeenCalledWith(expect.objectContaining({
      targetModel: expect.objectContaining({ input: ["text"] }),
      text: "hello",
      images,
      imageAttachmentPaths: ["/tmp/upload.png"],
    }));
    expect(session.prompt).toHaveBeenCalledWith("hello", undefined);
  });

  it.skip("bridge vision context injection uses captured G-SAP refs when Pi context is stale", async () => {
    const agent = makeAgent(rootDir);
    const sessionFile = path.join(agent.sessionDir, "bridge", "owner", "s-vision-restore.jsonl");
    const imagePath = path.join(rootDir, "bridge-upload.png");
    const textOnlyModel = { id: "gpt-4o", provider: "openai", name: "GPT-4o", input: ["text"] };
    const callText = vi.fn(async () => [
      "image_overview: A bridge image with a red alert.",
      "user_request_answer: The alert is the important visual context.",
      "evidence: red alert.",
      "uncertainty: none.",
    ].join("\n"));
    const visionBridge = new VisionBridge({
      resolveVisionConfig: () => ({
        model: { id: "qwen-vl", provider: "dashscope", input: ["text", "image"] },
        api: "openai-completions",
        api_key: "sk-test",
        base_url: "https://example.test/v1",
      }),
      callText,
    });
    await visionBridge.prepare({
      sessionPath: sessionFile,
      targetModel: textOnlyModel,
      text: `[attached_image: ${imagePath}]\nwhat is this?`,
      images: [{ type: "image", data: PNG_BASE64, mimeType: "image/png" }],
      imageAttachmentPaths: [imagePath],
    });
    const deps = {
      ...makeDeps(agent),
      getVisionBridge: () => visionBridge,
      isVisionAuxiliaryEnabled: () => true,
      getModelManager: () => ({
        availableModels: [textOnlyModel],
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "medium",
      }),
    };
    const manager = new BridgeSessionManager(deps);
    sessionManagerCreateMock.mockReturnValue({ getSessionFile: () => sessionFile });

    let injectedText = "";
    const session = {
      model: textOnlyModel,
      prompt: vi.fn(async () => {
        const resourceLoader = createAgentSessionMock.mock.calls.at(-1)[0].resourceLoader;
        const extension = resourceLoader.getExtensions().extensions
          .find((entry) => entry.path === "hana-vision-context-injection");
        const handler = extension.handlers.get("context")[0];
        const staleCtx = {
          get sessionManager() {
            throw new Error("stale session manager");
          },
          get model() {
            throw new Error("stale model");
          },
        };
        const result = await handler({
          messages: [{
            role: "user",
            content: [{ type: "text", text: `[attached_image: ${imagePath}]\nwhat is this?` }],
          }],
        }, staleCtx);
        injectedText = result.messages[0].content[0].text;
      }),
      subscribe: vi.fn(() => () => {}),
      dispose: vi.fn(),
      sessionManager: { getSessionFile: () => sessionFile },
      extensionRunner: { hasHandlers: vi.fn(() => false) },
    };
    createAgentSessionMock.mockResolvedValue({ session });

    await manager.executeExternalMessage("what is this?", "bridge-k-vision-restore", null, { agentId: "agent-a" });

    expect(injectedText).toContain(VISION_CONTEXT_START);
    expect(injectedText).toContain("image_overview");
  });

  it.skip("compactSession 的临时 owner session 结束后也会 shutdown + dispose", async () => {
    const agent = makeAgent(rootDir);
    const manager = new BridgeSessionManager(makeDeps(agent));
    const bridgeDir = path.join(agent.sessionDir, "bridge");
    const sessionFile = path.join(bridgeDir, "owner", "s1.jsonl");
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, "", "utf-8");
    manager.writeIndex({ "bridge-k2": { file: "owner/s1.jsonl" } }, agent);
    sessionManagerOpenMock.mockReturnValue({ getSessionFile: () => sessionFile });

    const callOrder = [];
    const session = {
      isCompacting: false,
      compact: vi.fn(async () => {}),
      getContextUsage: vi.fn()
        .mockReturnValueOnce({ tokens: 900, contextWindow: 128000 })
        .mockReturnValueOnce({ tokens: 300, contextWindow: 128000 }),
      dispose: vi.fn(() => { callOrder.push("dispose"); }),
      extensionRunner: {
        hasHandlers: vi.fn(() => true),
        emit: vi.fn(async () => { callOrder.push("emit"); }),
      },
    };
    createAgentSessionMock.mockResolvedValue({ session });

    const result = await manager.compactSession("bridge-k2", { agentId: "agent-a" });

    expect(result).toEqual({ tokensBefore: 900, tokensAfter: 300, contextWindow: 128000 });
    expect(callOrder).toEqual(["emit", "dispose"]);
    expect(emitSessionShutdownMock).toHaveBeenCalledWith(session);
    expect(session.dispose).toHaveBeenCalledOnce();
  });

  it.skip("open 旧 bridge session 失败后，会把索引自愈到新建文件并保留元数据", async () => {
    const agent = makeAgent(rootDir);
    const manager = new BridgeSessionManager(makeDeps(agent));
    const bridgeDir = path.join(agent.sessionDir, "bridge");
    const stalePath = path.join(bridgeDir, "owner", "stale.jsonl");
    const freshPath = path.join(bridgeDir, "owner", "fresh.jsonl");
    manager.writeIndex({
      "bridge-k3": { file: "owner/stale.jsonl", name: "Alice", userId: "u-1" },
    }, agent);

    sessionManagerOpenMock.mockImplementation(() => {
      throw new Error(`cannot open ${stalePath}`);
    });
    sessionManagerCreateMock.mockReturnValue({ getSessionFile: () => freshPath });

    const session = {
      model: { input: ["text"] },
      prompt: vi.fn(async () => {}),
      subscribe: vi.fn(() => () => {}),
      dispose: vi.fn(),
      sessionManager: { getSessionFile: () => freshPath },
      extensionRunner: {
        hasHandlers: vi.fn(() => false),
      },
    };
    createAgentSessionMock.mockResolvedValue({ session });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await manager.executeExternalMessage("hello", "bridge-k3", null, { agentId: "agent-a" });
    } finally {
      warnSpy.mockRestore();
    }

    expect(sessionManagerOpenMock).toHaveBeenCalledOnce();
    expect(sessionManagerCreateMock).toHaveBeenCalledOnce();
    expect(manager.readIndex(agent)["bridge-k3"]).toMatchObject({
      file: "owner/fresh.jsonl",
      name: "Alice",
      userId: "u-1",
    });
  });

  it.skip("explicit unresolved agentId errors instead of falling back to focus agent", async () => {
    const agent = makeAgent(rootDir);
    const manager = new BridgeSessionManager(makeDeps(agent));

    await expect(
      manager.executeExternalMessage("hello", "bridge-missing", null, { agentId: "missing-agent" }),
    ).resolves.toMatchObject({
      __bridgeError: true,
      message: expect.stringMatching(/agent "missing-agent" not found/),
    });
    expect(() => manager.injectMessage("bridge-missing", "note", { agentId: "missing-agent" }))
      .toThrow(/agent "missing-agent" not found/);
    await expect(
      manager.compactSession("bridge-missing", { agentId: "missing-agent" }),
    ).rejects.toThrow(/agent "missing-agent" not found/);
    expect(sessionManagerCreateMock).not.toHaveBeenCalled();
    expect(sessionManagerOpenMock).not.toHaveBeenCalled();
  });

  it.skip("recordAssistantMessage creates an owner bridge session when requested", () => {
    const agent = makeAgent(rootDir);
    const manager = new BridgeSessionManager(makeDeps(agent));
    const sessionPath = path.join(agent.sessionDir, "bridge", "owner", "proactive.jsonl");
    const appendMessage = vi.fn();
    sessionManagerCreateMock.mockReturnValue({
      getSessionFile: () => sessionPath,
      appendMessage,
    });

    const recorded = manager.recordAssistantMessage(
      "wx_dm_owner@agent-a",
      "AI 日报\n\n今天有三条新闻。",
      {
        agentId: "agent-a",
        createIfMissing: true,
        meta: { userId: "owner", chatId: "owner", name: "Owner" },
      },
    );

    expect(recorded).toBe(true);
    expect(sessionManagerCreateMock).toHaveBeenCalledWith(
      rootCwd,
      path.join(agent.sessionDir, "bridge", "owner"),
    );
    expect(appendMessage).toHaveBeenCalledWith(expect.objectContaining({
      role: "assistant",
      content: [{ type: "text", text: "AI 日报\n\n今天有三条新闻。" }],
      api: "openai-completions",
      provider: "openai",
      model: "gpt-4o",
      stopReason: "stop",
      timestamp: expect.any(Number),
      usage: expect.objectContaining({
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: expect.objectContaining({ total: 0 }),
      }),
    }));
    expect(manager.readIndex(agent)["wx_dm_owner@agent-a"]).toMatchObject({
      file: "owner/proactive.jsonl",
      userId: "owner",
      chatId: "owner",
      name: "Owner",
    });
  });

  it.skip("reconcile cleans bridge indexes for every agent, not just focus agent", () => {
    const focusAgent = makeAgent(path.join(rootDir, "focus"), "focus");
    const otherAgent = makeAgent(path.join(rootDir, "other"), "other");
    const deps = {
      ...makeDeps(focusAgent),
      getAgents: () => new Map([
        [focusAgent.id, focusAgent],
        [otherAgent.id, otherAgent],
      ]),
    };
    const manager = new BridgeSessionManager(deps);

    manager.writeIndex({ "focus-k": { file: "owner/missing-focus.jsonl", name: "Focus" } }, focusAgent);
    manager.writeIndex({ "other-k": { file: "owner/missing-other.jsonl", name: "Other" } }, otherAgent);

    manager.reconcile();

    expect(manager.readIndex(focusAgent)["focus-k"]).toEqual({ name: "Focus" });
    expect(manager.readIndex(otherAgent)["other-k"]).toEqual({ name: "Other" });
  });
});
