// @ts-nocheck
import fs from "fs";
import os from "os";
import path from "path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../lib/i18n.js", () => ({
  getLocale: () => "zh-CN",
  t: (key) => key,
}));

vi.mock("../core/llm-client.js", () => ({
  callText: vi.fn(),
}));

vi.mock("../lib/pii-guard.js", () => ({
  scrubPII: (text) => ({ cleaned: text, detected: [] }),
}));

import { callText } from "../core/llm-client.ts";
import { writeDiary } from "../lib/diary/diary-writer.ts";

let tempRoot;

function makeSession(sessionDir, sessionId, messages) {
  const filePath = path.join(sessionDir, `${sessionId}.jsonl`);
  const lines = [
    { type: "session", id: sessionId, timestamp: "2026-05-07T03:59:00.000Z", cwd: tempRoot },
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

function baseOpts( overrides: any = {}) {
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
    agentPersonality: "你是 Codia。",
    memory: "",
    userName: "测试用户",
    agentName: "小花",
    cwd: tempRoot,
    isSessionMemoryEnabledForPath: vi.fn().mockReturnValue(true),
    generateTemporarySummary: vi.fn(),
    ...overrides,
  };
}

function diaryPrompt() {
  return (callText as any).mock.calls[0][0].messages[0].content;
}

describe("writeDiary hybrid material collection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-07T12:00:00+08:00"));
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codia-diary-test-"));
    (callText as any).mockResolvedValue("# 2026-05-07 测试日记\n\n今天把日记写好了。");
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it("persists a rolling summary for today's missing memory-enabled session before writing diary", async () => {
    const opts = baseOpts();
    makeSession(opts.sessionDir, "enabled-session", [
      { role: "user", content: "今天想把日记链路改成摘要优先。", timestamp: "2026-05-07T04:10:00.000Z" },
      { role: "assistant", content: "我会补齐缺失摘要。", timestamp: "2026-05-07T04:12:00.000Z" },
    ]);
    opts.summaryManager.rollingSummary.mockResolvedValue("## 事情经过\n[12:10] 用户讨论日记链路，助手补齐缺失摘要。");

    const result = await writeDiary(opts);

    expect(result.error).toBeUndefined();
    expect(opts.summaryManager.rollingSummary).toHaveBeenCalledWith(
      "enabled-session",
      expect.arrayContaining([
        expect.objectContaining({ role: "user", content: "今天想把日记链路改成摘要优先。" }),
      ]),
      opts.resolvedModel,
    );
    expect(opts.generateTemporarySummary).not.toHaveBeenCalled();
    expect(diaryPrompt()).toContain("## 事情经过");
    expect(diaryPrompt()).toContain("补齐缺失摘要");
  });

  it("writes new diary files under Codia-Works and ignores legacy diary folders", async () => {
    const opts = baseOpts();
    fs.mkdirSync(path.join(tempRoot, "日记"), { recursive: true });
    makeSession(opts.sessionDir, "workspace-output-session", [
      { role: "user", content: "今天要把工作区产物统一到一个目录。", timestamp: "2026-05-07T04:10:00.000Z" },
      { role: "assistant", content: "我会把新日记写进 Codia-Works。", timestamp: "2026-05-07T04:12:00.000Z" },
    ]);
    opts.summaryManager.rollingSummary.mockResolvedValue("## 事情经过\n[12:10] 工作区产物统一到 Codia-Works。");

    const result = await writeDiary(opts);

    expect(result.error).toBeUndefined();
    expect(result.filePath).toContain(path.join("Codia-Works", "日记"));
    expect(result.filePath).not.toContain(path.join(tempRoot, "日记"));
    expect(fs.readdirSync(path.join(tempRoot, "日记"))).toEqual([]);
    expect(fs.existsSync(result.filePath)).toBe(true);
  });

  it("falls back to temporary compaction when persistent summary backfill fails", async () => {
    const opts = baseOpts({
      generateTemporarySummary: vi.fn().mockResolvedValue("## 临时摘要\n持久摘要失败后，临时材料仍然能支撑今天的日记。"),
    });
    makeSession(opts.sessionDir, "backfill-fails-session", [
      { role: "user", content: "今天写日记时某个 session 摘要补写失败。", timestamp: "2026-05-07T04:10:00.000Z" },
      { role: "assistant", content: "那也不能让整篇日记失败。", timestamp: "2026-05-07T04:12:00.000Z" },
    ]);
    opts.summaryManager.rollingSummary.mockRejectedValue(new Error("simulated summary failure"));

    const result = await writeDiary(opts);

    expect(result.error).toBeUndefined();
    expect(opts.generateTemporarySummary).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "backfill-fails-session",
      previousSummary: "",
      reason: "backfill-failed",
    }));
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sessionId: "backfill-fails-session",
        stage: "rolling-summary",
        message: "simulated summary failure",
      }),
    ]));
    expect(diaryPrompt()).toContain("临时补齐");
    expect(diaryPrompt()).toContain("临时材料仍然能支撑今天的日记");
  });

  it("uses temporary compaction for a memory-disabled session without saving a rolling summary", async () => {
    const opts = baseOpts({
      isSessionMemoryEnabledForPath: vi.fn().mockReturnValue(false),
      generateTemporarySummary: vi.fn().mockResolvedValue("## 临时摘要\n记忆关闭的 session 也参与这次日记，但不会落回摘要库。"),
    });
    makeSession(opts.sessionDir, "memory-off-session", [
      { role: "user", content: "这条 session 关闭了记忆。", timestamp: "2026-05-07T05:10:00.000Z" },
      { role: "assistant", content: "那就只临时压缩给日记用。", timestamp: "2026-05-07T05:12:00.000Z" },
    ]);

    const result = await writeDiary(opts);

    expect(result.error).toBeUndefined();
    expect(opts.summaryManager.rollingSummary).not.toHaveBeenCalled();
    expect(opts.generateTemporarySummary).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "memory-off-session",
      previousSummary: "",
    }));
    expect(diaryPrompt()).toContain("临时补齐");
    expect(diaryPrompt()).toContain("不会落回摘要库");
  });

  it("keeps an in-range stale summary and adds a temporary compaction supplement", async () => {
    const staleSummary = {
      session_id: "stale-session",
      created_at: "2026-05-07T03:00:00.000Z",
      updated_at: "2026-05-07T04:11:00.000Z",
      messageCount: 1,
      summary: "## 事情经过\n[12:10] 用户开始讨论日记链路。",
    };
    const opts = baseOpts({
      summaryManager: {
        getSummariesInRange: vi.fn().mockReturnValue([staleSummary]),
        getSummary: vi.fn().mockReturnValue(staleSummary),
        rollingSummary: vi.fn(),
      },
      generateTemporarySummary: vi.fn().mockResolvedValue("## 临时摘要\n[12:20] 后续决定残缺内容用 compaction 补齐，不要落回 session。"),
    });
    makeSession(opts.sessionDir, "stale-session", [
      { role: "user", content: "今天想把日记链路改成摘要优先。", timestamp: "2026-05-07T04:10:00.000Z" },
      { role: "assistant", content: "我先看摘要。", timestamp: "2026-05-07T04:11:00.000Z" },
      { role: "user", content: "残缺内容用 compaction 补齐，但不要落回 session。", timestamp: "2026-05-07T04:20:00.000Z" },
    ]);

    const result = await writeDiary(opts);

    expect(result.error).toBeUndefined();
    expect(opts.summaryManager.rollingSummary).not.toHaveBeenCalled();
    expect(opts.generateTemporarySummary).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "stale-session",
      previousSummary: staleSummary.summary,
    }));
    expect(diaryPrompt()).toContain("用户开始讨论日记链路");
    expect(diaryPrompt()).toContain("临时补齐");
    expect(diaryPrompt()).toContain("不要落回 session");
  });

  it("keeps a stale summary when its temporary supplement fails", async () => {
    const staleSummary = {
      session_id: "stale-supplement-fails",
      created_at: "2026-05-07T03:00:00.000Z",
      updated_at: "2026-05-07T04:11:00.000Z",
      messageCount: 1,
      summary: "## 事情经过\n[12:10] 用户开始讨论日记链路。",
    };
    const opts = baseOpts({
      summaryManager: {
        getSummariesInRange: vi.fn().mockReturnValue([staleSummary]),
        getSummary: vi.fn().mockReturnValue(staleSummary),
        rollingSummary: vi.fn(),
      },
      generateTemporarySummary: vi.fn().mockRejectedValue(new Error("simulated supplement failure")),
    });
    makeSession(opts.sessionDir, "stale-supplement-fails", [
      { role: "user", content: "今天想把日记链路改成摘要优先。", timestamp: "2026-05-07T04:10:00.000Z" },
      { role: "assistant", content: "我先看摘要。", timestamp: "2026-05-07T04:11:00.000Z" },
      { role: "user", content: "后面这句补齐失败也不能毁掉已有摘要。", timestamp: "2026-05-07T04:20:00.000Z" },
    ]);

    const result = await writeDiary(opts);

    expect(result.error).toBeUndefined();
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sessionId: "stale-supplement-fails",
        stage: "temporary-supplement",
        message: "simulated supplement failure",
      }),
    ]));
    expect(diaryPrompt()).toContain("用户开始讨论日记链路");
    expect(diaryPrompt()).not.toContain("后面这句补齐失败也不能毁掉已有摘要");
  });

  it("returns diagnostics when every matching session fails material collection", async () => {
    const opts = baseOpts({
      generateTemporarySummary: vi.fn().mockRejectedValue(new Error("simulated temporary failure")),
    });
    makeSession(opts.sessionDir, "unusable-session", [
      { role: "user", content: "今天只有一个会话，但摘要和临时压缩都失败了。", timestamp: "2026-05-07T04:10:00.000Z" },
      { role: "assistant", content: "这时应该返回可诊断的错误。", timestamp: "2026-05-07T04:12:00.000Z" },
    ]);
    opts.summaryManager.rollingSummary.mockRejectedValue(new Error("simulated summary failure"));

    const result = await writeDiary(opts);

    expect(result.error).toContain("日记材料准备失败");
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sessionId: "unusable-session",
        stage: "rolling-summary",
        message: "simulated summary failure",
      }),
      expect.objectContaining({
        sessionId: "unusable-session",
        stage: "temporary-summary",
        message: "simulated temporary failure",
      }),
    ]));
    expect(callText).not.toHaveBeenCalled();
  });
});
