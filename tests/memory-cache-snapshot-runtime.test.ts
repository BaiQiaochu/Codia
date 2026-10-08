import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

vi.mock("../lib/memory/compile.js", () => ({
  compileToday: vi.fn().mockResolvedValue("compiled"),
  compileWeek: vi.fn().mockResolvedValue("compiled"),
  compileLongterm: vi.fn().mockResolvedValue("compiled"),
  compileFacts: vi.fn().mockResolvedValue("compiled"),
  assemble: vi.fn(),
}));

vi.mock("../lib/memory/deep-memory.js", () => ({
  processDirtySessions: vi.fn().mockResolvedValue({ processed: 0, factsAdded: 0 }),
}));

vi.mock("../lib/debug-log.js", () => ({
  debugLog: () => null,
  createModuleLogger: () => ({
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { createMemoryTicker } from "../lib/memory/memory-ticker.js";
import { readCacheSnapshotObservation } from "../lib/memory/cache-snapshot-observation.js";

function writeSession(sessionPath) {
  const lines = [
    {
      type: "message",
      timestamp: "2026-06-03T10:00:00.000Z",
      message: { role: "user", content: "Connect rolling summary to a cache snapshot." },
    },
    {
      type: "message",
      timestamp: "2026-06-03T10:01:00.000Z",
      message: { role: "assistant", content: "Use shadow mode first, then write mode after validation." },
    },
  ];
  fs.writeFileSync(sessionPath, lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf-8");
}

function makeTicker(tmpDir, mode, summaryManager, memoryReflectionRunner) {
  const agentDir = path.join(tmpDir, "agents", "gsap-agent");
  const sessionDir = path.join(agentDir, "sessions");
  const memoryDir = path.join(agentDir, "memory");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeFileSync(path.join(memoryDir, "memory.md"), "# Memory\n\nExisting official memory.\n", "utf-8");

  const ticker = createMemoryTicker({
    agentId: "gsap-agent",
    agentDir,
    summaryManager,
    configPath: path.join(agentDir, "config.yaml"),
    factStore: {},
    getResolvedMemoryModel: () => ({
      model: "memory-model",
      provider: "openai-compatible",
      api: "openai-completions",
      api_key: "test-key",
      base_url: "http://localhost:1234",
    }),
    getMemoryMasterEnabled: () => true,
    isSessionMemoryEnabled: () => true,
    getCacheSnapshotReflectionMode: () => mode,
    memoryReflectionRunner,
    buildSessionCacheSnapshot: vi.fn((sessionPath, { reason, messages }) => ({
      strategy: "session_snapshot",
      strict: true,
      sessionPath,
      reason,
      cachePrefixHash: "a".repeat(64),
      parentCachePrefixHash: "",
      cacheKeyParams: { thinkingLevel: "medium" },
      tools: [{ name: "read", description: "Read files", parameters: { type: "object" } }],
      messages,
      messageCount: messages.length,
    })),
    getSessionStreamFn: vi.fn(() => vi.fn()),
    sessionDir,
    memoryDir,
    memoryMdPath: path.join(memoryDir, "memory.md"),
    todayMdPath: path.join(memoryDir, "today.md"),
    weekMdPath: path.join(memoryDir, "week.md"),
    longtermMdPath: path.join(memoryDir, "longterm.md"),
    factsMdPath: path.join(memoryDir, "facts.md"),
  });

  return {
    ticker,
    agentDir,
    sessionPath: path.join(sessionDir, "2026-06-03T10-00-00-000Z_cache.jsonl"),
  };
}

describe("cache snapshot reflection runtime", () => {
  let tmpDir;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-cache-snapshot-runtime-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("retired shadow mode keeps the official rolling summary path without reflection side effects", async () => {
    const summaryManager = {
      rollingSummary: vi.fn().mockResolvedValue("official summary"),
      createRollingSummaryDraft: vi.fn(),
      saveSummary: vi.fn(),
      getSummary: vi.fn().mockReturnValue(null),
    };
    const memoryReflectionRunner = {
      runMemoryReflection: vi.fn().mockResolvedValue({
        summary: "shadow summary",
        changed: true,
        data: { summary: "shadow summary" },
        usage: {
          input: { uncachedTokens: 3 },
          cache: { readTokens: 997, missTokens: 3 },
        },
        metadata: {
          cacheStrategy: "session_snapshot",
          strict: true,
          cachePrefixHash: "b".repeat(64),
          parentCachePrefixHash: "a".repeat(64),
        },
      }),
    };
    const { ticker, agentDir, sessionPath } = makeTicker(tmpDir, "shadow", summaryManager, memoryReflectionRunner);
    writeSession(sessionPath);

    await ticker.flushSession(sessionPath);

    expect(summaryManager.rollingSummary).toHaveBeenCalledOnce();
    expect(summaryManager.createRollingSummaryDraft).not.toHaveBeenCalled();
    expect(memoryReflectionRunner.runMemoryReflection).not.toHaveBeenCalled();
    expect(summaryManager.saveSummary).not.toHaveBeenCalled();

    const observation = readCacheSnapshotObservation(agentDir);
    expect(observation).toBeNull();
  });

  it("passes persisted memory reflection snapshots into the official rolling summary", async () => {
    const snapshot = {
      version: 1,
      agentName: "G-SAP",
      userName: "Test User",
      existingMemory: "Stable memory before this session.",
    };
    const summaryManager = {
      rollingSummary: vi.fn().mockResolvedValue("official summary"),
      getSummary: vi.fn().mockReturnValue(null),
    };
    const memoryReflectionRunner = {
      runMemoryReflection: vi.fn(),
    };
    const { ticker, sessionPath } = makeTicker(tmpDir, "off", summaryManager, memoryReflectionRunner);
    writeSession(sessionPath);
    fs.writeFileSync(
      path.join(path.dirname(sessionPath), "session-meta.json"),
      JSON.stringify({ [path.basename(sessionPath)]: { memoryReflectionSnapshot: snapshot } }),
      "utf-8",
    );

    await ticker.flushSession(sessionPath);

    expect(summaryManager.rollingSummary).toHaveBeenCalledOnce();
    expect(summaryManager.rollingSummary.mock.calls[0][3]).toMatchObject({
      memoryReflectionSnapshot: snapshot,
    });
  });

  it("retired write mode falls back to the official rolling summary path", async () => {
    const sessionId = "2026-06-03T10-00-00-000Z_cache";
    const summaryData = {
      session_id: sessionId,
      created_at: "2026-06-03T10:02:00.000Z",
      updated_at: "2026-06-03T10:02:00.000Z",
      summary: "write summary",
      messageCount: 2,
    };
    const summaryManager = {
      rollingSummary: vi.fn().mockResolvedValue("legacy summary"),
      createRollingSummaryDraft: vi.fn(),
      saveSummary: vi.fn(),
      getSummary: vi.fn().mockReturnValue(null),
    };
    const memoryReflectionRunner = {
      runMemoryReflection: vi.fn().mockResolvedValue({
        summary: "write summary",
        changed: true,
        data: summaryData,
        usage: { cache: { readTokens: 1200, missTokens: 4 } },
        metadata: {
          cacheStrategy: "session_snapshot",
          strict: true,
          cachePrefixHash: "b".repeat(64),
          parentCachePrefixHash: "a".repeat(64),
        },
      }),
    };
    const { ticker, agentDir, sessionPath } = makeTicker(tmpDir, "write", summaryManager, memoryReflectionRunner);
    writeSession(sessionPath);

    await ticker.flushSession(sessionPath);

    expect(summaryManager.rollingSummary).toHaveBeenCalledOnce();
    expect(summaryManager.createRollingSummaryDraft).not.toHaveBeenCalled();
    expect(memoryReflectionRunner.runMemoryReflection).not.toHaveBeenCalled();
    expect(summaryManager.saveSummary).not.toHaveBeenCalled();

    const observation = readCacheSnapshotObservation(agentDir);
    expect(observation).toBeNull();
  });

  it("retired write mode ignores non-strict reflection results because reflection is disabled", async () => {
    const summaryManager = {
      rollingSummary: vi.fn(),
      createRollingSummaryDraft: vi.fn(),
      saveSummary: vi.fn(),
      getSummary: vi.fn().mockReturnValue(null),
    };
    const memoryReflectionRunner = {
      runMemoryReflection: vi.fn().mockResolvedValue({
        summary: "recovery summary",
        changed: true,
        data: { summary: "recovery summary" },
        usage: { cache: { readTokens: 0, missTokens: 100 } },
        metadata: {
          cacheStrategy: "cache_recovery",
          strict: false,
          degradeReason: "session_snapshot_contract_mismatch",
        },
      }),
    };
    const { ticker, agentDir, sessionPath } = makeTicker(tmpDir, "write", summaryManager, memoryReflectionRunner);
    writeSession(sessionPath);

    await expect(ticker.flushSession(sessionPath)).resolves.toBeUndefined();
    expect(summaryManager.rollingSummary).toHaveBeenCalledOnce();
    expect(memoryReflectionRunner.runMemoryReflection).not.toHaveBeenCalled();
    expect(summaryManager.saveSummary).not.toHaveBeenCalled();
    const observation = readCacheSnapshotObservation(agentDir);
    expect(observation).toBeNull();
  });

  it("retired shadow mode does not record reflection diagnostics", async () => {
    const summaryManager = {
      rollingSummary: vi.fn().mockResolvedValue("official summary"),
      createRollingSummaryDraft: vi.fn(),
      saveSummary: vi.fn(),
      getSummary: vi.fn().mockReturnValue(null),
    };
    const error = new Error("provider failed");
    error.name = "ProviderError";
    const memoryReflectionRunner = {
      runMemoryReflection: vi.fn().mockRejectedValue(error),
    };
    const { ticker, agentDir, sessionPath } = makeTicker(tmpDir, "shadow", summaryManager, memoryReflectionRunner);
    writeSession(sessionPath);

    await ticker.flushSession(sessionPath);

    const observation = readCacheSnapshotObservation(agentDir);
    expect(summaryManager.rollingSummary).toHaveBeenCalledOnce();
    expect(memoryReflectionRunner.runMemoryReflection).not.toHaveBeenCalled();
    expect(observation).toBeNull();
  });
});
