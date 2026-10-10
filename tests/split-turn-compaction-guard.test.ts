// @ts-nocheck
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../core/compaction-utils.js", () => ({
  computeHardTruncation: vi.fn(),
  estimatePreparationTokens: vi.fn(),
  truncateTextHeadTail: vi.fn(),
}));

import { createCompactionGuardExtension } from "../lib/extensions/compaction-guard-ext.js";
import {
  computeHardTruncation,
  estimatePreparationTokens,
  truncateTextHeadTail,
} from "../core/compaction-utils.js";

function createMockPi() {
  const handlers = new Map();
  return {
    on: vi.fn((event, handler) => {
      handlers.set(event, handler);
    }),
    trigger(event, ...args) {
      return handlers.get(event)?.(...args);
    },
  };
}

describe("split-turn compaction guard", () => {
  let pi;
  let cacheCompactor;

  beforeEach(() => {
    vi.clearAllMocks();
    pi = createMockPi();
    computeHardTruncation.mockReset();
    estimatePreparationTokens.mockReset();
    truncateTextHeadTail.mockReset();
    cacheCompactor = vi.fn(async ({ preparation }) => ({
      summary: "cache summary",
      firstKeptEntryId: preparation.firstKeptEntryId || "keep",
      tokensBefore: preparation.tokensBefore ?? 100,
      details: { readFiles: [], modifiedFiles: [] },
    }));
    createCompactionGuardExtension({ cacheCompactor })(pi);
  });

  it("registers the SDK extension hooks used by the local guard", () => {
    expect(pi.on).toHaveBeenCalledWith("tool_result", expect.any(Function));
    expect(pi.on).toHaveBeenCalledWith("session_before_compact", expect.any(Function));
  });

  it("truncates oversized tool output before it can inflate session context", async () => {
    truncateTextHeadTail.mockReturnValue({
      text: "HEAD...[omitted]...TAIL",
      truncated: true,
      originalBytes: 200_000,
    });

    const result = await pi.trigger("tool_result", {
      toolName: "read",
      isError: false,
      content: [{ type: "text", text: "x".repeat(200_000) }],
    });

    expect(result).toEqual({
      content: [{ type: "text", text: "HEAD...[omitted]...TAIL" }],
    });
  });

  it("hard-truncates worst-case split-turn compaction before SDK summarization starts", async () => {
    const branch = [
      { type: "message", id: "old", message: { role: "user", content: "old" } },
      { type: "message", id: "keep", message: { role: "user", content: "keep" } },
    ];
    const preparation = {
      firstKeptEntryId: "keep",
      messagesToSummarize: [{ role: "user", content: "short history" }],
      turnPrefixMessages: [{ role: "user", content: "x".repeat(5000) }],
      isSplitTurn: true,
      settings: { keepRecentTokens: 200 },
    };

    estimatePreparationTokens.mockReturnValue(900);
    computeHardTruncation.mockReturnValue({
      summary: "[hard truncated]",
      firstKeptEntryId: "keep",
      tokensBefore: 800,
      details: { reason: "compaction-guard-hard-truncate" },
    });

    const result = await pi.trigger(
      "session_before_compact",
      { preparation, signal: { aborted: false } },
      { model: { contextWindow: 1000 }, sessionManager: { getBranch: () => branch } },
    );

    expect(result).toEqual({
      compaction: {
        summary: "[hard truncated]",
        firstKeptEntryId: "keep",
        tokensBefore: 800,
        details: { reason: "compaction-guard-hard-truncate" },
      },
    });
    expect(computeHardTruncation).toHaveBeenCalledWith(
      branch,
      200,
      expect.objectContaining({ reason: "compaction-guard-hard-truncate" }),
    );
  });

  it("returns cache-preserving compaction when input fits the model window", async () => {
    estimatePreparationTokens.mockReturnValue(100);

    const result = await pi.trigger(
      "session_before_compact",
      {
        preparation: {
          firstKeptEntryId: "keep",
          tokensBefore: 100,
          messagesToSummarize: [{ role: "user", content: "short history" }],
          settings: { keepRecentTokens: 200, reserveTokens: 512 },
        },
        signal: { aborted: false },
      },
      {
        model: { id: "m", provider: "p", contextWindow: 128000 },
        modelRegistry: {
          getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "key", headers: {} })),
        },
        getSystemPrompt: vi.fn(() => "system"),
        sessionManager: {
          getBranch: () => [],
          buildSessionContext: () => ({
            thinkingLevel: "off",
            messages: [{ role: "user", content: [{ type: "text", text: "short history" }], timestamp: 1 }],
          }),
        },
      },
    );

    expect(result).toEqual({
      compaction: {
        summary: "cache summary",
        firstKeptEntryId: "keep",
        tokensBefore: 100,
        details: { readFiles: [], modifiedFiles: [] },
      },
    });
    expect(cacheCompactor).toHaveBeenCalledOnce();
    expect(computeHardTruncation).not.toHaveBeenCalled();
  });

  it("strips inline media from compaction preparation before estimating and snapshotting history", async () => {
    pi = createMockPi();
    const buildSessionCacheSnapshot = vi.fn((sessionPath, { reason, messages } = {}) => ({
      strategy: "session_snapshot",
      strict: true,
      sessionPath,
      reason,
      cachePrefixHash: "a".repeat(64),
      cacheKeyParams: { thinkingLevel: "off" },
      tools: [],
      messages,
      messageCount: Array.isArray(messages) ? messages.length : 0,
    }));
    createCompactionGuardExtension({ cacheCompactor, buildSessionCacheSnapshot })(pi);
    estimatePreparationTokens.mockReturnValue(100);

    const mediaPreparation = {
      firstKeptEntryId: "keep",
      tokensBefore: 100,
      messagesToSummarize: [
        {
          role: "user",
          content: [
            { type: "text", text: "listen to this" },
            { type: "audio", data: "BASE64_AUDIO", mimeType: "audio/wav" },
          ],
          timestamp: 1,
        },
        {
          role: "toolResult",
          toolCallId: "call_screenshot",
          toolName: "browser_screenshot",
          content: [
            { type: "text", text: "Screenshot captured" },
            { type: "image", data: "BASE64_IMAGE", mimeType: "image/png" },
          ],
          timestamp: 2,
        },
      ],
      settings: { keepRecentTokens: 200, reserveTokens: 512 },
    };

    await pi.trigger(
      "session_before_compact",
      { preparation: mediaPreparation, signal: { aborted: false } },
      {
        model: { id: "m", provider: "p", contextWindow: 128000 },
        modelRegistry: {
          getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "key", headers: {} })),
        },
        getSystemPrompt: vi.fn(() => "system"),
        sessionManager: {
          getSessionFile: () => "/sessions/current.jsonl",
          getBranch: () => [],
          buildSessionContext: () => ({ thinkingLevel: "off", messages: [] }),
        },
      },
    );

    const estimatedPreparation = estimatePreparationTokens.mock.calls[0][0];
    expect(JSON.stringify(estimatedPreparation)).not.toContain("BASE64_AUDIO");
    expect(JSON.stringify(estimatedPreparation)).not.toContain("BASE64_IMAGE");
    expect(cacheCompactor.mock.calls[0][0].messages).toEqual(estimatedPreparation.messagesToSummarize);
    expect(buildSessionCacheSnapshot).toHaveBeenCalledWith("/sessions/current.jsonl", expect.objectContaining({
      reason: "compaction.history",
      messages: estimatedPreparation.messagesToSummarize,
    }));
  });

  it("passes only Pi preparation messages to the cache compactor, not the kept tail from live context", async () => {
    pi = createMockPi();
    createCompactionGuardExtension({ cacheCompactor })(pi);
    estimatePreparationTokens.mockReturnValue(100);

    await pi.trigger("context", {
      messages: [
        { role: "user", content: [{ type: "text", text: "old history to summarize" }], timestamp: 1 },
        { role: "assistant", content: [{ type: "text", text: "KEPT_TAIL_SHOULD_NOT_ENTER_SUMMARY" }], timestamp: 2 },
      ],
    });

    await pi.trigger(
      "session_before_compact",
      {
        preparation: {
          firstKeptEntryId: "keep",
          tokensBefore: 100,
          messagesToSummarize: [
            { role: "user", content: [{ type: "text", text: "old history to summarize" }], timestamp: 1 },
          ],
          settings: { keepRecentTokens: 200, reserveTokens: 512 },
        },
        signal: { aborted: false },
      },
      {
        model: { id: "m", provider: "p", contextWindow: 128000 },
        modelRegistry: {
          getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "key", headers: {} })),
        },
        sessionManager: {
          getBranch: () => [],
          buildSessionContext: () => ({ thinkingLevel: "off", messages: [] }),
        },
      },
    );

    const passedMessages = cacheCompactor.mock.calls[0][0].messages;
    expect(passedMessages).toHaveLength(1);
    expect(JSON.stringify(passedMessages)).toContain("old history to summarize");
    expect(JSON.stringify(passedMessages)).not.toContain("KEPT_TAIL_SHOULD_NOT_ENTER_SUMMARY");
  });

  it("uses canonical snapshot cache params for compaction side-task requests", async () => {
    pi = createMockPi();
    const buildSessionCacheSnapshot = vi.fn((sessionPath, { reason, messages } = {}) => ({
      strategy: "session_snapshot",
      strict: true,
      sessionPath,
      reason,
      cachePrefixHash: "b".repeat(64),
      cacheKeyParams: { thinkingLevel: "auto" },
      tools: [],
      messages,
      messageCount: Array.isArray(messages) ? messages.length : 0,
    }));
    createCompactionGuardExtension({ cacheCompactor, buildSessionCacheSnapshot })(pi);
    estimatePreparationTokens.mockReturnValue(100);

    await pi.trigger(
      "session_before_compact",
      {
        preparation: {
          firstKeptEntryId: "keep",
          tokensBefore: 100,
          messagesToSummarize: [{ role: "user", content: "short history" }],
          settings: { keepRecentTokens: 200, reserveTokens: 512 },
        },
        signal: { aborted: false },
      },
      {
        model: {
          id: "deepseek-v4-pro",
          provider: "deepseek",
          api: "openai-completions",
          reasoning: true,
          contextWindow: 128000,
        },
        modelRegistry: {
          getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "key", headers: {} })),
        },
        sessionManager: {
          getSessionFile: () => "/sessions/current.jsonl",
          getBranch: () => [],
          buildSessionContext: () => ({ thinkingLevel: "auto", messages: [] }),
        },
      },
    );

    const call = cacheCompactor.mock.calls[0][0];
    expect(call.cacheKeyParams).toEqual({ thinkingLevel: "medium" });
    expect(call.thinkingLevel).toBe("medium");
    expect(call.streamOptions.onPayload({
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "hello" }],
      reasoning_effort: "auto",
    }, {
      id: "deepseek-v4-pro",
      provider: "deepseek",
      api: "openai-completions",
      reasoning: true,
      contextWindow: 128000,
    })).toMatchObject({
      reasoning_effort: "low",
    });
  });

  it("uses cache recovery when Zhipu thinking tool-call history cannot replay reasoning content", async () => {
    pi = createMockPi();
    createCompactionGuardExtension({ cacheCompactor })(pi);
    estimatePreparationTokens.mockReturnValue(100);
    const glmModel = {
      id: "glm-4.5",
      provider: "zhipu",
      api: "openai-completions",
      reasoning: true,
      contextWindow: 128000,
    };

    const result = await pi.trigger(
      "session_before_compact",
      {
        preparation: {
          firstKeptEntryId: "keep",
          tokensBefore: 100,
          messagesToSummarize: [{
            role: "assistant",
            content: "",
            tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: "{}" } }],
          }],
          settings: { keepRecentTokens: 200, reserveTokens: 512 },
        },
        signal: { aborted: false },
      },
      {
        model: glmModel,
        modelRegistry: {
          getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "key", headers: {} })),
        },
        sessionManager: {
          getBranch: () => [],
          buildSessionContext: () => ({ thinkingLevel: "high", messages: [] }),
        },
      },
    );

    expect(result).toMatchObject({ compaction: expect.any(Object) });
    expect(cacheCompactor).toHaveBeenCalledWith(expect.objectContaining({
      model: glmModel,
      thinkingLevel: "high",
      cacheKeyParams: { thinkingLevel: "high", reasoningReplay: "clear" },
      cacheMetadataOverride: expect.objectContaining({
        cacheStrategy: "cache_recovery",
        strict: false,
        degradeReason: "reasoning_replay_unavailable",
      }),
    }));
    const recoveredPayload = cacheCompactor.mock.calls[0][0].streamOptions.onPayload({
      model: "glm-4.5",
      messages: [{
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: "{}" } }],
      }],
    }, glmModel);
    expect(recoveredPayload.thinking).toEqual({ type: "enabled", clear_thinking: true });
    expect(recoveredPayload.messages[0]).toMatchObject({ content: "" });
    expect(recoveredPayload.messages[0]).not.toHaveProperty("reasoning_content");
  });

  it("falls through to Pi SDK native compaction when pi-compatible mode is selected", async () => {
    pi = createMockPi();
    createCompactionGuardExtension({
      cacheCompactor,
      getCompactionMode: () => "pi_compatible",
    })(pi);
    estimatePreparationTokens.mockReturnValue(100);

    const result = await pi.trigger(
      "session_before_compact",
      {
        preparation: {
          firstKeptEntryId: "keep",
          tokensBefore: 100,
          messagesToSummarize: [{ role: "user", content: "short history" }],
          settings: { keepRecentTokens: 200, reserveTokens: 512 },
        },
        signal: { aborted: false },
      },
      {
        model: { id: "m", provider: "p", contextWindow: 128000 },
        sessionManager: {
          getBranch: () => [],
          buildSessionContext: () => ({ thinkingLevel: "off", messages: [] }),
        },
      },
    );

    expect(result).toBeUndefined();
    expect(cacheCompactor).not.toHaveBeenCalled();
    expect(computeHardTruncation).not.toHaveBeenCalled();
  });
});
