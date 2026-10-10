// @ts-nocheck
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  completeSimpleMock,
  convertAgentMessagesToLlmMock,
  estimateTokensMock,
  findCutPointMock,
  prepareCompactionMock,
} = vi.hoisted(() => ({
  completeSimpleMock: vi.fn(),
  convertAgentMessagesToLlmMock: vi.fn(async (messages) => messages),
  estimateTokensMock: vi.fn((message) => {
    const content = Array.isArray(message?.content)
      ? message.content.map((block) => block?.text || block?.thinking || JSON.stringify(block || {})).join("")
      : String(message?.content || message?.summary || "");
    return Math.ceil(content.length / 4);
  }),
  findCutPointMock: vi.fn(() => ({ firstKeptEntryIndex: 1, turnStartIndex: -1, isSplitTurn: false })),
  prepareCompactionMock: vi.fn(),
}));

vi.mock("../lib/pi-sdk/index.js", () => ({
  completeSimple: completeSimpleMock,
  convertAgentMessagesToLlm: convertAgentMessagesToLlmMock,
  estimateTokens: estimateTokensMock,
  findCutPoint: findCutPointMock,
  prepareCompaction: prepareCompactionMock,
}));

import {
  CACHE_PRESERVING_COMPACTION_EXTENSION_MISSING_MESSAGE,
  compactSessionWithCachePreservation,
  compactSessionWithCachePreservationRecoveringRuntime,
  createCachePreservingCompactionResult,
  runCachePreservingCompactionForSession,
} from "../core/session-compactor.js";
import { buildSessionCacheSnapshot } from "../core/session-cache-snapshot.js";
import { createUsageLedger } from "../lib/llm/usage-ledger.js";

describe("session-compactor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    convertAgentMessagesToLlmMock.mockImplementation(async (messages) => messages);
    estimateTokensMock.mockImplementation((message) => {
      const content = Array.isArray(message?.content)
        ? message.content.map((block) => block?.text || block?.thinking || JSON.stringify(block || {})).join("")
        : String(message?.content || message?.summary || "");
      return Math.ceil(content.length / 4);
    });
    findCutPointMock.mockReturnValue({ firstKeptEntryIndex: 1, turnStartIndex: -1, isSplitTurn: false });
  });

  function createDirectCompactionSession(result = async () => ({
    stopReason: "stop",
    content: [{ type: "text", text: "summary" }],
  })) {
    const preparation = {
      firstKeptEntryId: "entry-keep",
      tokensBefore: 4000,
      settings: { reserveTokens: 2000, keepRecentTokens: 100 },
    };
    prepareCompactionMock.mockReturnValue(preparation);
    return {
      model: { id: "model", reasoning: false, contextWindow: 128000 },
      refreshContext: vi.fn(),
      compact: vi.fn(),
      extensionRunner: { hasHandlers: vi.fn(() => false) },
      settingsManager: { getCompactionSettings: () => preparation.settings },
      sessionManager: {
        getBranch: vi.fn(() => [
          { type: "message", id: "entry-old", message: { role: "user", content: "old context" } },
          { type: "message", id: "entry-keep", message: { role: "assistant", content: "recent context" } },
        ]),
        appendCompaction: vi.fn(),
      },
      agent: {
        state: { systemPrompt: "system", messages: [{ role: "user", content: "history" }], tools: [] },
        streamFn: vi.fn(async () => ({ result })),
        convertToLlm: vi.fn(async (messages) => messages),
      },
    };
  }

  it("does not hard-truncate history when compaction was already cancelled", async () => {
    const session = createDirectCompactionSession();
    session.model.contextWindow = 1000;
    const controller = new AbortController();
    controller.abort();

    await expect(runCachePreservingCompactionForSession(session, { signal: controller.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(session.sessionManager.appendCompaction).not.toHaveBeenCalled();
    expect(session.refreshContext).not.toHaveBeenCalled();
    expect(session.agent.streamFn).not.toHaveBeenCalled();
  });

  it("keeps history when a provider returns a summary after cancellation", async () => {
    const controller = new AbortController();
    const session = createDirectCompactionSession(async () => {
      controller.abort();
      return { stopReason: "stop", content: [{ type: "text", text: "late summary" }] };
    });

    await expect(runCachePreservingCompactionForSession(session, { signal: controller.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(session.sessionManager.appendCompaction).not.toHaveBeenCalled();
    expect(session.refreshContext).not.toHaveBeenCalled();
  });

  it("rejects concurrent direct or manual compaction and releases its guard on failure", async () => {
    let rejectSummary;
    const result = new Promise((_resolve, reject) => { rejectSummary = reject; });
    const session = createDirectCompactionSession(() => result);
    const pending = runCachePreservingCompactionForSession(session);
    const pendingAssertion = expect(pending).rejects.toThrow("summary failed");

    await expect(runCachePreservingCompactionForSession(session)).rejects.toThrow("compaction already in progress");
    await expect(compactSessionWithCachePreservation(session)).rejects.toThrow("compaction already in progress");
    expect(session.compact).not.toHaveBeenCalled();
    rejectSummary(new Error("summary failed"));
    await pendingAssertion;
    expect(session.sessionManager.appendCompaction).not.toHaveBeenCalled();

    session.agent.streamFn.mockResolvedValue({ result: async () => ({
      stopReason: "stop", content: [{ type: "text", text: "recovered summary" }],
    }) });
    await expect(runCachePreservingCompactionForSession(session)).resolves.toMatchObject({ summary: "recovered summary" });
    expect(session.sessionManager.appendCompaction).toHaveBeenCalledOnce();
  });

  it("does not start direct compaction while SDK compaction is active", async () => {
    const session = { ...createDirectCompactionSession(), isCompacting: true };
    await expect(runCachePreservingCompactionForSession(session)).rejects.toThrow("compaction already in progress");
    expect(session.agent.streamFn).not.toHaveBeenCalled();
    expect(session.sessionManager.appendCompaction).not.toHaveBeenCalled();
  });

  it("appends an internal compaction instruction and strips tools from the summary call", async () => {
    const signal = new AbortController().signal;
    const resultStream = {
      result: vi.fn(async () => ({
        stopReason: "stop",
        content: [{ type: "text", text: " checkpoint summary " }],
      })),
    };
    const streamFn = vi.fn(async () => resultStream);
    const convertToLlm = vi.fn(async (messages) => messages);

    const result = await createCachePreservingCompactionResult({
      preparation: {
        firstKeptEntryId: "entry-keep",
        tokensBefore: 1234,
        settings: { reserveTokens: 1000 },
        fileOps: {
          read: new Set(["/tmp/read.md", "/tmp/edited.md"]),
          written: new Set(["/tmp/written.md"]),
          edited: new Set(["/tmp/edited.md"]),
        },
      },
      model: { id: "model", reasoning: true },
      systemPrompt: "system prompt",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 }],
      tools: [{ name: "read", description: "Read files", parameters: { type: "object" } }],
      customInstructions: "focus on decisions",
      signal,
      thinkingLevel: "high",
      streamFn,
      convertToLlm,
    });

    expect(convertToLlm).toHaveBeenCalledOnce();
    expect(streamFn).toHaveBeenCalledOnce();
    const [model, context, options] = streamFn.mock.calls[0];
    expect(model).toEqual({ id: "model", reasoning: true });
    expect(context.systemPrompt).toBe("system prompt");
    expect(context.tools).toBeUndefined();
    expect(context.messages).toHaveLength(2);
    expect(context.messages[1].role).toBe("user");
    expect(context.messages[1].content[0].text).toContain("Codia cache-preserving compaction");
    expect(context.messages[1].content[0].text).toContain("focus on decisions");
    expect(options).toEqual(expect.objectContaining({
      maxTokens: 800,
      reasoning: "high",
      signal,
      toolChoice: "none",
    }));

    expect(result).toEqual({
      summary: [
        "checkpoint summary",
        "",
        "<read-files>",
        "/tmp/read.md",
        "</read-files>",
        "",
        "<modified-files>",
        "/tmp/edited.md",
        "/tmp/written.md",
        "</modified-files>",
      ].join("\n"),
      firstKeptEntryId: "entry-keep",
      tokensBefore: 1234,
      details: {
        readFiles: ["/tmp/read.md"],
        modifiedFiles: ["/tmp/edited.md", "/tmp/written.md"],
      },
    });
  });

  it("records cache-preserving compaction usage in the usage ledger", async () => {
    const ledger = createUsageLedger({ requestIdFactory: () => "compact-usage-1" });
    const resultStream = {
      result: vi.fn(async () => ({
        stopReason: "stop",
        content: [{ type: "text", text: " checkpoint summary " }],
        usage: {
          input_tokens: 100,
          output_tokens: 25,
          cache_read_input_tokens: 80,
        },
      })),
    };

    await createCachePreservingCompactionResult({
      preparation: {
        firstKeptEntryId: "entry-keep",
        tokensBefore: 1234,
        settings: { reserveTokens: 1000 },
      },
      model: {
        id: "gpt-5",
        provider: "openai",
        api: "openai-responses",
        reasoning: false,
      },
      systemPrompt: "system prompt",
      messages: [{ role: "user", content: "hello" }],
      streamFn: vi.fn(async () => resultStream),
      convertToLlm: vi.fn(async (messages) => messages),
      usageLedger: ledger,
      usageContext: {
        source: {
          subsystem: "compaction",
          operation: "compact",
          surface: "desktop",
          trigger: "overflow",
        },
        attribution: {
          kind: "session",
          agentId: "agent-1",
          sessionPath: "/sessions/current.jsonl",
        },
      },
    });

    const [entry] = ledger.list({ subsystem: "compaction" }).entries;
    expect(entry).toMatchObject({
      requestId: "compact-usage-1",
      status: "ok",
      source: { subsystem: "compaction", operation: "compact" },
      attribution: { kind: "session", sessionPath: "/sessions/current.jsonl" },
      model: { provider: "openai", modelId: "gpt-5", api: "openai-responses" },
      usage: {
        input: { totalTokens: 180, uncachedTokens: 100 },
        output: { totalTokens: 25 },
        cache: { readTokens: 80, hit: true },
      },
    });
  });

  it("rebuilds the side-task snapshot without tools when the compaction request strips tools", async () => {
    const resultStream = {
      result: vi.fn(async () => ({
        stopReason: "stop",
        content: [{ type: "text", text: " checkpoint summary " }],
      })),
    };
    const streamFn = vi.fn(async () => resultStream);
    const convertToLlm = vi.fn(async (messages) => messages);
    const model = {
      id: "model",
      provider: "test",
      api: "openai-responses",
      reasoning: false,
    };
    const parentSnapshot = buildSessionCacheSnapshot({
      sessionPath: "/sessions/current.jsonl",
      reason: "compaction.history",
      model,
      cacheKeyParams: { thinkingLevel: "off" },
      systemPrompt: "system prompt",
      tools: [{ name: "read", description: "Read files", parameters: { type: "object" } }],
      messages: [{ role: "user", content: "hello" }],
    });

    await expect(createCachePreservingCompactionResult({
      preparation: {
        firstKeptEntryId: "entry-keep",
        tokensBefore: 1234,
        settings: { reserveTokens: 1000 },
      },
      model,
      systemPrompt: "system prompt",
      messages: [{ role: "user", content: "hello" }],
      sessionSnapshot: parentSnapshot,
      cacheKeyParams: { thinkingLevel: "off" },
      streamFn,
      convertToLlm,
    })).resolves.toMatchObject({
      summary: "checkpoint summary",
      firstKeptEntryId: "entry-keep",
    });

    const [, context] = streamFn.mock.calls[0];
    expect(context.tools).toBeUndefined();
  });

  it("writes cache-preserving compaction results back into the session branch", async () => {
    const preparation = {
      firstKeptEntryId: "entry-keep",
      tokensBefore: 4321,
      settings: { reserveTokens: 2000 },
    };
    const branch = [{ type: "message", id: "entry-old" }, { type: "message", id: "entry-keep" }];
    const compactedMessages = [{ role: "user", content: "after compaction" }];
    prepareCompactionMock.mockReturnValue(preparation);

    const appendCompaction = vi.fn();
    const refreshContext = vi.fn();
    const session = {
      model: { id: "model", reasoning: false, contextWindow: 128000 },
      refreshContext,
      settingsManager: {
        getCompactionSettings: vi.fn(() => ({ enabled: true, reserveTokens: 2000 })),
      },
      sessionManager: {
        getBranch: vi.fn(() => branch),
        appendCompaction,
        buildSessionContext: vi.fn(() => ({ messages: compactedMessages })),
      },
      agent: {
        state: {
          systemPrompt: "system prompt",
          messages: [{ role: "user", content: "before compaction" }],
          tools: [],
          thinkingLevel: "off",
        },
        transformContext: vi.fn(async (messages) => [
          ...messages,
          { role: "assistant", content: "latest streamed answer" },
        ]),
        streamFn: vi.fn(async () => ({
          result: vi.fn(async () => ({
            stopReason: "stop",
            content: [{ type: "text", text: "cache summary" }],
          })),
        })),
        convertToLlm: vi.fn(async (messages) => messages),
      },
    };

    const result = await runCachePreservingCompactionForSession(session);

    expect(prepareCompactionMock).toHaveBeenCalledWith(branch, { enabled: true, reserveTokens: 2000 });
    expect(session.agent.transformContext).toHaveBeenCalledWith(
      [{ role: "user", content: "before compaction" }],
      undefined,
    );
    expect(appendCompaction).toHaveBeenCalledWith(
      "cache summary",
      "entry-keep",
      4321,
      { readFiles: [], modifiedFiles: [] },
      true,
    );
    expect(refreshContext).toHaveBeenCalledOnce();
    expect(result.summary).toBe("cache summary");
  });

  it("hard truncates direct session compaction when the cache-preserving request cannot fit", async () => {
    const preparation = {
      firstKeptEntryId: "entry-keep",
      tokensBefore: 9000,
      settings: { reserveTokens: 2000, keepRecentTokens: 100 },
    };
    const branch = [
      { type: "message", id: "entry-old", message: { role: "user", content: "old " + "x".repeat(2000) } },
      { type: "message", id: "entry-keep", message: { role: "assistant", content: [{ type: "text", text: "keep" }] } },
    ];
    const compactedMessages = [{ role: "compactionSummary", summary: "truncated" }];
    prepareCompactionMock.mockReturnValue(preparation);

    const appendCompaction = vi.fn();
    const refreshContext = vi.fn();
    const streamFn = vi.fn(async () => ({
      result: vi.fn(async () => ({
        stopReason: "stop",
        content: [{ type: "text", text: "should not run" }],
      })),
    }));
    const session = {
      model: { id: "tiny", reasoning: false, contextWindow: 1000 },
      refreshContext,
      settingsManager: {
        getCompactionSettings: vi.fn(() => ({ enabled: true, reserveTokens: 2000, keepRecentTokens: 100 })),
      },
      sessionManager: {
        getBranch: vi.fn(() => branch),
        appendCompaction,
        buildSessionContext: vi.fn(() => ({ messages: compactedMessages })),
      },
      agent: {
        state: {
          systemPrompt: "system " + "x".repeat(2000),
          messages: [{ role: "user", content: [{ type: "text", text: "x".repeat(6000) }] }],
          tools: [],
          thinkingLevel: "off",
        },
        streamFn,
        convertToLlm: vi.fn(async (messages) => messages),
      },
    };

    const result = await runCachePreservingCompactionForSession(session);

    expect(streamFn).not.toHaveBeenCalled();
    expect(appendCompaction).toHaveBeenCalledWith(
      expect.stringContaining("早期对话历史已被硬截断"),
      "entry-keep",
      expect.any(Number),
      expect.objectContaining({ reason: "cache-preserving-compaction-hard-truncate" }),
      true,
    );
    expect(refreshContext).toHaveBeenCalledOnce();
    expect(result.details.reason).toBe("cache-preserving-compaction-hard-truncate");
  });

  it("hard truncates direct session compaction when model context window is unknown", async () => {
    const preparation = {
      firstKeptEntryId: "entry-keep",
      tokensBefore: 9000,
      settings: { reserveTokens: 2000, keepRecentTokens: 100 },
    };
    const branch = [
      { type: "message", id: "entry-old", message: { role: "user", content: "old context" } },
      { type: "message", id: "entry-keep", message: { role: "assistant", content: "keep" } },
    ];
    prepareCompactionMock.mockReturnValue(preparation);

    const appendCompaction = vi.fn();
    const streamFn = vi.fn(async () => ({
      result: vi.fn(async () => ({
        stopReason: "stop",
        content: [{ type: "text", text: "should not run" }],
      })),
    }));
    const session = {
      model: { id: "missing-window", reasoning: false },
      refreshContext: vi.fn(),
      settingsManager: {
        getCompactionSettings: vi.fn(() => ({ enabled: true, reserveTokens: 2000, keepRecentTokens: 100 })),
      },
      sessionManager: {
        getBranch: vi.fn(() => branch),
        appendCompaction,
        buildSessionContext: vi.fn(() => ({ messages: [{ role: "compactionSummary", summary: "truncated" }] })),
      },
      agent: {
        state: {
          systemPrompt: "system prompt",
          messages: [{ role: "user", content: "before compaction" }],
          tools: [],
          thinkingLevel: "off",
        },
        streamFn,
        convertToLlm: vi.fn(async (messages) => messages),
      },
    };

    const result = await runCachePreservingCompactionForSession(session);

    expect(streamFn).not.toHaveBeenCalled();
    expect(appendCompaction).toHaveBeenCalledWith(
      expect.stringContaining("早期对话历史已被硬截断"),
      "entry-keep",
      expect.any(Number),
      expect.objectContaining({ reason: "cache-preserving-compaction-hard-truncate" }),
      true,
    );
    expect(result.details.reason).toBe("cache-preserving-compaction-hard-truncate");
  });

  it("emits lifecycle events for direct model-switch compaction", async () => {
    const preparation = {
      firstKeptEntryId: "entry-keep",
      tokensBefore: 4321,
      settings: { reserveTokens: 2000 },
    };
    const branch = [{ type: "message", id: "entry-old" }, { type: "message", id: "entry-keep" }];
    const compactedMessages = [{ role: "user", content: "after compaction" }];
    prepareCompactionMock.mockReturnValue(preparation);

    const appendCompaction = vi.fn(() => "compaction-entry");
    const emit = vi.fn();
    const extensionEmit = vi.fn(async () => {});
    const session = {
      model: { id: "model", reasoning: false, contextWindow: 128000 },
      refreshContext: vi.fn(),
      _emit: emit,
      extensionRunner: {
        hasHandlers: vi.fn((event) => event === "session_compact"),
        emit: extensionEmit,
      },
      settingsManager: {
        getCompactionSettings: vi.fn(() => ({ enabled: true, reserveTokens: 2000 })),
      },
      sessionManager: {
        getBranch: vi.fn(() => branch),
        appendCompaction,
        getEntry: vi.fn(() => ({ type: "compaction", id: "compaction-entry", summary: "cache summary" })),
        buildSessionContext: vi.fn(() => ({ messages: compactedMessages })),
      },
      agent: {
        state: {
          systemPrompt: "system prompt",
          messages: [{ role: "user", content: "before compaction" }],
          tools: [],
          thinkingLevel: "off",
        },
        streamFn: vi.fn(async () => ({
          result: vi.fn(async () => ({
            stopReason: "stop",
            content: [{ type: "text", text: "cache summary" }],
          })),
        })),
        convertToLlm: vi.fn(async (messages) => messages),
      },
    };

    await runCachePreservingCompactionForSession(session, {
      emitLifecycle: true,
      lifecycleReason: "model_switch",
    });

    expect(emit).toHaveBeenNthCalledWith(1, { type: "compaction_start", reason: "model_switch" });
    expect(extensionEmit).toHaveBeenCalledWith({
      type: "session_compact",
      compactionEntry: { type: "compaction", id: "compaction-entry", summary: "cache summary" },
      fromExtension: true,
    });
    expect(emit).toHaveBeenLastCalledWith({
      type: "compaction_end",
      reason: "model_switch",
      result: expect.objectContaining({ summary: "cache summary" }),
      aborted: false,
      willRetry: false,
    });
  });

  it("normalizes cache-preserving compaction context messages before side-task dispatch", async () => {
    const preparation = {
      firstKeptEntryId: "entry-keep",
      tokensBefore: 2048,
      settings: { reserveTokens: 2000 },
      messagesToSummarize: [
        { role: "assistant", content: [{ type: "toolCall", id: "tool-1", name: "date", input: {} }] },
      ],
    };

    await expect(createCachePreservingCompactionResult({
      preparation,
      model: {
        id: "deepseek-v4-pro",
        provider: "deepseek",
        api: "anthropic-messages",
        baseUrl: "https://api.deepseek.com/anthropic",
        reasoning: true,
        contextWindow: 128000,
      },
      systemPrompt: "system",
      messages: preparation.messagesToSummarize,
      thinkingLevel: "high",
      convertToLlm: vi.fn(async () => preparation.messagesToSummarize),
      streamFn: vi.fn(),
    })).rejects.toThrow("DeepSeek Anthropic thinking mode history is missing non-empty thinking content");
  });

  it("reloads and retries manual cache-preserving compaction on recoverable runtime errors", async () => {
    const staleSession = {
      compact: vi.fn(),
      extensionRunner: {
        assertActive: vi.fn(() => {
          throw new Error("This extension ctx is stale after session replacement or reload.");
        }),
      },
    };
    const reloadedSession = {
      compact: vi.fn(async () => "compacted"),
      extensionRunner: {
        assertActive: vi.fn(),
        hasHandlers: vi.fn((event) => event === "session_before_compact"),
      },
    };
    const reloadSessionRuntime = vi.fn(async () => reloadedSession);
    const onRuntimeReload = vi.fn();

    await expect(compactSessionWithCachePreservationRecoveringRuntime({
      session: staleSession,
      sessionPath: "/tmp/session.jsonl",
      customInstructions: "keep decisions",
      reloadSessionRuntime,
      onRuntimeReload,
    })).resolves.toEqual({
      result: "compacted",
      session: reloadedSession,
      recovered: true,
    });

    expect(reloadSessionRuntime).toHaveBeenCalledWith("/tmp/session.jsonl");
    expect(onRuntimeReload).toHaveBeenCalledWith({
      error: expect.any(Error),
      session: reloadedSession,
    });
    expect(reloadedSession.compact).toHaveBeenCalledWith("keep decisions");
  });

  it("refuses the manual wrapper when the compaction hook is missing", async () => {
    const session = {
      compact: vi.fn(),
      extensionRunner: { hasHandlers: vi.fn(() => false) },
    };

    await expect(compactSessionWithCachePreservation(session)).rejects.toThrow(
      CACHE_PRESERVING_COMPACTION_EXTENSION_MISSING_MESSAGE,
    );
    expect(session.compact).not.toHaveBeenCalled();
  });

  it("reports stale extension runners before invoking manual compaction", async () => {
    const session = {
      compact: vi.fn(),
      extensionRunner: {
        assertActive: vi.fn(() => {
          throw new Error("This extension ctx is stale after session replacement or reload.");
        }),
        hasHandlers: vi.fn(() => true),
      },
    };

    await expect(compactSessionWithCachePreservation(session)).rejects.toThrow(
      "This extension ctx is stale after session replacement or reload",
    );
    expect(session.extensionRunner.hasHandlers).not.toHaveBeenCalled();
    expect(session.compact).not.toHaveBeenCalled();
  });

  it("keeps Pi lifecycle events by delegating manual compaction through session.compact", async () => {
    const session = {
      compact: vi.fn(async () => "ok"),
      extensionRunner: { hasHandlers: vi.fn(() => true) },
    };

    await expect(compactSessionWithCachePreservation(session, "extra focus")).resolves.toBe("ok");
    expect(session.compact).toHaveBeenCalledWith("extra focus");
  });
});
