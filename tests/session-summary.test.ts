import { describe, it, expect, vi } from "vitest";
import os from "os";
import fs from "fs";
import path from "path";

vi.mock("../lib/i18n.js", () => ({
  getLocale: () => "zh-CN",
}));

vi.mock("../core/llm-client.js", () => ({
  callText: vi.fn(),
}));

vi.mock("../lib/pii-guard.js", () => ({
  scrubPII: (text) => ({ cleaned: text, detected: [] }),
}));

import { SessionSummaryManager } from "../lib/memory/session-summary.ts";
import { callText } from "../core/llm-client.ts";

describe("SessionSummaryManager._buildConversationText", () => {
  function createManager() {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codia-session-summary-"));
    return {
      manager: new SessionSummaryManager(tmpDir),
      cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
    };
  }

  it("assistant 普通文本全文保留，不再按 300 字截断", () => {
    const { manager, cleanup } = createManager();
    try {
      const longText = "甲".repeat(360);
      const text = manager._buildConversationText([
        {
          role: "assistant",
          content: [{ type: "text", text: longText }],
          timestamp: "2026-04-15T10:00:00.000Z",
        },
      ]);

      expect(text).toContain(`【助手】${longText}`);
      expect(text).not.toContain("长回复已截断");
    } finally {
      cleanup();
    }
  });

  it("assistant 的工具调用只保留简短标题", () => {
    const { manager, cleanup } = createManager();
    try {
      const text = manager._buildConversationText([
        {
          role: "assistant",
          content: [
            { type: "text", text: "我先看看实现。" },
            { type: "tool_use", name: "read", input: { file_path: "/tmp/demo.js" } },
            { type: "tool_use", name: "web_search", input: { query: "notifyTurn" } },
          ],
          timestamp: "2026-04-15T10:00:00.000Z",
        },
      ]);

      expect(text).toContain("【助手】我先看看实现。");
      expect(text).toContain("【助手】读取了 /tmp/demo.js");
      expect(text).toContain("【助手】搜索了 notifyTurn");
      expect(text).not.toContain("tool_use");
    } finally {
      cleanup();
    }
  });

  it("uses full local dates in timeline text so cross-day sessions keep ownership", () => {
    const { manager, cleanup } = createManager();
    try {
      const text = manager._buildConversationText([
        {
          role: "user",
          content: "今晚先看记忆。",
          timestamp: "2026-05-16T15:50:00.000Z",
        },
        {
          role: "assistant",
          content: "继续处理。",
          timestamp: "2026-05-16T16:10:00.000Z",
        },
      ], { timeZone: "Asia/Shanghai" });

      expect(text).toContain("[2026-05-16 23:50] 【用户】今晚先看记忆。");
      expect(text).toContain("[2026-05-17 00:10] 【助手】继续处理。");
    } finally {
      cleanup();
    }
  });
});

describe("SessionSummaryManager.rollingSummary prompt contract", () => {
  function createManager() {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codia-session-summary-"));
    return {
      manager: new SessionSummaryManager(tmpDir),
      cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
    };
  }

  it("asks the model to emit summary fields as third-level headings", async () => {
    (callText as any).mockResolvedValueOnce("### 重要事实\n无\n\n### 事情经过\n[10:00] 用户在讨论记忆系统。");
    const { manager, cleanup } = createManager();
    try {
      await manager.rollingSummary(
        "s1",
        [{ role: "user", content: "我们看一下记忆 rolling。", timestamp: "2026-04-15T10:00:00.000Z" }],
        { model: "m", api: "openai-completions", api_key: "k", base_url: "http://x" },
      );

      const prompt = (callText as any).mock.calls[0][0].systemPrompt;
      expect(prompt).toContain("### 重要事实");
      expect(prompt).toContain("### 事情经过");
      expect(prompt).toContain("直接以 ### 重要事实 开头输出");
      expect(prompt).toContain("两个标题下的正文都必须使用无序列表");
      expect(prompt).toContain("列表项必须以 `- ` 开头");
      expect(prompt).not.toContain("直接以 ## 重要事实 开头输出");
      const formatSection = prompt.slice(
        prompt.indexOf("## 输出格式"),
        prompt.indexOf("## 内容要求"),
      );
      expect(formatSection).not.toContain("只记录用户画像类信息");
      expect(formatSection).not.toContain("按时间顺序记录本 session 发生了什么");
    } finally {
      cleanup();
    }
  });

  it("frames rolling summary as the agent reviewing its own existing memory snapshot", async () => {
    (callText as any).mockResolvedValueOnce("### 重要事实\n- 无\n\n### 事情经过\n- [2026-04-15 10:00] 用户在讨论记忆系统。");
    const { manager, cleanup } = createManager();
    try {
      await manager.rollingSummary(
        "s1",
        [{ role: "user", content: "我们看一下记忆 rolling。", timestamp: "2026-04-15T10:00:00.000Z" }],
        { model: "m", api: "openai-completions", api_key: "k", base_url: "http://x" },
        {
          memoryReflectionSnapshot: {
            version: 1,
            locale: "zh-CN",
            agentName: "Codia",
            userName: "测试用户",
            identityAndPersonality: "我是 Codia，偏文学但工程严谨。",
            userProfile: "用户叫测试用户。",
            existingMemory: "用户长期关注 Project Codia 的记忆系统。",
            roster: "同处于这个系统里的别的 Agent：Butter、Ming。",
          },
        },
      );

      const request = (callText as any).mock.calls.at(-1)[0];
      expect(request.systemPrompt).toContain("你是 Codia");
      expect(request.systemPrompt).toContain("你正在整理自己刚刚经历的一段对话");
      expect(request.systemPrompt).toContain("## 你的身份与人格");
      expect(request.systemPrompt).toContain("我是 Codia，偏文学但工程严谨。");
      expect(request.systemPrompt).toContain("## 主人设定");
      expect(request.systemPrompt).toContain("用户叫测试用户。");
      expect(request.systemPrompt).toContain("## 你已有的长期记忆");
      expect(request.systemPrompt).toContain("这是你在本次对话开始前已经拥有的记忆");
      expect(request.systemPrompt).toContain("不要因为它出现在这里就重复写入");
      expect(request.systemPrompt).toContain("## 花名册");
      expect(request.systemPrompt).toContain("同处于这个系统里的别的 Agent");
      expect(request.messages[0].content).toContain("## 新增对话");
      expect(request.messages[0].content).toContain("## 本次摘要预算");
    } finally {
      cleanup();
    }
  });
});
