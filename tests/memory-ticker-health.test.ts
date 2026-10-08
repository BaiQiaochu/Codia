// @ts-nocheck
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
import { compileFacts } from "../lib/memory/compile.js";

function makeTicker(tmpDir) {
  fs.mkdirSync(path.join(tmpDir, "sessions"), { recursive: true });

  return createMemoryTicker({
    summaryManager: {
      rollingSummary: vi.fn().mockResolvedValue("summary"),
      getSummary: vi.fn().mockReturnValue(null),
      listSummaries: vi.fn().mockReturnValue([]),
    },
    configPath: path.join(tmpDir, "config.yaml"),
    factStore: {},
    getResolvedMemoryModel: () => ({
      model: "test-model",
      provider: "test",
      api: "openai-completions",
      api_key: "test-key",
      base_url: "http://localhost:1234",
    }),
    onCompiled: vi.fn(),
    sessionDir: path.join(tmpDir, "sessions"),
    memoryMdPath: path.join(tmpDir, "memory.md"),
    todayMdPath: path.join(tmpDir, "today.md"),
    weekMdPath: path.join(tmpDir, "week.md"),
    longtermMdPath: path.join(tmpDir, "longterm.md"),
    factsMdPath: path.join(tmpDir, "facts.md"),
  });
}

describe("memory ticker health status", () => {
  let tmpDir;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-memory-health-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("exposes initial health fields for all tracked steps", () => {
    const ticker = makeTicker(tmpDir);
    const status = ticker.getHealthStatus();

    for (const key of ["rollingSummary", "compileToday", "compileWeek", "compileLongterm", "compileFacts", "deepMemory"]) {
      expect(status[key]).toEqual({
        lastSuccessAt: null,
        lastErrorAt: null,
        lastErrorMsg: null,
        failCount: 0,
      });
    }
  });

  it("records successful daily steps after tick", async () => {
    const ticker = makeTicker(tmpDir);

    await ticker.tick();

    const status = ticker.getHealthStatus();
    for (const key of ["compileToday", "compileWeek", "compileLongterm", "compileFacts", "deepMemory"]) {
      expect(status[key].lastSuccessAt).not.toBeNull();
      expect(status[key].lastErrorAt).toBeNull();
      expect(status[key].lastErrorMsg).toBeNull();
      expect(status[key].failCount).toBe(0);
    }
  });

  it("records failure and clears it after the step recovers", async () => {
    compileFacts.mockRejectedValueOnce(new Error("provider timeout"));
    const ticker = makeTicker(tmpDir);

    await ticker.tick();
    expect(ticker.getHealthStatus().compileFacts).toMatchObject({
      lastErrorMsg: "provider timeout",
      failCount: 1,
    });

    await ticker.tick();
    expect(ticker.getHealthStatus().compileFacts).toMatchObject({
      lastErrorAt: null,
      lastErrorMsg: null,
      failCount: 0,
    });
    expect(ticker.getHealthStatus().compileFacts.lastSuccessAt).not.toBeNull();
  });

  it("returns a snapshot instead of mutable internal state", () => {
    const ticker = makeTicker(tmpDir);
    const status = ticker.getHealthStatus();
    status.compileToday.failCount = 99;

    expect(ticker.getHealthStatus().compileToday.failCount).toBe(0);
  });
});
