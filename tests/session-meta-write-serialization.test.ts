// @ts-nocheck
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import os from "os";

vi.mock("../lib/pi-sdk/index.js", () => ({
  createAgentSession: vi.fn(),
  SessionManager: {
    create: vi.fn(),
    list: vi.fn(),
    open: vi.fn(),
  },
  SettingsManager: {
    inMemory: vi.fn(() => ({})),
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
import { SessionManager } from "../lib/pi-sdk/index.js";

function makeCoordinatorDeps(overrides = {}) {
  return {
    agentsDir: "/tmp/agents",
    getAgent: () => ({
      sessionDir: overrides._sessionDir || "/tmp/agent-sessions",
      setMemoryEnabled: vi.fn(),
      buildSystemPrompt: () => "mock-prompt",
      config: {},
      tools: [],
      agentDir: "/tmp/agents/gsap",
    }),
    getActiveAgentId: () => "test",
    getModels: () => ({
      currentModel: { id: "m", name: "m" },
      authStorage: {},
      modelRegistry: {},
      resolveThinkingLevel: () => "medium",
    }),
    getResourceLoader: () => ({
      getSystemPrompt: () => "",
      getAppendSystemPrompt: () => [],
    }),
    getSkills: () => null,
    buildTools: () => ({ tools: [], customTools: [] }),
    emitEvent: vi.fn(),
    getHomeCwd: () => "/tmp/home",
    agentIdFromSessionPath: () => null,
    switchAgentOnly: async () => {},
    getConfig: () => ({}),
    getPrefs: () => ({ getThinkingLevel: () => "medium" }),
    getAgents: () => new Map(),
    getActivityStore: () => null,
    getAgentById: () => null,
    listAgents: () => [],
    getDeferredResultStore: () => null,
    ...overrides,
  };
}

function writeSessionJsonl(sessionPath, { message = "hello" } = {}) {
  fs.writeFileSync(
    sessionPath,
    [
      JSON.stringify({
        type: "session",
        id: path.basename(sessionPath, ".jsonl"),
        timestamp: "2026-04-29T07:00:00.000Z",
        cwd: "/tmp/work",
      }),
      JSON.stringify({
        type: "message",
        timestamp: "2026-04-29T07:00:01.000Z",
        message: {
          role: "user",
          content: message,
          timestamp: "2026-04-29T07:00:01.000Z",
        },
      }),
    ].join("\n") + "\n",
    "utf-8",
  );
}

describe("SessionCoordinator.writeSessionMeta serialization", () => {
  let tmpDir;
  let sessionDir;
  let sessionCoord;
  let fakeSessionPath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "meta-serial-"));
    sessionDir = path.join(tmpDir, "sessions");
    fs.mkdirSync(sessionDir, { recursive: true });
    fakeSessionPath = path.join(sessionDir, "test-session.jsonl");
    vi.mocked(SessionManager.list).mockReset();

    const deps = makeCoordinatorDeps({ _sessionDir: sessionDir });
    deps.getAgent = () => ({
      sessionDir,
      setMemoryEnabled: vi.fn(),
      buildSystemPrompt: () => "mock-prompt",
      config: {},
      tools: [],
      agentDir: path.join(tmpDir, "agents", "gsap"),
    });

    sessionCoord = new SessionCoordinator(deps);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("two concurrent writeSessionMeta calls with different fields preserve both", async () => {
    const p1 = sessionCoord.writeSessionMeta(fakeSessionPath, { memoryEnabled: false });
    const p2 = sessionCoord.writeSessionMeta(fakeSessionPath, { toolNames: ["read", "bash"] });
    await Promise.all([p1, p2]);

    const metaPath = path.join(sessionDir, "session-meta.json");
    const meta = JSON.parse(await fsp.readFile(metaPath, "utf-8"));
    const entry = meta[path.basename(fakeSessionPath)];
    expect(entry.memoryEnabled).toBe(false);
    expect(entry.toolNames).toEqual(["read", "bash"]);
  });

  it("three sequential writes accumulate fields correctly", async () => {
    await sessionCoord.writeSessionMeta(fakeSessionPath, { memoryEnabled: true });
    await sessionCoord.writeSessionMeta(fakeSessionPath, { toolNames: ["a"] });
    await sessionCoord.writeSessionMeta(fakeSessionPath, { memoryEnabled: false });

    const metaPath = path.join(sessionDir, "session-meta.json");
    const meta = JSON.parse(await fsp.readFile(metaPath, "utf-8"));
    const entry = meta[path.basename(fakeSessionPath)];
    expect(entry.memoryEnabled).toBe(false);
    expect(entry.toolNames).toEqual(["a"]);
  });

  it("a failed write does not block subsequent writes from the same queue", async () => {
    let getAgentCalls = 0;
    const realSessionDir = sessionDir;
    sessionCoord._d.getAgent = () => {
      getAgentCalls += 1;
      if (getAgentCalls === 1) {
        throw new Error("injected getAgent failure");
      }
      return { sessionDir: realSessionDir };
    };

    let secondWriteRan = false;
    const p1 = sessionCoord.writeSessionMeta(fakeSessionPath, { memoryEnabled: true });
    const p2 = sessionCoord.writeSessionMeta(fakeSessionPath, { toolNames: ["x"] }).then((v) => {
      secondWriteRan = true;
      return v;
    });
    await Promise.allSettled([p1, p2]);

    const metaPath = path.join(realSessionDir, "session-meta.json");
    const meta = JSON.parse(await fsp.readFile(metaPath, "utf-8"));
    const entry = meta[path.basename(fakeSessionPath)];
    expect(entry.toolNames).toEqual(["x"]);
    expect(secondWriteRan).toBe(true);
    expect(getAgentCalls).toBeGreaterThanOrEqual(2);
  });

  it("model and modelId fields are stripped from written meta", async () => {
    await sessionCoord.writeSessionMeta(fakeSessionPath, {
      memoryEnabled: true,
      model: "should-be-deleted",
      modelId: "also-deleted",
    });

    const metaPath = path.join(sessionDir, "session-meta.json");
    const meta = JSON.parse(await fsp.readFile(metaPath, "utf-8"));
    const entry = meta[path.basename(fakeSessionPath)];
    expect(entry.model).toBeUndefined();
    expect(entry.modelId).toBeUndefined();
    expect(entry.memoryEnabled).toBe(true);
  });

  it("setSessionPinned writes and clears pinnedAt on the session meta entry", async () => {
    const pinnedAt = await sessionCoord.setSessionPinned(fakeSessionPath, true);

    const metaPath = path.join(sessionDir, "session-meta.json");
    let meta = JSON.parse(await fsp.readFile(metaPath, "utf-8"));
    expect(meta[path.basename(fakeSessionPath)].pinnedAt).toBe(pinnedAt);
    expect(new Date(pinnedAt).toString()).not.toBe("Invalid Date");
    expect(sessionCoord._d.emitEvent).toHaveBeenCalledWith({
      type: "session_metadata_updated",
      metadata: { pinnedAt },
    }, fakeSessionPath);

    const unpinnedAt = await sessionCoord.setSessionPinned(fakeSessionPath, false);

    meta = JSON.parse(await fsp.readFile(metaPath, "utf-8"));
    expect(unpinnedAt).toBeNull();
    expect(meta[path.basename(fakeSessionPath)].pinnedAt).toBeNull();
    expect(sessionCoord._d.emitEvent).toHaveBeenLastCalledWith({
      type: "session_metadata_updated",
      metadata: { pinnedAt: null },
    }, fakeSessionPath);
  });

  it("setSessionThinkingLevel updates inactive session meta and emits a scoped metadata event", async () => {
    await sessionCoord.writeSessionMeta(fakeSessionPath, { thinkingLevel: "medium" });

    const result = await sessionCoord.setSessionThinkingLevel(fakeSessionPath, "high");

    const metaPath = path.join(sessionDir, "session-meta.json");
    const meta = JSON.parse(await fsp.readFile(metaPath, "utf-8"));
    expect(result).toEqual({ ok: true, thinkingLevel: "high" });
    expect(meta[path.basename(fakeSessionPath)].thinkingLevel).toBe("high");
    expect(sessionCoord.getSessionThinkingLevel(fakeSessionPath)).toBe("high");
    expect(sessionCoord._d.emitEvent).toHaveBeenCalledWith({
      type: "session_metadata_updated",
      metadata: { thinkingLevel: "high" },
    }, fakeSessionPath);
  });

  it("listSessions exposes pinnedAt from the session directory sidecar", async () => {
    const agentsDir = path.join(tmpDir, "agents");
    const agentSessionDir = path.join(agentsDir, "gsap", "sessions");
    const sessionPath = path.join(agentSessionDir, "pinned.jsonl");
    const pinnedAt = "2026-04-29T08:00:00.000Z";
    fs.mkdirSync(agentSessionDir, { recursive: true });
    writeSessionJsonl(sessionPath);
    fs.writeFileSync(
      path.join(agentSessionDir, "session-meta.json"),
      JSON.stringify({ [path.basename(sessionPath)]: { pinnedAt } }, null, 2),
      "utf-8",
    );

    vi.mocked(SessionManager.list).mockResolvedValueOnce([
      {
        path: sessionPath,
        title: null,
        firstMessage: "hello",
        modified: new Date("2026-04-29T07:00:00.000Z"),
        messageCount: 1,
        cwd: "/tmp/work",
      },
    ]);

    const coord = new SessionCoordinator(makeCoordinatorDeps({
      agentsDir,
      listAgents: () => [{ id: "gsap", name: "G-SAP" }],
      agentIdFromSessionPath: (p) => {
        const rel = path.relative(agentsDir, p);
        return rel.split(path.sep)[0] || null;
      },
    }));

    const sessions = await coord.listSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0].pinnedAt).toBe(pinnedAt);
    expect(sessions[0].agentId).toBe("gsap");
  });
});
