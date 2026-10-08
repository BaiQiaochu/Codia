// @ts-nocheck
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createAgentSessionMock = vi.fn();
const sessionManagerCreateMock = vi.fn();
const sessionManagerOpenMock = vi.fn();

vi.mock("../lib/pi-sdk/index.js", () => ({
  createAgentSession: (...args) => createAgentSessionMock(...args),
  emitSessionShutdown: vi.fn(async () => false),
  SettingsManager: {
    inMemory: vi.fn((settings) => settings),
  },
  SessionManager: {
    create: (...args) => sessionManagerCreateMock(...args),
    open: (...args) => sessionManagerOpenMock(...args),
  },
}));

import { BridgeSessionManager } from "../core/bridge-session-manager.js";

let rootDir;
let rootCwd;

function makeAgent(id = "agent-a") {
  const sessionDir = path.join(rootDir, "sessions");
  const agentDir = path.join(rootDir, "agents", id);
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
    getGsapHome: () => rootDir,
    getAgent: () => agent,
    getAgentById: (id) => (id === agent.id ? agent : null),
    getAgents: () => new Map([[agent.id, agent]]),
    getModelManager: () => ({
      availableModels: [{ id: "gpt-4o", provider: "openai", name: "GPT-4o", input: ["text"] }],
      authStorage: {},
      modelRegistry: {},
      resolveThinkingLevel: () => "medium",
    }),
    getResourceLoader: () => ({ getSystemPrompt: () => "fallback prompt" }),
    getPreferences: () => ({ thinking_level: "medium", bridge: {} }),
    buildTools: () => ({ tools: [], customTools: [] }),
    getHomeCwd: () => rootCwd,
  };
}

describe("BridgeSessionManager memory ticker integration", () => {
  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-session-memory-"));
    rootCwd = path.join(rootDir, "cwd");
    fs.mkdirSync(rootCwd, { recursive: true });
    createAgentSessionMock.mockReset();
    sessionManagerCreateMock.mockReset();
    sessionManagerOpenMock.mockReset();
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it("includes the owner session path in daily fresh compact targets", () => {
    const agent = makeAgent();
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

    expect(manager.listDailyFreshCompactTargets(agent, {
      now: new Date("2026-05-15T09:00:00.000Z"),
    })).toEqual([{ sessionKey: "tg_dm_existing@agent-a", sessionPath: sessionFile, reason: "daily" }]);
  });

  it("notifies the owner bridge memory ticker after a successful external turn", async () => {
    const agent = makeAgent();
    agent.memoryTicker = {
      notifyTurn: vi.fn(),
    };
    const sessionFile = path.join(agent.sessionDir, "bridge", "owner", "memory-turn.jsonl");
    const manager = new BridgeSessionManager(makeDeps(agent));
    sessionManagerCreateMock.mockReturnValue({ getSessionFile: () => sessionFile });

    const session = {
      model: { id: "gpt-4o", provider: "openai", input: ["text"] },
      prompt: vi.fn(async () => {}),
      subscribe: vi.fn(() => vi.fn()),
      dispose: vi.fn(),
      sessionManager: { getSessionFile: () => sessionFile },
      extensionRunner: { hasHandlers: vi.fn(() => false) },
    };
    createAgentSessionMock.mockResolvedValue({ session });

    await manager.executeExternalMessage("hello", "tg_dm_owner@agent-a", null, { agentId: "agent-a" });

    expect(agent.memoryTicker.notifyTurn).toHaveBeenCalledOnce();
    expect(agent.memoryTicker.notifyTurn).toHaveBeenCalledWith(sessionFile);
  });

  it("returns settings update summaries emitted by bridge session tools", async () => {
    const agent = makeAgent();
    const sessionFile = path.join(agent.sessionDir, "bridge", "owner", "settings-update.jsonl");
    const manager = new BridgeSessionManager(makeDeps(agent));
    sessionManagerCreateMock.mockReturnValue({ getSessionFile: () => sessionFile });

    const subscribers = [];
    const session = {
      model: { id: "gpt-4o", provider: "openai", input: ["text"] },
      prompt: vi.fn(async () => {
        for (const fn of subscribers) {
          fn({
            type: "tool_execution_end",
            isError: false,
            result: {
              details: {
                settingsUpdate: {
                  status: "applied",
                  action: "core.apply",
                  key: "locale",
                  title: "Locale updated",
                  summary: "Locale changed.",
                  changes: [{ key: "locale", label: "Locale", before: "zh-CN", after: "en" }],
                },
              },
            },
          });
        }
      }),
      subscribe: vi.fn((fn) => {
        subscribers.push(fn);
        return vi.fn();
      }),
      dispose: vi.fn(),
      sessionManager: { getSessionFile: () => sessionFile },
      extensionRunner: { hasHandlers: vi.fn(() => false) },
    };
    createAgentSessionMock.mockResolvedValue({ session });

    const result = await manager.executeExternalMessage("hello", "tg_dm_owner@agent-a", null, { agentId: "agent-a" });
    const text = typeof result === "object" ? result.text : result;

    expect(text).toContain("Locale updated");
    expect(text).toContain("Locale: zh-CN -> en");
  });
});
