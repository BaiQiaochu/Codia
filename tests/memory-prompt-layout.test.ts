import { describe, expect, it } from "vitest";
import { buildUtilityPromptLayout } from "../lib/llm/prompt-layout.ts";
import { buildRollingSummaryPrompt } from "../lib/memory/prompts/rolling-summary.ts";
import {
  buildCompileFactsPrompt,
  buildCompileTodayPrompt,
} from "../lib/memory/prompts/compile.ts";
import { buildFactExtractionPrompt } from "../lib/memory/prompts/fact-extraction.ts";

describe("cache-aware prompt layout", () => {
  it("keeps rolling summary semantic rules in the stable system prompt", () => {
    const prompt = buildRollingSummaryPrompt({
      locale: "zh-CN",
      agentName: "G-SAP",
      userName: "主人",
      identityAndPersonality: "身份",
      userProfile: "用户",
      existingMemory: "记忆",
      roster: "花名册",
    });

    expect(prompt.systemPrompt).toContain("### 重要事实");
    expect(prompt.systemPrompt).toContain("工作方式偏好");
    expect(prompt.systemPrompt).toContain("宁可漏，不可错");
    expect(prompt.templateVersion).toBe("rolling-summary.v1");
  });

  it("puts dynamic input after stable template metadata", () => {
    const layout = buildUtilityPromptLayout({
      cacheGroup: "memory.compile.today",
      templateVersion: "compile-today.v1",
      systemPrompt: "stable rules",
      userContent: "dynamic summaries",
    });

    expect(layout.systemPrompt).toBe("stable rules");
    expect(layout.messages[0]).toEqual({ role: "user", content: "dynamic summaries" });
    expect(layout.usageMetadata.cacheStrategy).toBe("utility_template");
    expect(layout.usageMetadata.cacheGroup).toBe("memory.compile.today");
    expect(layout.usageMetadata.cachePrefixHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("keeps compile and fact extraction semantics", () => {
    expect(buildCompileTodayPrompt("zh-CN").systemPrompt).toContain("最多 300 字");
    expect(buildCompileFactsPrompt("zh-CN").systemPrompt).toContain("200字以内");
    expect(buildFactExtractionPrompt({ locale: "zh-CN", hasPrevious: true }).systemPrompt)
      .toContain("禁止提取工作方式偏好");
  });
});
