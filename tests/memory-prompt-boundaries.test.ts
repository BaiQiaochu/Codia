import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

vi.mock("../lib/i18n.js", () => ({
  getLocale: () => "zh-CN",
}));

vi.mock("../core/llm-client.js", () => ({
  callText: vi.fn().mockResolvedValue("[]"),
}));

import { callText } from "../core/llm-client.ts";
import { SessionSummaryManager } from "../lib/memory/session-summary.ts";
import { compileToday, compileWeek, compileLongterm } from "../lib/memory/compile.ts";
import { processDirtySessions } from "../lib/memory/deep-memory.ts";

const RESOLVED_MODEL = {
  model: "m",
  api: "openai-completions",
  api_key: "k",
  base_url: "http://x",
};

function makeFakeSummaryManager(summaries) {
  return {
    getSummariesInRange: vi.fn().mockReturnValue(summaries),
  };
}

describe("memory prompt boundaries", () => {
  let tmpDir;

  beforeEach(() => {
    vi.clearAllMocks();
    (callText as any).mockResolvedValue("[]");
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-memory-prompts-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("session summary uses the agent reflection frame and keeps work only at theme level", async () => {
    const manager = new SessionSummaryManager(path.join(tmpDir, "summaries"));

    await manager._callRollingLLM("【用户】我最近在关注记忆系统。", "", RESOLVED_MODEL, 2, {
      memoryReflectionSnapshot: {
        agentName: "G-SAP",
        userName: "测试用户",
        identityAndPersonality: "G-SAP 的人格设定。",
        userProfile: "测试用户的主人设定。",
        existingMemory: "已有长期记忆。",
        roster: "同处于这个系统里的别的 Agent：Butter。",
      },
    });

    const prompt = (callText as any).mock.calls[0][0].systemPrompt;
    expect(prompt).toContain("你是 G-SAP");
    expect(prompt).toContain("从自己的视角审视本次对话");
    expect(prompt).toContain("这是你在本次对话开始前已经拥有的记忆");
    expect(prompt).toContain("工作相关内容只允许保留到大主题层级");
    expect(prompt).toContain("如果这条信息回答的是“和用户工作时该怎么做”");
    expect(prompt).toContain("如果这条信息回答的是“用户最近在关注哪个领域/项目/主题”");
  });

  it("adds a reasoning buffer to rolling summary maxTokens without changing visible budget text", async () => {
    const manager = new SessionSummaryManager(path.join(tmpDir, "summaries"));
    const reasoningModel = {
      ...RESOLVED_MODEL,
      model: { id: "reasoning-model", provider: "deepseek", reasoning: true, maxTokens: 8192 },
    };

    await manager._callRollingLLM("【用户】我最近在关注记忆系统。", "", reasoningModel, 2);

    const request = (callText as any).mock.calls[0][0];
    expect(request.messages[0].content).toContain("重要事实最多24字。事情经过最多56字。");
    expect(request.maxTokens).toBeGreaterThan(150);
  });

  it("today and week prompts keep broad work themes but reject work details", async () => {
    const summaries = [
      {
        session_id: "s1",
        updated_at: new Date().toISOString(),
        summary: "## 重要事实\n无\n\n## 事情经过\n用户在讨论记忆系统。",
      },
    ];
    const manager = makeFakeSummaryManager(summaries);

    await compileToday(manager, path.join(tmpDir, "today.md"), RESOLVED_MODEL);
    await compileWeek(manager, path.join(tmpDir, "week.md"), RESOLVED_MODEL);

    const todayPrompt = (callText as any).mock.calls[0][0].systemPrompt;
    const weekPrompt = (callText as any).mock.calls[1][0].systemPrompt;
    for (const prompt of [todayPrompt, weekPrompt]) {
      expect(prompt).toContain("工作相关内容只允许保留到大主题层级");
      expect(prompt).toContain("领域/项目/主题");
      expect(prompt).toContain("不要记录执行步骤、文件名、工具、命令、检查顺序、协作偏好、工作细节");
      expect(prompt).toContain("不要输出 Markdown 标题");
    }
  });

  it("adds a reasoning buffer to compile maxTokens while keeping compile prompt body budget", async () => {
    const summaries = [
      {
        session_id: "s1",
        updated_at: new Date().toISOString(),
        summary: "## 重要事实\n无\n\n## 事情经过\n用户在讨论记忆系统。",
      },
    ];
    const manager = makeFakeSummaryManager(summaries);
    const reasoningModel = {
      ...RESOLVED_MODEL,
      model: { id: "reasoning-model", provider: "deepseek", reasoning: true, maxTokens: 8192 },
    };

    await compileToday(manager, path.join(tmpDir, "today.md"), reasoningModel);

    const request = (callText as any).mock.calls[0][0];
    expect(request.systemPrompt).toContain("最多 300 字");
    expect(request.maxTokens).toBeGreaterThan(450);
  });

  it("longterm prompt keeps durable user profile instead of work patterns", async () => {
    const weekPath = path.join(tmpDir, "week.md");
    const longtermPath = path.join(tmpDir, "longterm.md");
    fs.writeFileSync(weekPath, "用户最近在关注记忆系统。", "utf-8");

    await compileLongterm(weekPath, longtermPath, RESOLVED_MODEL);

    const prompt = (callText as any).mock.calls[0][0].systemPrompt;
    expect(prompt).toContain("记忆不是工作日志");
    expect(prompt).toContain("用户画像");
    expect(prompt).toContain("长期关注方向");
    expect(prompt).toContain("不要输出 Markdown 标题");
    expect(prompt).not.toContain("工作模式");
  });

  it("deep memory only extracts profile and coarse current-interest facts", async () => {
    const summaryManager = {
      getDirtySessions: vi.fn().mockReturnValue([
        {
          session_id: "s1",
          summary: "## 重要事实\n无\n\n## 事情经过\n用户在讨论记忆系统。",
          snapshot: "",
          updated_at: new Date().toISOString(),
        },
      ]),
      markProcessed: vi.fn(),
    };
    const factStore = { addBatch: vi.fn() };

    await processDirtySessions(summaryManager, factStore, RESOLVED_MODEL);

    const prompt = (callText as any).mock.calls[0][0].systemPrompt;
    expect(prompt).toContain("只提取用户画像和粗颗粒近况");
    expect(prompt).toContain("禁止提取工作方式偏好");
    expect(prompt).toContain("如果一条事实描述的是“以后遇到类似任务应该怎么做”");
    expect(prompt).not.toContain("3月15日");
  });

  it("corrects example-anchored fact dates when a legacy summary has a single source day", async () => {
    (callText as any).mockResolvedValue(JSON.stringify([
      {
        fact: "用户最近在关注记忆系统",
        tags: ["记忆系统", "近况"],
        time: "2026-03-15T14:30",
      },
    ]));
    const summaryManager = {
      getDirtySessions: vi.fn().mockReturnValue([
        {
          session_id: "single-day-session",
          summary: "### 重要事实\n- 用户最近在关注记忆系统\n\n### 事情经过\n- [14:30] 用户讨论记忆系统。",
          snapshot: "",
          updated_at: "2026-05-16T07:00:00.000Z",
          source_time_range: {
            start: "2026-05-16T06:30:00.000Z",
            end: "2026-05-16T07:00:00.000Z",
            timezone: "Asia/Shanghai",
            localDates: ["2026-05-16"],
          },
        },
      ]),
      markProcessed: vi.fn(),
    };
    const factStore = { addBatch: vi.fn() };

    await processDirtySessions(summaryManager, factStore, RESOLVED_MODEL, { timeZone: "Asia/Shanghai" });

    expect(factStore.addBatch).toHaveBeenCalledWith([
      {
        fact: "用户最近在关注记忆系统",
        tags: ["记忆系统", "近况"],
        time: "2026-05-16T14:30",
        session_id: "single-day-session",
      },
    ]);
  });

  it("nulls legacy HH:mm fact dates for cross-day summaries instead of guessing one date", async () => {
    (callText as any).mockResolvedValue(JSON.stringify([
      {
        fact: "用户最近在关注记忆系统",
        tags: ["记忆系统", "近况"],
        time: "2026-03-15T23:50",
      },
    ]));
    const summaryManager = {
      getDirtySessions: vi.fn().mockReturnValue([
        {
          session_id: "cross-day-session",
          summary: "### 重要事实\n- 用户最近在关注记忆系统\n\n### 事情经过\n- [23:50] 用户开始讨论记忆系统。\n- [00:10] 用户继续讨论记忆系统。",
          snapshot: "",
          updated_at: "2026-05-16T16:20:00.000Z",
          source_time_range: {
            start: "2026-05-16T15:50:00.000Z",
            end: "2026-05-16T16:20:00.000Z",
            timezone: "Asia/Shanghai",
            localDates: ["2026-05-16", "2026-05-17"],
          },
        },
      ]),
      markProcessed: vi.fn(),
    };
    const factStore = { addBatch: vi.fn() };

    await processDirtySessions(summaryManager, factStore, RESOLVED_MODEL, { timeZone: "Asia/Shanghai" });

    expect(factStore.addBatch).toHaveBeenCalledWith([
      {
        fact: "用户最近在关注记忆系统",
        tags: ["记忆系统", "近况"],
        time: null,
        session_id: "cross-day-session",
      },
    ]);
  });

  it("rejects fact times that do not appear in the summary timeline", async () => {
    (callText as any).mockResolvedValue(JSON.stringify([
      {
        fact: "用户最近在关注记忆系统",
        tags: ["记忆系统", "近况"],
        time: "2026-05-16T14:30",
      },
    ]));
    const summaryManager = {
      getDirtySessions: vi.fn().mockReturnValue([
        {
          session_id: "no-time-session",
          summary: "### 重要事实\n- 用户最近在关注记忆系统\n\n### 事情经过\n- 用户讨论记忆系统。",
          snapshot: "",
          updated_at: "2026-05-16T07:00:00.000Z",
          source_time_range: {
            start: "2026-05-16T06:30:00.000Z",
            end: "2026-05-16T07:00:00.000Z",
            timezone: "Asia/Shanghai",
            localDates: ["2026-05-16"],
          },
        },
      ]),
      markProcessed: vi.fn(),
    };
    const factStore = { addBatch: vi.fn() };

    await processDirtySessions(summaryManager, factStore, RESOLVED_MODEL, { timeZone: "Asia/Shanghai" });

    expect(factStore.addBatch).toHaveBeenCalledWith([
      {
        fact: "用户最近在关注记忆系统",
        tags: ["记忆系统", "近况"],
        time: null,
        session_id: "no-time-session",
      },
    ]);
  });

  it("does not trust full summary dates outside the source session range", async () => {
    (callText as any).mockResolvedValue(JSON.stringify([
      {
        fact: "用户最近在关注记忆系统",
        tags: ["记忆系统", "近况"],
        time: "2026-03-15T23:50",
      },
    ]));
    const summaryManager = {
      getDirtySessions: vi.fn().mockReturnValue([
        {
          session_id: "cross-day-hallucinated-date",
          summary: "### 重要事实\n- 用户最近在关注记忆系统\n\n### 事情经过\n- [2026-03-15 23:50] 用户开始讨论记忆系统。",
          snapshot: "",
          updated_at: "2026-05-16T16:20:00.000Z",
          source_time_range: {
            start: "2026-05-16T15:50:00.000Z",
            end: "2026-05-16T16:20:00.000Z",
            timezone: "Asia/Shanghai",
            localDates: ["2026-05-16", "2026-05-17"],
          },
        },
      ]),
      markProcessed: vi.fn(),
    };
    const factStore = { addBatch: vi.fn() };

    await processDirtySessions(summaryManager, factStore, RESOLVED_MODEL, { timeZone: "Asia/Shanghai" });

    expect(factStore.addBatch).toHaveBeenCalledWith([
      {
        fact: "用户最近在关注记忆系统",
        tags: ["记忆系统", "近况"],
        time: null,
        session_id: "cross-day-hallucinated-date",
      },
    ]);
  });

  it("uses caller-provided source time ranges for old summaries without persisted time metadata", async () => {
    (callText as any).mockResolvedValue(JSON.stringify([
      {
        fact: "用户最近在关注记忆系统",
        tags: ["记忆系统", "近况"],
        time: "2026-03-15T00:10",
      },
    ]));
    const summaryManager = {
      getDirtySessions: vi.fn().mockReturnValue([
        {
          session_id: "old-cross-day-session",
          summary: "### 重要事实\n- 用户最近在关注记忆系统\n\n### 事情经过\n- [23:50] 用户开始讨论记忆系统。\n- [00:10] 用户继续讨论记忆系统。",
          snapshot: "",
          updated_at: "2026-05-16T16:20:00.000Z",
        },
      ]),
      markProcessed: vi.fn(),
    };
    const factStore = { addBatch: vi.fn() };
    const getSourceTimeRange = vi.fn(() => ({
      start: "2026-05-16T15:50:00.000Z",
      end: "2026-05-16T16:20:00.000Z",
      timezone: "Asia/Shanghai",
      localDates: ["2026-05-16", "2026-05-17"],
    }));

    await processDirtySessions(summaryManager, factStore, RESOLVED_MODEL, {
      timeZone: "Asia/Shanghai",
      getSourceTimeRange,
    });

    expect(getSourceTimeRange).toHaveBeenCalledWith("old-cross-day-session");
    expect(factStore.addBatch).toHaveBeenCalledWith([
      {
        fact: "用户最近在关注记忆系统",
        tags: ["记忆系统", "近况"],
        time: null,
        session_id: "old-cross-day-session",
      },
    ]);
  });
});
