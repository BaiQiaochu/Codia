import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "os";
import fs from "fs";
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
  createModuleLogger: () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { createMemoryTicker } from "../lib/memory/memory-ticker.js";
import {
  compileToday,
  compileWeek,
  compileLongterm,
  compileFacts,
  assemble,
} from "../lib/memory/compile.js";
import { processDirtySessions } from "../lib/memory/deep-memory.js";

function writeSession(sessionPath) {
  const lines = [
    {
      type: "message",
      timestamp: "2026-03-12T15:47:53.599Z",
      message: { role: "user", content: "hello" },
    },
    {
      type: "message",
      timestamp: "2026-03-12T15:48:04.225Z",
      message: { role: "assistant", content: "world" },
    },
  ];
  fs.writeFileSync(sessionPath, lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf-8");
}

function makeTicker(tmpDir, isSessionMemoryEnabled, getSessionMemoryEnabledFrom = () => null) {
  const summaryManager = {
    rollingSummary: vi.fn().mockResolvedValue("summary"),
    getSummary: vi.fn().mockReturnValue(null),
  };

  const ticker = createMemoryTicker({
    summaryManager,
    configPath: path.join(tmpDir, "config.yaml"),
    factStore: {},
    getResolvedMemoryModel: () => ({ model: "test-model", provider: "test", api: "openai-completions", api_key: "test-key", base_url: "http://localhost:1234" }),
    getMemoryMasterEnabled: () => true,
    isSessionMemoryEnabled,
    getSessionMemoryEnabledFrom,
    onCompiled: vi.fn(),
    sessionDir: path.join(tmpDir, "sessions"),
    memoryMdPath: path.join(tmpDir, "memory.md"),
    todayMdPath: path.join(tmpDir, "today.md"),
    weekMdPath: path.join(tmpDir, "week.md"),
    longtermMdPath: path.join(tmpDir, "longterm.md"),
    factsMdPath: path.join(tmpDir, "facts.md"),
  });

  return { ticker, summaryManager };
}

describe("memory ticker respects session-level memory toggle", () => {
  let tmpDir;
  let sessionPath;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codia-memory-toggle-"));
    fs.mkdirSync(path.join(tmpDir, "sessions"), { recursive: true });
    sessionPath = path.join(tmpDir, "sessions", "2026-03-12T15-47-53-568Z_test.jsonl");
    writeSession(sessionPath);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("skips summary + compile when the session memory is disabled", async () => {
    const { ticker, summaryManager } = makeTicker(tmpDir, () => false);

    ticker.notifyTurn(sessionPath);
    await ticker.notifySessionEnd(sessionPath);

    expect(summaryManager.rollingSummary).not.toHaveBeenCalled();
    expect(compileToday).not.toHaveBeenCalled();
    expect(assemble).not.toHaveBeenCalled();
  });

  it("still summarizes the session when the session memory is enabled", async () => {
    const { ticker, summaryManager } = makeTicker(tmpDir, () => true);

    ticker.notifyTurn(sessionPath);
    await ticker.notifySessionEnd(sessionPath);

    expect(summaryManager.rollingSummary).toHaveBeenCalledOnce();
    expect(compileToday).toHaveBeenCalled();
    expect(assemble).toHaveBeenCalled();
  });

  it("does not run daily maintenance from a foreground turn", async () => {
    const { ticker } = makeTicker(tmpDir, () => true);

    ticker.notifyTurn(sessionPath);
    await ticker.stop();

    expect(compileWeek).not.toHaveBeenCalled();
    expect(compileLongterm).not.toHaveBeenCalled();
    expect(compileFacts).not.toHaveBeenCalled();
    expect(processDirtySessions).not.toHaveBeenCalled();
  });

  it("startup recovery includes bridge owner sessions in the memory ticker", async () => {
    const bridgeSessionPath = path.join(tmpDir, "sessions", "bridge", "owner", "tg-owner.jsonl");
    fs.mkdirSync(path.dirname(bridgeSessionPath), { recursive: true });
    writeSession(bridgeSessionPath);
    const { ticker, summaryManager } = makeTicker(tmpDir, () => true);

    await ticker.tick();

    expect(summaryManager.rollingSummary).toHaveBeenCalledWith(
      "tg-owner",
      expect.arrayContaining([
        expect.objectContaining({ content: "hello" }),
        expect.objectContaining({ content: "world" }),
      ]),
      expect.any(Object),
      expect.any(Object),
    );
  });

  it("flushes one session summary and compiles memory immediately for external compaction", async () => {
    const { ticker, summaryManager } = makeTicker(tmpDir, () => true);

    await ticker.flushSessionAndCompile(sessionPath);

    expect(summaryManager.rollingSummary).toHaveBeenCalledOnce();
    expect(compileToday).toHaveBeenCalled();
    expect(assemble).toHaveBeenCalled();
  });

  it("excludes messages from the disabled period after memory is re-enabled", async () => {
    const lines = [
      {
        type: "message",
        timestamp: "2026-03-12T15:47:53.000Z",
        message: { role: "user", content: "before-disabled" },
      },
      {
        type: "message",
        timestamp: "2026-03-12T15:48:04.000Z",
        message: { role: "assistant", content: "before-disabled-reply" },
      },
      {
        type: "message",
        timestamp: "2026-03-12T16:00:01.000Z",
        message: { role: "user", content: "after-reenabled" },
      },
      {
        type: "message",
        timestamp: "2026-03-12T16:00:08.000Z",
        message: { role: "assistant", content: "after-reenabled-reply" },
      },
    ];
    fs.writeFileSync(sessionPath, lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf-8");

    const { ticker, summaryManager } = makeTicker(
      tmpDir,
      () => true,
      () => "2026-03-12T16:00:00.000Z",
    );

    ticker.notifyTurn(sessionPath);
    await ticker.notifySessionEnd(sessionPath);

    expect(summaryManager.rollingSummary).toHaveBeenCalledOnce();
    const [, summarizedMessages] = summaryManager.rollingSummary.mock.calls[0];
    expect(summarizedMessages.map((m) => m.content)).toEqual([
      "after-reenabled",
      "after-reenabled-reply",
    ]);
  });
});
