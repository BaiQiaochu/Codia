// @ts-nocheck
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/i18n.js", () => ({
  getLocale: () => "en-US",
  t: (key) => key,
}));

vi.mock("../core/llm-client.js", () => ({
  callText: vi.fn(),
}));

vi.mock("../lib/pii-guard.js", () => ({
  scrubPII: (text) => ({ cleaned: text, detected: [] }),
}));

vi.mock("../lib/pi-sdk/index.js", () => ({
  generateSummary: vi.fn(),
}));

import { callText } from "../core/llm-client.js";
import { writeDiary } from "../lib/diary/diary-writer.js";

let tempRoot;

function writeSession(sessionDir, sessionId, messages) {
  const filePath = path.join(sessionDir, `${sessionId}.jsonl`);
  const lines = [
    { type: "session", id: sessionId, timestamp: "2026-05-07T03:59:00+08:00", cwd: tempRoot },
    ...messages.map((message, index) => ({
      type: "message",
      id: `${sessionId}-${index}`,
      parentId: index === 0 ? null : `${sessionId}-${index - 1}`,
      timestamp: message.timestamp,
      message: {
        role: message.role,
        content: message.content,
      },
    })),
  ];
  fs.writeFileSync(filePath, lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf-8");
  return filePath;
}

function createBaseOptions(overrides = {}) {
  const sessionDir = path.join(tempRoot, "sessions");
  fs.mkdirSync(sessionDir, { recursive: true });

  const summaryManager = {
    getSummariesInRange: vi.fn().mockReturnValue([]),
    getSummary: vi.fn().mockReturnValue(null),
    rollingSummary: vi.fn(),
  };

  return {
    summaryManager,
    sessionDir,
    resolvedModel: {
      model: { id: "test-model", provider: "test-provider" },
      api: "openai-completions",
      api_key: "test-key",
      base_url: "http://localhost:1234",
    },
    agentPersonality: "You are a private diary writer.",
    memory: "",
    userName: "Tester",
    agentName: "Nova",
    cwd: tempRoot,
    isSessionMemoryEnabledForPath: vi.fn().mockReturnValue(true),
    generateTemporarySummary: vi.fn(),
    ...overrides,
  };
}

function latestDiaryPrompt() {
  return callText.mock.calls.at(-1)[0].messages[0].content;
}

describe("writeDiary hybrid material collection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-07T12:00:00+08:00"));
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-diary-test-"));
    callText.mockResolvedValue("# 2026-05-07 Test diary\n\nToday had enough material.");
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it("backfills a missing memory-enabled session summary before writing the diary", async () => {
    const opts = createBaseOptions();
    writeSession(opts.sessionDir, "enabled-session", [
      { role: "user", content: "Please make the diary use session material.", timestamp: "2026-05-07T04:10:00+08:00" },
      { role: "assistant", content: "I will backfill the missing summary.", timestamp: "2026-05-07T04:12:00+08:00" },
    ]);
    opts.summaryManager.rollingSummary.mockResolvedValue("Backfilled summary for the diary.");

    const result = await writeDiary(opts);

    expect(result.error).toBeUndefined();
    expect(opts.summaryManager.rollingSummary).toHaveBeenCalledWith(
      "enabled-session",
      expect.arrayContaining([
        expect.objectContaining({ role: "user", content: "Please make the diary use session material." }),
      ]),
      opts.resolvedModel,
    );
    expect(opts.generateTemporarySummary).not.toHaveBeenCalled();
    expect(latestDiaryPrompt()).toContain("Backfilled summary for the diary.");
  });

  it("writes new diary files under BYOUNG-Works and ignores legacy diary folders", async () => {
    const opts = createBaseOptions();
    fs.mkdirSync(path.join(tempRoot, "diary"), { recursive: true });
    writeSession(opts.sessionDir, "workspace-output-session", [
      { role: "user", content: "Put new diary files under the unified workspace output folder.", timestamp: "2026-05-07T04:10:00+08:00" },
      { role: "assistant", content: "I will write new diary files into BYOUNG-Works.", timestamp: "2026-05-07T04:12:00+08:00" },
    ]);
    opts.summaryManager.rollingSummary.mockResolvedValue("Workspace output belongs under BYOUNG-Works.");

    const result = await writeDiary(opts);

    expect(result.error).toBeUndefined();
    expect(result.filePath).toContain(path.join("BYOUNG-Works", "Diary"));
    expect(result.filePath).not.toContain(path.join(tempRoot, "diary"));
    expect(fs.readdirSync(path.join(tempRoot, "diary"))).toEqual([]);
    expect(fs.existsSync(result.filePath)).toBe(true);
  });

  it("uses temporary material for a memory-disabled session without saving a summary", async () => {
    const opts = createBaseOptions({
      isSessionMemoryEnabledForPath: vi.fn().mockReturnValue(false),
      generateTemporarySummary: vi.fn().mockResolvedValue("Temporary memory-off material for this diary only."),
    });
    writeSession(opts.sessionDir, "memory-off-session", [
      { role: "user", content: "This session has memory disabled.", timestamp: "2026-05-07T05:10:00+08:00" },
      { role: "assistant", content: "Then only use temporary compaction.", timestamp: "2026-05-07T05:12:00+08:00" },
    ]);

    const result = await writeDiary(opts);

    expect(result.error).toBeUndefined();
    expect(opts.summaryManager.rollingSummary).not.toHaveBeenCalled();
    expect(opts.generateTemporarySummary).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "memory-off-session",
      previousSummary: "",
      reason: "memory-off",
    }));
    expect(latestDiaryPrompt()).toContain("Temporary memory-off material");
  });

  it("keeps an existing stale summary and adds a temporary supplement", async () => {
    const staleSummary = {
      session_id: "stale-session",
      created_at: "2026-05-07T04:11:00+08:00",
      updated_at: "2026-05-07T04:11:00+08:00",
      messageCount: 1,
      summary: "Existing early summary.",
    };
    const opts = createBaseOptions({
      summaryManager: {
        getSummariesInRange: vi.fn().mockReturnValue([staleSummary]),
        getSummary: vi.fn().mockReturnValue(staleSummary),
        rollingSummary: vi.fn(),
      },
      generateTemporarySummary: vi.fn().mockResolvedValue("Temporary supplement for newer messages."),
    });
    writeSession(opts.sessionDir, "stale-session", [
      { role: "user", content: "Initial diary topic.", timestamp: "2026-05-07T04:10:00+08:00" },
      { role: "assistant", content: "I captured the first part.", timestamp: "2026-05-07T04:11:00+08:00" },
      { role: "user", content: "A later detail needs a temporary supplement.", timestamp: "2026-05-07T04:20:00+08:00" },
    ]);

    const result = await writeDiary(opts);

    expect(result.error).toBeUndefined();
    expect(opts.summaryManager.rollingSummary).not.toHaveBeenCalled();
    expect(opts.generateTemporarySummary).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "stale-session",
      previousSummary: staleSummary.summary,
      reason: "stale-summary",
    }));
    expect(latestDiaryPrompt()).toContain("Existing early summary.");
    expect(latestDiaryPrompt()).toContain("Temporary supplement for newer messages.");
  });
});
