import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loggers = vi.hoisted(() => new Map<string, any>());

vi.mock("../lib/i18n.ts", () => ({
  getLocale: () => "zh-CN",
}));

vi.mock("../core/llm-client.ts", () => ({
  callText: vi.fn(),
}));

vi.mock("../lib/debug-log.ts", () => ({
  debugLog: () => null,
  initDebugLog: vi.fn(),
  createModuleLogger: (name: string) => {
    if (!loggers.has(name)) {
      loggers.set(name, { log: vi.fn(), warn: vi.fn(), error: vi.fn() });
    }
    return loggers.get(name);
  },
}));

import { callText } from "../core/llm-client.ts";
import { buildSessionCacheSnapshot } from "../core/session-cache-snapshot.ts";
import { compileFacts } from "../lib/memory/compile.ts";
import {
  buildMemoryReflectionSuffix,
  runMemoryReflection,
} from "../lib/memory/memory-reflection-runner.ts";
import {
  MAX_ROLLING_SUMMARY_FORMAT_REPAIRS,
  buildRollingSummaryFormatRequirements,
  buildRollingSummaryRepairInput,
  buildRollingSummaryRepairPrompt,
  extractFactSection,
  hasFactSectionHeading,
  isEmptyFactSection,
  validateRollingSummaryFormat,
} from "../lib/memory/rolling-summary-format.ts";
import { SessionSummaryManager } from "../lib/memory/session-summary.ts";

const VALID_ZH_SUMMARY = "### 重要事实\n- 用户长期关注记忆系统\n\n### 事情经过\n- [2026-06-03 10:00] 用户调试缓存快照。";
const VALID_EN_SUMMARY = "### Key Facts\n- The user cares about memory systems\n\n### Timeline\n- [2026-06-03 10:00] The user tuned cache snapshots.";
const FREE_FORM_SUMMARY = "用户今天聊了记忆系统的缓存快照，整体进展顺利。";

const RESOLVED_MODEL = { model: "m", api: "openai-completions", api_key: "k", base_url: "http://x" };

describe("rolling summary format helpers", () => {
  it("validates the canonical two-section contract", () => {
    expect(validateRollingSummaryFormat(VALID_ZH_SUMMARY)).toEqual({ ok: true, issues: [] });
    expect(validateRollingSummaryFormat(VALID_EN_SUMMARY)).toEqual({ ok: true, issues: [] });
    expect(validateRollingSummaryFormat(FREE_FORM_SUMMARY).ok).toBe(false);
    expect(MAX_ROLLING_SUMMARY_FORMAT_REPAIRS).toBeGreaterThanOrEqual(1);
    expect(MAX_ROLLING_SUMMARY_FORMAT_REPAIRS).toBeLessThanOrEqual(2);
  });

  it("shares the same format requirements across prompt paths", () => {
    const requirements = buildRollingSummaryFormatRequirements("zh-CN");
    expect(requirements).toContain("### 重要事实");
    expect(requirements).toContain("### 事情经过");
    expect(buildMemoryReflectionSuffix({ previousSummary: "", timeZone: "Asia/Shanghai", locale: "zh-CN" }).content[0].text)
      .toContain(requirements);
  });

  it("builds repair prompts and fact extraction from one contract", () => {
    const input = buildRollingSummaryRepairInput({
      locale: "zh-CN",
      issues: ["missing fact section heading"],
      summaryText: FREE_FORM_SUMMARY,
    });

    expect(buildRollingSummaryRepairPrompt("zh-CN")).toContain("### 重要事实");
    expect(input).toContain("missing fact section heading");
    expect(input).toContain(FREE_FORM_SUMMARY);
    expect(hasFactSectionHeading(VALID_ZH_SUMMARY)).toBe(true);
    expect(hasFactSectionHeading(FREE_FORM_SUMMARY)).toBe(false);
    expect(extractFactSection(VALID_ZH_SUMMARY)).toBe("- 用户长期关注记忆系统");
    expect(isEmptyFactSection("- 无")).toBe(true);
    expect(isEmptyFactSection("- None")).toBe(true);
  });
});

describe("SessionSummaryManager rolling summary format repair", () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-rolling-format-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("repairs a format-violating draft before saving", async () => {
    (callText as any)
      .mockResolvedValueOnce(FREE_FORM_SUMMARY)
      .mockResolvedValueOnce(VALID_ZH_SUMMARY);
    const manager = new SessionSummaryManager(tmpDir);

    const summary = await manager.rollingSummary(
      "s1",
      [{ role: "user", content: "聊聊记忆系统。", timestamp: "2026-06-03T10:00:00.000Z" }],
      RESOLVED_MODEL,
    );

    expect(summary).toBe(VALID_ZH_SUMMARY);
    expect(manager.getSummary("s1")?.summary).toBe(VALID_ZH_SUMMARY);
    expect(callText).toHaveBeenCalledTimes(2);
    expect((callText as any).mock.calls[1][0].usageContext.source.operation).toBe("rolling_summary_repair");
  });

  it("throws after the repair budget and keeps the previous summary", async () => {
    const manager = new SessionSummaryManager(tmpDir);
    manager.saveSummary("s1", {
      session_id: "s1",
      created_at: "2026-06-03T09:00:00.000Z",
      updated_at: "2026-06-03T09:00:00.000Z",
      summary: VALID_ZH_SUMMARY,
      messageCount: 0,
    });
    (callText as any).mockResolvedValue(FREE_FORM_SUMMARY);

    await expect(manager.rollingSummary(
      "s1",
      [{ role: "user", content: "聊聊记忆系统。", timestamp: "2026-06-03T10:00:00.000Z" }],
      RESOLVED_MODEL,
    )).rejects.toThrow(/rolling summary format/i);

    expect(callText).toHaveBeenCalledTimes(1 + MAX_ROLLING_SUMMARY_FORMAT_REPAIRS);
    expect(manager.getSummary("s1")?.summary).toBe(VALID_ZH_SUMMARY);
  });
});

describe("runMemoryReflection rolling summary format repair", () => {
  function makeReflectionFixture(responses: string[]) {
    const model = {
      id: "memory-model",
      provider: "deepseek",
      api: "openai-completions",
      baseUrl: "http://localhost:1234",
    };
    const messages = [
      { role: "user", content: "我们聊聊记忆系统。", timestamp: "2026-06-03T10:00:00.000Z" },
    ];
    const snapshot = buildSessionCacheSnapshot({
      sessionPath: "/tmp/sessions/s1.jsonl",
      reason: "memory.reflection",
      model,
      cacheKeyParams: {},
      systemPrompt: "You are G-SAP.",
      tools: [],
      messages,
    });
    const calls: any[] = [];
    const streamFn = vi.fn(async (_model, context) => {
      calls.push(context);
      const text = responses[Math.min(calls.length - 1, responses.length - 1)];
      return {
        result: async () => ({
          content: [{ type: "text", text }],
          stopReason: "stop",
          usage: { input_tokens: 10, output_tokens: 10 },
        }),
      };
    });
    return { snapshot, model, messages, streamFn, calls };
  }

  it("repairs a format-violating reflection output", async () => {
    const { snapshot, model, messages, streamFn, calls } = makeReflectionFixture([
      FREE_FORM_SUMMARY,
      VALID_ZH_SUMMARY,
    ]);

    const result = await runMemoryReflection({
      snapshot,
      model,
      cacheKeyParams: {},
      previousSummary: "",
      sessionId: "s1",
      messages,
      timeZone: "Asia/Shanghai",
      streamFn,
    });

    expect(streamFn).toHaveBeenCalledTimes(2);
    expect(result.summary).toBe(VALID_ZH_SUMMARY);
    expect(calls[1].messages.at(-1).content[0].text).toContain(FREE_FORM_SUMMARY);
  });
});

describe("compileFacts legacy free-form summary compatibility", () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    for (const logger of loggers.values()) {
      logger.warn.mockClear();
    }
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-compile-legacy-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("skips free-form summaries explicitly and preserves previous facts", async () => {
    const factsPath = path.join(tmpDir, "facts.md");
    fs.writeFileSync(factsPath, "用户喜欢清晰边界。", "utf-8");
    const manager = {
      getSummariesInRange: vi.fn().mockReturnValue([
        { session_id: "legacy-1", updated_at: "2026-06-03T10:00:00.000Z", summary: FREE_FORM_SUMMARY },
      ]),
    };

    await compileFacts(manager, factsPath, RESOLVED_MODEL);

    expect(callText).not.toHaveBeenCalled();
    expect(fs.readFileSync(factsPath, "utf-8")).toBe("用户喜欢清晰边界。");
    const warnCalls = [...loggers.values()].flatMap((logger) => logger.warn.mock.calls.map((call: any[]) => String(call[0])));
    expect(warnCalls.some((line) => line.includes("legacy-1"))).toBe(true);
  });
});
