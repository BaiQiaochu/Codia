/**
 * #1285 I1：bridge 冷恢复路径读时修复测试
 *
 * 两个 SessionManager.open 调用路径必须在 open 之前调用
 * repairOrphanToolResultEntriesInFile，与 session-coordinator 的
 * _repairOrphanToolHistory 挂载方式完全一致。
 *
 * 路径一：executeExternalMessage — bridge 入站消息回复既有 session（冷恢复）
 * 路径二：compactBridgeSession   — bridge compaction reopen 既有 session 文件
 *
 * 两条测试逻辑：
 *  - 修复函数在 SessionManager.open 之前被调用（顺序）
 *  - 即使修复函数抛错，open 仍正常执行（失败不阻塞）
 */
import fs from "fs";
import os from "os";
import path from "path";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";

// ── Pi SDK mock（避免拉真实 SDK） ──
const sessionManagerOpenMock = vi.fn();
const sessionManagerCreateMock = vi.fn();
const createAgentSessionMock = vi.fn();

vi.mock("../lib/pi-sdk/index.js", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    createAgentSession: (...args: any[]) => createAgentSessionMock(...args),
    SessionManager: {
      ...actual.SessionManager,
      create: (...args: any[]) => sessionManagerCreateMock(...args),
      open: (...args: any[]) => sessionManagerOpenMock(...args),
    },
  };
});

// ── session-health mock，让测试能追踪调用顺序 ──
const repairMock = vi.fn(() => ({ repaired: false, removed: 0 }));

vi.mock("../core/session-health.js", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    repairOrphanToolResultEntriesInFile: (...args: any[]) => (repairMock as any)(...args),
  };
});

const repairInlineMediaMock = vi.fn(() => ({
  repaired: false,
  stripped: 0,
  strippedImages: 0,
  strippedVideos: 0,
  strippedAudios: 0,
}));
const pruneInlineMediaMock = vi.fn(() => ({
  stripped: 0,
  strippedImages: 0,
  strippedVideos: 0,
  strippedAudios: 0,
}));

vi.mock("../core/session-inline-media-prune.js", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    pruneSessionInlineMediaHistory: (...args: any[]) => (pruneInlineMediaMock as any)(...args),
    repairSessionInlineMediaEntriesInFile: (...args: any[]) => (repairInlineMediaMock as any)(...args),
  };
});

vi.mock("../lib/debug-log.js", () => ({
  debugLog: () => null,
  createModuleLogger: () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { BridgeSessionManager } from "../core/bridge-session-manager.ts";

// ── 测试脚手架 ──

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

function makeDeps(agent, rootDir) {
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
    getHomeCwd: () => path.join(rootDir, "cwd"),
    registerSessionFile: vi.fn(({ sessionPath, filePath, label, origin, storageKind }) => ({
      id: "sf_bridge_inbound",
      fileId: "sf_bridge_inbound",
      sessionPath,
      filePath,
      realPath: filePath,
      displayName: label,
      filename: path.basename(filePath),
      label,
      ext: "txt",
      mime: "text/plain",
      size: 4,
      kind: "file",
      origin,
      storageKind,
      createdAt: 1,
    })),
  };
}

function makeMinimalSession(mgrPath) {
  return {
    model: { input: ["text"] },
    prompt: vi.fn(async () => {}),
    subscribe: vi.fn(() => vi.fn()),
    dispose: vi.fn(),
    sessionManager: { getSessionFile: () => mgrPath },
    extensionRunner: { hasHandlers: vi.fn(() => false) },
  };
}

let rootDir;

beforeEach(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-orphan-repair-"));
  fs.mkdirSync(path.join(rootDir, "cwd"), { recursive: true });
  repairMock.mockReset().mockReturnValue({ repaired: false, removed: 0 });
  repairInlineMediaMock.mockReset().mockReturnValue({
    repaired: false,
    stripped: 0,
    strippedImages: 0,
    strippedVideos: 0,
    strippedAudios: 0,
  });
  pruneInlineMediaMock.mockReset().mockReturnValue({
    stripped: 0,
    strippedImages: 0,
    strippedVideos: 0,
    strippedAudios: 0,
  });
  sessionManagerOpenMock.mockReset();
  sessionManagerCreateMock.mockReset();
  createAgentSessionMock.mockReset();
});

afterEach(() => {
  fs.rmSync(rootDir, { recursive: true, force: true });
});

// ── 工具函数：写 bridge index 并创建 session 文件 ──

function setupExistingBridgeSession(agent, sessionKey = "tg_dm_owner@agent-a") {
  const bridgeDir = path.join(agent.sessionDir, "bridge");
  const ownerDir = path.join(bridgeDir, "owner");
  fs.mkdirSync(ownerDir, { recursive: true });

  const relFile = "owner/existing.jsonl";
  const absFile = path.join(bridgeDir, relFile);
  // 写一个最简 jsonl（内容不影响 mock，但 existsSync 需要文件存在）
  fs.writeFileSync(absFile, '{"type":"session","version":3}\n', "utf-8");

  // 写 index：index key → {file: relFile}（BridgeSessionManager 使用 bridge-sessions.json）
  const indexPath = path.join(bridgeDir, "bridge-sessions.json");
  fs.writeFileSync(indexPath, JSON.stringify({ [sessionKey]: { file: relFile, name: "Owner" } }), "utf-8");

  return { bridgeDir, absFile, relFile };
}

// ────────────────────────────────────────────────
// 路径一：executeExternalMessage 冷恢复
// ────────────────────────────────────────────────

describe("executeExternalMessage — 冷恢复 open 前调 repairOrphanToolResultEntriesInFile", () => {
  it("既有 session 时，repair 在 SessionManager.open 之前调用（顺序验证）", async () => {
    const agent = makeAgent(rootDir);
    const { absFile } = setupExistingBridgeSession(agent);
    const manager = new BridgeSessionManager(makeDeps(agent, rootDir));

    const callOrder = [];
    (repairMock.mockImplementation as any)((p: any) => {
      callOrder.push("orphan-repair");
      return { repaired: false, removed: 0 };
    });
    (repairInlineMediaMock.mockImplementation as any)((p: any) => {
      callOrder.push("inline-media-repair");
      return { repaired: false, stripped: 0, strippedImages: 0, strippedVideos: 0, strippedAudios: 0 };
    });

    const mgrPath = path.join(agent.sessionDir, "bridge", "owner", "existing.jsonl");
    sessionManagerOpenMock.mockImplementation(() => {
      callOrder.push("open");
      return { getSessionFile: () => mgrPath };
    });

    const session = makeMinimalSession(mgrPath);
    createAgentSessionMock.mockResolvedValue({ session });

    await manager.executeExternalMessage("hello", "tg_dm_owner@agent-a", null, { agentId: "agent-a" });

    expect(callOrder).toEqual(["orphan-repair", "inline-media-repair", "open"]);
    expect(repairMock).toHaveBeenCalledWith(absFile);
    expect(repairInlineMediaMock).toHaveBeenCalledWith(absFile);
  });

  it("repair 抛错时，open 仍正常执行（失败不阻塞）", async () => {
    const agent = makeAgent(rootDir);
    setupExistingBridgeSession(agent);
    const manager = new BridgeSessionManager(makeDeps(agent, rootDir));

    repairMock.mockImplementation(() => { throw new Error("disk error"); });

    const mgrPath = path.join(agent.sessionDir, "bridge", "owner", "existing.jsonl");
    sessionManagerOpenMock.mockReturnValue({ getSessionFile: () => mgrPath });

    const session = makeMinimalSession(mgrPath);
    createAgentSessionMock.mockResolvedValue({ session });

    // 不应抛出，repair 的错误应被 try/catch 吸收
    await expect(
      manager.executeExternalMessage("hello", "tg_dm_owner@agent-a", null, { agentId: "agent-a" }),
    ).resolves.not.toThrow();

    // open 必须仍被调用
    expect(sessionManagerOpenMock).toHaveBeenCalledOnce();
    expect(repairInlineMediaMock).toHaveBeenCalledOnce();
  });

  it("新建 session（无 existingPath）时不调 repair", async () => {
    const agent = makeAgent(rootDir);
    // 不写 index，没有 existingPath
    const manager = new BridgeSessionManager(makeDeps(agent, rootDir));

    const mgrPath = path.join(agent.sessionDir, "bridge", "owner", "new.jsonl");
    sessionManagerCreateMock.mockReturnValue({ getSessionFile: () => mgrPath });

    const session = makeMinimalSession(mgrPath);
    createAgentSessionMock.mockResolvedValue({ session });

    await manager.executeExternalMessage("hello", "tg_dm_new@agent-a", null, { agentId: "agent-a" });

    expect(repairMock).not.toHaveBeenCalled();
    expect(repairInlineMediaMock).not.toHaveBeenCalled();
  });

  it("prompt 结束后清理 bridge runtime/session 文件里的 inline media", async () => {
    const agent = makeAgent(rootDir);
    const manager = new BridgeSessionManager(makeDeps(agent, rootDir));

    const mgrPath = path.join(agent.sessionDir, "bridge", "owner", "new.jsonl");
    sessionManagerCreateMock.mockReturnValue({ getSessionFile: () => mgrPath });

    const session = makeMinimalSession(mgrPath);
    createAgentSessionMock.mockResolvedValue({ session });

    await manager.executeExternalMessage("hello", "tg_dm_media@agent-a", null, { agentId: "agent-a" });

    expect(pruneInlineMediaMock).toHaveBeenCalledWith(session);
    expect(pruneInlineMediaMock).toHaveBeenCalledTimes(1);
  });
});

// ────────────────────────────────────────────────
// 路径二：compactBridgeSession reopen
// ────────────────────────────────────────────────

describe("compactBridgeSession — reopen 前调 repairOrphanToolResultEntriesInFile", () => {
  it("既有 session 文件，repair 在 SessionManager.open 之前调用（顺序验证）", async () => {
    const agent = makeAgent(rootDir);
    const sessionKey = "tg_dm_compact@agent-a";
    const { absFile } = setupExistingBridgeSession(agent, sessionKey);
    const manager = new BridgeSessionManager(makeDeps(agent, rootDir));

    const callOrder = [];
    repairMock.mockImplementation(() => {
      callOrder.push("orphan-repair");
      return { repaired: false, removed: 0 };
    });
    repairInlineMediaMock.mockImplementation(() => {
      callOrder.push("inline-media-repair");
      return { repaired: false, stripped: 0, strippedImages: 0, strippedVideos: 0, strippedAudios: 0 };
    });

    sessionManagerOpenMock.mockImplementation(() => {
      callOrder.push("open");
      return { getSessionFile: () => absFile };
    });

    const usage = vi.fn()
      .mockReturnValueOnce({ tokens: 10000, contextWindow: 128000 })
      .mockReturnValueOnce({ tokens: 3000, contextWindow: 128000 });
    const session = {
      compact: vi.fn(async () => {}),
      dispose: vi.fn(),
      sessionManager: { getSessionFile: () => absFile },
      getContextUsage: usage,
      // hasHandlers("session_before_compact") must be true for compactSessionWithCachePreservation
      extensionRunner: {
        hasHandlers: vi.fn((evt) => evt === "session_before_compact"),
        emit: vi.fn(async () => {}),
      },
    };
    createAgentSessionMock.mockResolvedValue({ session });

    await manager.compactSession(sessionKey, { agentId: "agent-a" });

    expect(callOrder).toEqual(["orphan-repair", "inline-media-repair", "open"]);
    expect(repairMock).toHaveBeenCalledWith(absFile);
    expect(repairInlineMediaMock).toHaveBeenCalledWith(absFile);
  });

  it("repair 抛错时，compaction open 仍正常执行（失败不阻塞）", async () => {
    const agent = makeAgent(rootDir);
    const sessionKey = "tg_dm_compact_err@agent-a";
    const { absFile } = setupExistingBridgeSession(agent, sessionKey);
    const manager = new BridgeSessionManager(makeDeps(agent, rootDir));

    repairMock.mockImplementation(() => { throw new Error("disk error"); });

    sessionManagerOpenMock.mockReturnValue({ getSessionFile: () => absFile });

    const usage = vi.fn()
      .mockReturnValueOnce({ tokens: 10000, contextWindow: 128000 })
      .mockReturnValueOnce({ tokens: 3000, contextWindow: 128000 });
    const session = {
      compact: vi.fn(async () => {}),
      dispose: vi.fn(),
      sessionManager: { getSessionFile: () => absFile },
      getContextUsage: usage,
      extensionRunner: {
        hasHandlers: vi.fn((evt) => evt === "session_before_compact"),
        emit: vi.fn(async () => {}),
      },
    };
    createAgentSessionMock.mockResolvedValue({ session });

    await expect(
      manager.compactSession(sessionKey, { agentId: "agent-a" }),
    ).resolves.toBeDefined();

    expect(sessionManagerOpenMock).toHaveBeenCalledOnce();
    expect(repairInlineMediaMock).toHaveBeenCalledOnce();
  });
});
