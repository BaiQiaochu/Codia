// @ts-nocheck
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import fsp from "fs/promises";
import os from "os";
import path from "path";

vi.mock("../lib/pi-sdk/index.js", () => ({
  createAgentSession: vi.fn(),
  estimateTokens: vi.fn(() => 0),
  findCutPoint: vi.fn(() => 0),
  generateSummary: vi.fn(async () => ""),
  refreshSessionModelFromRegistry: vi.fn(),
  SessionManager: {
    create: vi.fn(),
    list: vi.fn(),
    open: vi.fn(),
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
      agentDir: "/tmp/agents/codia",
    }),
    getActiveAgentId: () => "codia",
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
    getAgents: () => new Map(),
    getActivityStore: () => null,
    getAgentById: () => null,
    listAgents: () => [],
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

describe("SessionCoordinator pinned session metadata", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codia-pinned-meta-"));
    vi.mocked(SessionManager.list).mockReset();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes and clears pinnedAt in the session directory sidecar", async () => {
    const sessionDir = path.join(tmpDir, "sessions");
    const sessionPath = path.join(sessionDir, "a.jsonl");
    fs.mkdirSync(sessionDir, { recursive: true });

    const coord = new SessionCoordinator(makeCoordinatorDeps({ _sessionDir: sessionDir }));
    const pinnedAt = await coord.setSessionPinned(sessionPath, true);

    const metaPath = path.join(sessionDir, "session-meta.json");
    let meta = JSON.parse(await fsp.readFile(metaPath, "utf-8"));
    expect(meta[path.basename(sessionPath)].pinnedAt).toBe(pinnedAt);
    expect(new Date(pinnedAt).toString()).not.toBe("Invalid Date");

    const unpinnedAt = await coord.setSessionPinned(sessionPath, false);

    meta = JSON.parse(await fsp.readFile(metaPath, "utf-8"));
    expect(unpinnedAt).toBeNull();
    expect(meta[path.basename(sessionPath)].pinnedAt).toBeNull();
  });

  it("listSessions reads pinnedAt from the same sidecar path used by writes", async () => {
    const agentsDir = path.join(tmpDir, "agents");
    const sessionDir = path.join(agentsDir, "codia", "sessions");
    const sessionPath = path.join(sessionDir, "pinned.jsonl");
    const pinnedAt = "2026-04-29T08:00:00.000Z";
    fs.mkdirSync(sessionDir, { recursive: true });
    writeSessionJsonl(sessionPath);
    fs.writeFileSync(
      path.join(sessionDir, "session-meta.json"),
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
      listAgents: () => [{ id: "codia", name: "Codia" }],
      agentIdFromSessionPath: (p) => {
        const rel = path.relative(agentsDir, p);
        return rel.split(path.sep)[0] || null;
      },
    }));

    const sessions = await coord.listSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0].pinnedAt).toBe(pinnedAt);
    expect(sessions[0].agentId).toBe("codia");
  });
});
