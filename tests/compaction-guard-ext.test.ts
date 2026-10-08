import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock compaction-utils 以便精准控制 L3 判断和硬截断结果
vi.mock("../core/compaction-utils.js", () => ({
  computeHardTruncation: vi.fn(),
  estimatePreparationTokens: vi.fn(),
  truncateTextHeadTail: vi.fn(),
}));

import { createCompactionGuardExtension } from "../lib/extensions/compaction-guard-ext.ts";
import {
  computeHardTruncation,
  estimatePreparationTokens,
  truncateTextHeadTail,
} from "../core/compaction-utils.ts";

function createMockPi() {
  const handlers: any = {};
  return {
    on: vi.fn((event, handler) => {
      handlers[event] = handler;
    }),
    getThinkingLevel: vi.fn(() => "off"),
    getActiveTools: vi.fn(() => ["read"]),
    getAllTools: vi.fn(() => [{
      name: "read",
      description: "Read files",
      parameters: { type: "object", properties: {} },
    }]),
    trigger(event, ...args) {
      return handlers[event]?.(...args);
    },
    getHandler(event) {
      return handlers[event];
    },
  };
}

describe("CompactionGuardExtension", () => {
  let pi;
  let cacheCompactor;
  let buildSessionCacheSnapshot;

  beforeEach(() => {
    vi.clearAllMocks();
    pi = createMockPi();
    cacheCompactor = vi.fn(async ({ preparation }) => ({
      summary: "cache summary",
      firstKeptEntryId: preparation.firstKeptEntryId || "uuid-42",
      tokensBefore: preparation.tokensBefore ?? 90_000,
      details: { readFiles: [], modifiedFiles: [] },
    }));
    buildSessionCacheSnapshot = vi.fn((sessionPath, { reason, messages } = {}) => ({
      strategy: "session_snapshot",
      strict: true,
      sessionPath,
      reason,
      cachePrefixHash: "a".repeat(64),
      tools: [{
        name: "read",
        description: "Read files",
        parameters: { type: "object" },
      }],
      messages,
      messageCount: Array.isArray(messages) ? messages.length : 0,
    }));
    createCompactionGuardExtension({ cacheCompactor, buildSessionCacheSnapshot })(pi);
  });

  it("registers only tool_result and session_before_compact handlers", () => {
    expect(pi.on).toHaveBeenCalledWith("tool_result", expect.any(Function));
    expect(pi.on).toHaveBeenCalledWith("session_before_compact", expect.any(Function));
    expect(pi.on).not.toHaveBeenCalledWith("context", expect.any(Function));
    expect(pi.on).not.toHaveBeenCalledWith("message_end", expect.any(Function));
  });

  describe("L1: tool_result truncation", () => {
    it("leaves short text unchanged", async () => {
      (truncateTextHeadTail as any).mockReturnValue({ text: "short", truncated: false, originalBytes: 5 });
      const res = await pi.trigger("tool_result", {
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: "short" }],
      });
      expect(res).toBeUndefined();
    });

    it("replaces long text content with truncated version", async () => {
      (truncateTextHeadTail as any).mockReturnValue({
        text: "HEAD...[省略]...TAIL",
        truncated: true,
        originalBytes: 200_000,
      });
      const res = await pi.trigger("tool_result", {
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: "x".repeat(200_000) }],
      });
      expect(res).toEqual({ content: [{ type: "text", text: "HEAD...[省略]...TAIL" }] });
    });

    it("does NOT truncate error results (preserves diagnostic info)", async () => {
      const res = await pi.trigger("tool_result", {
        toolName: "bash",
        isError: true,
        content: [{ type: "text", text: "x".repeat(100_000) }],
      });
      expect(res).toBeUndefined();
      expect(truncateTextHeadTail).not.toHaveBeenCalled();
    });

    it("does NOT touch image blocks", async () => {
      (truncateTextHeadTail as any).mockReturnValue({ text: "", truncated: false, originalBytes: 0 });
      const res = await pi.trigger("tool_result", {
        toolName: "read",
        isError: false,
        content: [{ type: "image", source: { data: "..." } }],
      });
      expect(res).toBeUndefined();
      expect(truncateTextHeadTail).not.toHaveBeenCalled();
    });

    it("mixes truncated text blocks with untouched image blocks", async () => {
      (truncateTextHeadTail as any).mockReturnValueOnce({
        text: "TRUNCATED",
        truncated: true,
        originalBytes: 100_000,
      });
      const res = await pi.trigger("tool_result", {
        toolName: "read",
        isError: false,
        content: [
          { type: "text", text: "x".repeat(100_000) },
          { type: "image", source: { data: "..." } },
        ],
      });
      expect(res).toEqual({
        content: [
          { type: "text", text: "TRUNCATED" },
          { type: "image", source: { data: "..." } },
        ],
      });
    });

    it("swallows hook exceptions and returns undefined (passthrough)", async () => {
      (truncateTextHeadTail as any).mockImplementation(() => {
        throw new Error("boom");
      });
      const res = await pi.trigger("tool_result", {
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: "x".repeat(100_000) }],
      });
      expect(res).toBeUndefined();
    });

    it("returns undefined when content is not an array", async () => {
      const res = await pi.trigger("tool_result", { toolName: "custom", isError: false, content: null });
      expect(res).toBeUndefined();
    });
  });

  describe("L3: session_before_compact preemptive hard truncate", () => {
    const model = { id: "m", provider: "p", contextWindow: 128_000 };
    const preparation = {
      firstKeptEntryId: "uuid-42",
      messagesToSummarize: [{ role: "user", content: "..." }],
      tokensBefore: 90_000,
      settings: { keepRecentTokens: 20_000 },
    };
    const ctx = {
      model,
      modelRegistry: {
        getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "key", headers: { "x-test": "1" } })),
      },
      getSystemPrompt: vi.fn(() => "system prompt"),
      sessionManager: {
        getSessionFile: () => "/sessions/current.jsonl",
        getBranch: () => [],
        buildSessionContext: () => ({
          thinkingLevel: "off",
          messages: [{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 }],
        }),
      },
    };

    it("returns cache-preserving compaction when summarize tokens are within threshold", async () => {
      (estimatePreparationTokens as any).mockReturnValue(50_000); // < 128K * 0.85 = 108,800
      const res = await pi.trigger(
        "session_before_compact",
        { preparation, signal: { aborted: false } },
        ctx,
      );
      expect(res).toEqual({
        compaction: {
          summary: "cache summary",
          firstKeptEntryId: "uuid-42",
          tokensBefore: 90_000,
          details: { readFiles: [], modifiedFiles: [] },
        },
      });
      expect(cacheCompactor).toHaveBeenCalledWith(expect.objectContaining({
        preparation,
        model,
        systemPrompt: "system prompt",
        customInstructions: undefined,
        thinkingLevel: "off",
        sessionSnapshot: expect.objectContaining({
          sessionPath: "/sessions/current.jsonl",
          tools: [{
            name: "read",
            description: "Read files",
            parameters: { type: "object" },
          }],
        }),
        tools: [{
          name: "read",
          description: "Read files",
          parameters: { type: "object" },
        }],
      }));
      expect(buildSessionCacheSnapshot).toHaveBeenCalledWith("/sessions/current.jsonl", expect.objectContaining({
        reason: "compaction.history",
        messages: preparation.messagesToSummarize,
      }));
      expect(computeHardTruncation).not.toHaveBeenCalled();
    });

    it("lets Pi SDK native compaction run when pi-compatible mode is selected", async () => {
      pi = createMockPi();
      createCompactionGuardExtension({
        cacheCompactor,
        buildSessionCacheSnapshot,
        getCompactionMode: () => "pi_compatible",
      })(pi);
      (estimatePreparationTokens as any).mockReturnValue(50_000);

      const res = await pi.trigger(
        "session_before_compact",
        { preparation, signal: { aborted: false } },
        ctx,
      );

      expect(res).toBeUndefined();
      expect(cacheCompactor).not.toHaveBeenCalled();
      expect(buildSessionCacheSnapshot).not.toHaveBeenCalled();
      expect(computeHardTruncation).not.toHaveBeenCalled();
    });

    it("uses the session runtime for configured provider auth and request dispatch", async () => {
      (estimatePreparationTokens as any).mockReturnValue(50_000);
      const stream = { result: vi.fn(async () => ({ content: [{ type: "text", text: "summary" }] })) };
      const registry = {
        getApiKeyAndHeaders: vi.fn(),
        streamSimple: vi.fn(function (this: unknown) {
          expect(this).toBe(registry);
          return stream;
        }),
      };

      const res = await pi.trigger("session_before_compact", { preparation, signal: { aborted: false } }, {
        ...ctx,
        modelRegistry: registry,
      });

      expect(res.compaction.summary).toBe("cache summary");
      const request = cacheCompactor.mock.calls[0][0];
      expect(request.streamFn(model, { messages: [] }, request.streamOptions)).toBe(stream);
      expect(registry.streamSimple).toHaveBeenCalledWith(model, { messages: [] }, request.streamOptions);
      expect(registry.getApiKeyAndHeaders).not.toHaveBeenCalled();
      expect(request.streamOptions).not.toHaveProperty("apiKey");
    });

    it("accepts registry-approved local providers without an API key", async () => {
      (estimatePreparationTokens as any).mockReturnValue(50_000);
      const res = await pi.trigger("session_before_compact", { preparation, signal: { aborted: false } }, {
        ...ctx,
        modelRegistry: { getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, headers: {} })) },
      });
      expect(res.compaction.summary).toBe("cache summary");
      expect(cacheCompactor).toHaveBeenCalledOnce();
    });

    it("cancels when auto cache-preserving compaction fails instead of falling back to native compaction", async () => {
      pi = createMockPi();
      const failingCompactor = vi.fn(async () => {
        throw new Error("cache prefix mismatch");
      });
      createCompactionGuardExtension({
        cacheCompactor: failingCompactor,
        buildSessionCacheSnapshot,
        getCompactionMode: () => "auto",
      })(pi);
      (estimatePreparationTokens as any).mockReturnValue(50_000);

      const res = await pi.trigger(
        "session_before_compact",
        { preparation, signal: { aborted: false } },
        ctx,
      );

      expect(res).toEqual({ cancel: true });
      expect(failingCompactor).toHaveBeenCalledOnce();
      expect(buildSessionCacheSnapshot).toHaveBeenCalledWith("/sessions/current.jsonl", expect.objectContaining({
        reason: "compaction.history",
        messages: preparation.messagesToSummarize,
      }));
      expect(computeHardTruncation).not.toHaveBeenCalled();
    });

    it("cancels instead of falling back when explicit cache-preserving mode fails", async () => {
      pi = createMockPi();
      const failingCompactor = vi.fn(async () => {
        throw new Error("cache prefix mismatch");
      });
      createCompactionGuardExtension({
        cacheCompactor: failingCompactor,
        buildSessionCacheSnapshot,
        getCompactionMode: () => "cache_preserving",
      })(pi);
      (estimatePreparationTokens as any).mockReturnValue(50_000);

      const res = await pi.trigger(
        "session_before_compact",
        { preparation, signal: { aborted: false } },
        ctx,
      );

      expect(res).toEqual({ cancel: true });
      expect(failingCompactor).toHaveBeenCalledOnce();
    });

    it("strips inline media from compaction preparation before estimating or snapshotting history", async () => {
      (estimatePreparationTokens as any).mockReturnValue(50_000);
      const mediaPreparation = {
        ...preparation,
        messagesToSummarize: [
          {
            role: "user",
            content: [
              { type: "text", text: "[attached_audio: /tmp/recording.wav]\n听一下" },
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
      };

      await pi.trigger(
        "session_before_compact",
        { preparation: mediaPreparation, signal: { aborted: false } },
        ctx,
      );

      const estimatedPreparation = (estimatePreparationTokens as any).mock.calls[0][0];
      expect(JSON.stringify(estimatedPreparation)).not.toContain("BASE64_AUDIO");
      expect(JSON.stringify(estimatedPreparation)).not.toContain("BASE64_IMAGE");
      expect(estimatedPreparation.messagesToSummarize[0].content).toEqual([
        { type: "text", text: "[attached_audio: /tmp/recording.wav]\n听一下" },
      ]);
      expect(estimatedPreparation.messagesToSummarize[1].content).toEqual([
        { type: "text", text: "Screenshot captured" },
        { type: "text", text: "[image omitted: historical image retained as file reference to avoid resending raw base64]" },
      ]);

      const passedMessages = cacheCompactor.mock.calls[0][0].messages;
      expect(passedMessages).toEqual(estimatedPreparation.messagesToSummarize);
      expect(buildSessionCacheSnapshot).toHaveBeenCalledWith("/sessions/current.jsonl", expect.objectContaining({
        reason: "compaction.history",
        messages: estimatedPreparation.messagesToSummarize,
      }));
    });

    it("does not let the latest transformed context expand the Pi compaction boundary", async () => {
      (estimatePreparationTokens as any).mockReturnValue(50_000);
      await pi.trigger("context", {
        messages: [{ role: "user", content: [{ type: "text", text: "live context" }], timestamp: 1 }],
      });
      await pi.trigger("message_end", {
        message: { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 2 },
      });

      await pi.trigger(
        "session_before_compact",
        { preparation, signal: { aborted: false } },
        ctx,
      );

      expect(cacheCompactor.mock.calls[0][0].messages).toEqual(preparation.messagesToSummarize);
    });

    it("passes only Pi preparation messages to the cache compactor, not the kept tail from live context", async () => {
      (estimatePreparationTokens as any).mockReturnValue(50_000);
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
            ...preparation,
            messagesToSummarize: [
              { role: "user", content: [{ type: "text", text: "old history to summarize" }], timestamp: 1 },
            ],
          },
          signal: { aborted: false },
        },
        ctx,
      );

      const passedMessages = cacheCompactor.mock.calls[0][0].messages;
      expect(passedMessages).toHaveLength(1);
      expect(JSON.stringify(passedMessages)).toContain("old history to summarize");
      expect(JSON.stringify(passedMessages)).not.toContain("KEPT_TAIL_SHOULD_NOT_ENTER_SUMMARY");
    });

    it("does not read stale session-bound pi helpers during compaction", async () => {
      (estimatePreparationTokens as any).mockReturnValue(50_000);
      pi.getThinkingLevel.mockImplementation(() => {
        throw new Error("This extension ctx is stale after session replacement or reload.");
      });

      const res = await pi.trigger(
        "session_before_compact",
        { preparation, signal: { aborted: false } },
        ctx,
      );

      expect(res).toMatchObject({ compaction: expect.any(Object) });
      expect(pi.getThinkingLevel).not.toHaveBeenCalled();
      expect(cacheCompactor).toHaveBeenCalledWith(expect.objectContaining({
        thinkingLevel: "off",
      }));
    });

    it("uses the session snapshot cache params for the side-task request contract", async () => {
      (estimatePreparationTokens as any).mockReturnValue(50_000);
      (buildSessionCacheSnapshot as any).mockImplementationOnce((sessionPath: any, { reason, messages }: any = {}) => ({
        strategy: "session_snapshot",
        strict: true,
        sessionPath,
        reason,
        cachePrefixHash: "b".repeat(64),
        cacheKeyParams: { thinkingLevel: "medium" },
        tools: [],
        messages,
        messageCount: Array.isArray(messages) ? messages.length : 0,
      }));

      await pi.trigger(
        "session_before_compact",
        { preparation, signal: { aborted: false } },
        ctx,
      );

      expect(cacheCompactor).toHaveBeenCalledWith(expect.objectContaining({
        sessionSnapshot: expect.objectContaining({
          cacheKeyParams: { thinkingLevel: "medium" },
        }),
        cacheKeyParams: { thinkingLevel: "medium" },
      }));
    });

    it("canonicalizes legacy auto thinking before compaction side-task requests", async () => {
      (estimatePreparationTokens as any).mockReturnValue(50_000);
      (buildSessionCacheSnapshot as any).mockImplementationOnce((sessionPath: any, { reason, messages }: any = {}) => ({
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

      await pi.trigger(
        "session_before_compact",
        { preparation, signal: { aborted: false } },
        {
          ...ctx,
          sessionManager: {
            ...ctx.sessionManager,
            buildSessionContext: () => ({ thinkingLevel: "auto" }),
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
        max_tokens: 32000,
      }, {
        id: "deepseek-v4-pro",
        provider: "deepseek",
        api: "openai-completions",
        reasoning: true,
        contextWindow: 128_000,
      })).toMatchObject({
        reasoning_effort: "high",
      });
    });

    it("uses explicit cache recovery when GLM thinking tool-call history cannot replay reasoning_content", async () => {
      (estimatePreparationTokens as any).mockReturnValue(50_000);
      const glmModel = {
        id: "glm-4.5",
        provider: "zhipu",
        api: "openai-completions",
        reasoning: true,
        contextWindow: 128_000,
      };
      const res = await pi.trigger(
        "session_before_compact",
        {
          preparation: {
            ...preparation,
            messagesToSummarize: [
              {
                role: "assistant",
                content: "",
                tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: "{}" } }],
              },
            ],
          },
          signal: { aborted: false },
        },
        {
          ...ctx,
          model: glmModel,
          sessionManager: {
            ...ctx.sessionManager,
            buildSessionContext: () => ({ thinkingLevel: "high" }),
          },
        },
      );

      expect(res).toMatchObject({ compaction: expect.any(Object) });
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
      const call = cacheCompactor.mock.calls[0][0];
      const recoveredPayload = call.streamOptions.onPayload({
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

    it("auto-recovers when reasoning replay only fails during the compaction request", async () => {
      pi = createMockPi();
      const requestStageCompactor = vi.fn()
        .mockRejectedValueOnce(new Error(
          "Zhipu thinking mode reasoning_content is missing for tool_calls history. Compact this session or start a new session before continuing with Zhipu thinking mode.",
        ))
        .mockResolvedValueOnce({
          summary: "request-stage recovery summary",
          firstKeptEntryId: "uuid-42",
          tokensBefore: 90_000,
          details: { readFiles: [], modifiedFiles: [] },
        });
      createCompactionGuardExtension({
        cacheCompactor: requestStageCompactor,
        buildSessionCacheSnapshot,
        getCompactionMode: () => "auto",
      })(pi);
      (estimatePreparationTokens as any).mockReturnValue(50_000);
      const glmModel = {
        id: "glm-5.1",
        provider: "zhipu",
        api: "openai-completions",
        reasoning: true,
        contextWindow: 128_000,
      };

      const res = await pi.trigger(
        "session_before_compact",
        { preparation, signal: { aborted: false } },
        {
          ...ctx,
          model: glmModel,
          sessionManager: {
            ...ctx.sessionManager,
            buildSessionContext: () => ({ thinkingLevel: "high" }),
          },
        },
      );

      expect(res).toEqual({
        compaction: {
          summary: "request-stage recovery summary",
          firstKeptEntryId: "uuid-42",
          tokensBefore: 90_000,
          details: { readFiles: [], modifiedFiles: [] },
        },
      });
      expect(requestStageCompactor).toHaveBeenCalledTimes(2);
      expect(requestStageCompactor.mock.calls[0][0]).toMatchObject({
        model: glmModel,
        cacheMetadataOverride: null,
      });
      expect(requestStageCompactor.mock.calls[1][0]).toMatchObject({
        model: glmModel,
        thinkingLevel: "high",
        cacheKeyParams: { thinkingLevel: "high", reasoningReplay: "clear" },
        cacheMetadataOverride: expect.objectContaining({
          cacheStrategy: "cache_recovery",
          strict: false,
          degradeReason: "reasoning_replay_unavailable",
        }),
      });
      const recoveryPayload = requestStageCompactor.mock.calls[1][0].streamOptions.onPayload({
        model: "glm-5.1",
        messages: [{
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: "{}" } }],
        }],
      }, glmModel);
      expect(recoveryPayload.thinking).toEqual({ type: "enabled", clear_thinking: true });
    });

    it("returns hard truncation when the full cache-preserving request would exceed the budget", async () => {
      (estimatePreparationTokens as any).mockReturnValue(100); // old Pi summarizer estimate fits
      (computeHardTruncation as any).mockReturnValue({
        summary: "[hard truncated for full request]",
        firstKeptEntryId: "uuid-42",
        tokensBefore: 90_000,
        details: { reason: "compaction-guard-hard-truncate" },
      });
      const branch = [{ type: "message", id: "a" }, { type: "message", id: "b" }];
      const tinyModel = { ...model, contextWindow: 1000 };
      const res = await pi.trigger(
        "session_before_compact",
        { preparation: { ...preparation, settings: { keepRecentTokens: 100, reserveTokens: 512 } }, signal: { aborted: false } },
        {
          ...ctx,
          model: tinyModel,
          getSystemPrompt: vi.fn(() => "system " + "x".repeat(1000)),
          sessionManager: {
            ...ctx.sessionManager,
            getBranch: () => branch,
            buildSessionContext: () => ({
              thinkingLevel: "off",
              messages: [{ role: "user", content: [{ type: "text", text: "x".repeat(6000) }], timestamp: 1 }],
            }),
          },
        },
      );

      expect(res).toEqual({
        compaction: {
          summary: "[hard truncated for full request]",
          firstKeptEntryId: "uuid-42",
          tokensBefore: 90_000,
          details: { reason: "compaction-guard-hard-truncate" },
        },
      });
      expect(computeHardTruncation).toHaveBeenCalledWith(branch, 100, expect.objectContaining({
        reason: "compaction-guard-hard-truncate",
      }));
      expect(cacheCompactor).not.toHaveBeenCalled();
    });

    it("returns hard truncation when summarize tokens exceed threshold", async () => {
      (estimatePreparationTokens as any).mockReturnValue(120_000); // > 108,800
      (computeHardTruncation as any).mockReturnValue({
        summary: "[hard truncated]",
        firstKeptEntryId: "uuid-42",
        tokensBefore: 90_000,
        details: { reason: "compaction-guard-hard-truncate" },
      });
      const branch = [{ type: "message", id: "a" }, { type: "message", id: "b" }];
      const res = await pi.trigger(
        "session_before_compact",
        { preparation, signal: { aborted: false } },
        { ...ctx, sessionManager: { ...ctx.sessionManager, getBranch: () => branch } },
      );
      expect(res).toEqual({
        compaction: {
          summary: "[hard truncated]",
          firstKeptEntryId: "uuid-42",
          tokensBefore: 90_000,
          details: { reason: "compaction-guard-hard-truncate" },
        },
      });
      expect(computeHardTruncation).toHaveBeenCalledWith(branch, 20_000, expect.objectContaining({
        reason: "compaction-guard-hard-truncate",
      }));
      expect(cacheCompactor).not.toHaveBeenCalled();
    });

    it("cancels when hard truncate itself fails", async () => {
      (estimatePreparationTokens as any).mockReturnValue(120_000);
      (computeHardTruncation as any).mockReturnValue(null); // 无法截断
      const res = await pi.trigger(
        "session_before_compact",
        { preparation, signal: { aborted: false } },
        ctx,
      );
      expect(res).toEqual({ cancel: true });
    });

    it("cancels when signal already aborted", async () => {
      (estimatePreparationTokens as any).mockReturnValue(120_000);
      const res = await pi.trigger(
        "session_before_compact",
        { preparation, signal: { aborted: true } },
        ctx,
      );
      expect(res).toEqual({ cancel: true });
      expect(computeHardTruncation).not.toHaveBeenCalled();
    });

    it("cancels when model is missing", async () => {
      (estimatePreparationTokens as any).mockReturnValue(120_000);
      const res = await pi.trigger(
        "session_before_compact",
        { preparation, signal: { aborted: false } },
        { ...ctx, model: undefined },
      );
      expect(res).toEqual({ cancel: true });
    });

    it("cancels when contextWindow is 0", async () => {
      (estimatePreparationTokens as any).mockReturnValue(120_000);
      const res = await pi.trigger(
        "session_before_compact",
        { preparation, signal: { aborted: false } },
        { ...ctx, model: { ...model, contextWindow: 0 } },
      );
      expect(res).toEqual({ cancel: true });
    });

    it("swallows hook exceptions and cancels", async () => {
      (estimatePreparationTokens as any).mockImplementation(() => {
        throw new Error("boom");
      });
      const res = await pi.trigger(
        "session_before_compact",
        { preparation, signal: { aborted: false } },
        ctx,
      );
      expect(res).toEqual({ cancel: true });
    });

    it("honors custom hardTruncateThreshold option", async () => {
      pi = createMockPi();
      createCompactionGuardExtension({ hardTruncateThreshold: 0.5, cacheCompactor })(pi);
      // 50% * 128K = 64K
      (estimatePreparationTokens as any).mockReturnValue(70_000); // > 64K 应触发
      (computeHardTruncation as any).mockReturnValue({
        summary: "s", firstKeptEntryId: "id", tokensBefore: 0, details: {},
      });
      const res = await pi.trigger(
        "session_before_compact",
        { preparation, signal: { aborted: false } },
        ctx,
      );
      expect(res).toMatchObject({ compaction: expect.any(Object) });
    });
  });
});
