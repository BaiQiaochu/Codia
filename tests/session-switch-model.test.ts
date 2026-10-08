import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  convertAgentMessagesToLlmMock,
  estimateTokensMock,
  findCutPointMock,
  prepareCompactionMock,
} = vi.hoisted(() => ({
  convertAgentMessagesToLlmMock: vi.fn(async (messages) => messages),
  estimateTokensMock: vi.fn(() => 2000),
  findCutPointMock: vi.fn(() => ({ firstKeptEntryIndex: 1, turnStartIndex: -1, isSplitTurn: false })),
  prepareCompactionMock: vi.fn(),
}));

vi.mock("../lib/pi-sdk/index.js", () => ({
  completeSimple: vi.fn(),
  convertAgentMessagesToLlm: convertAgentMessagesToLlmMock,
  createAgentSession: vi.fn(),
  SessionManager: {
    create: vi.fn(),
    open: vi.fn(),
  },
  estimateTokens: estimateTokensMock,
  findCutPoint: findCutPointMock,
  generateSummary: vi.fn(),
  prepareCompaction: prepareCompactionMock,
  emitSessionShutdown: vi.fn(),
  refreshSessionModelFromRegistry: vi.fn(),
}));

vi.mock("../lib/debug-log.js", () => ({
  createModuleLogger: () => ({
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { SessionCoordinator } from "../core/session-coordinator.ts";

const agentsDir = "/tmp/agents";
const sessionPath = `${agentsDir}/hana/sessions/session.jsonl`;
const missingSessionPath = `${agentsDir}/hana/sessions/missing.jsonl`;

describe("SessionCoordinator.switchSessionModel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    convertAgentMessagesToLlmMock.mockImplementation(async (messages) => messages);
    estimateTokensMock.mockReturnValue(2000);
    findCutPointMock.mockReturnValue({ firstKeptEntryIndex: 1, turnStartIndex: -1, isSplitTurn: false });
  });

  it("reports per-session model switch state through a public query", () => {
    const coord = new SessionCoordinator({
      agentsDir,
      getAgent: () => ({ sessionDir: `${agentsDir}/hana/sessions` }),
      getActiveAgentId: () => "hana",
      getModels: () => null,
      getResourceLoader: () => null,
      getSkills: () => null,
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: () => {},
      getHomeCwd: () => "/tmp",
      agentIdFromSessionPath: () => null,
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => null,
      listAgents: () => [],
    });

    coord.sessions.set(sessionPath, {
      session: {},
      _switching: true,
    });

    expect(coord.isSessionSwitching(sessionPath)).toBe(true);
    expect(coord.isSessionSwitching(missingSessionPath)).toBe(false);
  });

  it("does not crash when context usage exists and adaptation is needed", async () => {
    const coord = new SessionCoordinator({
      agentsDir,
      getAgent: () => ({ sessionDir: `${agentsDir}/hana/sessions` }),
      getActiveAgentId: () => "hana",
      getModels: () => null,
      getResourceLoader: () => null,
      getSkills: () => null,
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: () => {},
      getHomeCwd: () => "/tmp",
      agentIdFromSessionPath: () => null,
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => null,
      listAgents: () => [],
    });

    const setModel = vi.fn(async () => {});
    const entry = {
      session: {
        model: { id: "old-model", provider: "test", contextWindow: 64000 },
        isCompacting: false,
        getContextUsage: () => ({ tokens: 10000 }),
        agent: {
          state: {
            messages: [
              { role: "system", content: "sys" },
              { role: "user", content: "question" },
              { role: "assistant", content: "answer" },
            ],
          },
        },
        setModel,
      },
      modelId: "old-model",
      modelProvider: "test",
    };
    coord.sessions.set(sessionPath, entry);

    const compactSpy = (vi.spyOn(coord, "_compactWithModel").mockResolvedValue as any)();
    const truncateSpy = (vi.spyOn(coord, "_hardTruncate").mockResolvedValue as any)();

    const result = await coord.switchSessionModel(sessionPath, {
      id: "new-model",
      provider: "test",
      contextWindow: 12000,
    });

    expect(result).toEqual({ adaptations: ["compacted"], thinkingLevel: "medium" });
    expect(compactSpy).toHaveBeenCalledOnce();
    expect(truncateSpy).not.toHaveBeenCalled();
    expect(setModel).toHaveBeenCalledWith({
      id: "new-model",
      provider: "test",
      contextWindow: 12000,
    });
    expect(entry.modelId).toBe("new-model");
    expect(entry.modelProvider).toBe("test");
  });

  it("passes model-switch lifecycle options through _compactWithModel", async () => {
    const coord = new SessionCoordinator({
      agentsDir,
      getAgent: () => ({ sessionDir: `${agentsDir}/hana/sessions` }),
      getActiveAgentId: () => "hana",
      getModels: () => null,
      getResourceLoader: () => null,
      getSkills: () => null,
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: () => {},
      getHomeCwd: () => "/tmp",
      agentIdFromSessionPath: () => null,
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => null,
      listAgents: () => [],
    });

    prepareCompactionMock.mockReturnValue({
      firstKeptEntryId: "entry-keep",
      tokensBefore: 4321,
      settings: { reserveTokens: 4000, keepRecentTokens: 5000 },
    });
    const compactedMessages = [{ role: "user", content: "after compaction" }];
    const emit = vi.fn();
    const session = {
      model: { id: "old-model", reasoning: false, contextWindow: 128000 },
      _emit: emit,
      extensionRunner: { hasHandlers: vi.fn(() => false) },
      sessionManager: {
        getBranch: vi.fn(() => [{ type: "message", id: "entry-old" }, { type: "message", id: "entry-keep" }]),
        appendCompaction: vi.fn(() => "compaction-entry"),
        buildSessionContext: vi.fn(() => ({ messages: compactedMessages })),
      },
      agent: {
        state: {
          systemPrompt: "system prompt",
          messages: [{ role: "user", content: "before compaction" }],
          thinkingLevel: "off",
        },
        streamFn: vi.fn(async () => ({
          result: vi.fn(async () => ({
            stopReason: "stop",
            content: [{ type: "text", text: "cache summary" }],
          })),
        })),
        convertToLlm: vi.fn(async (messages) => messages),
        replaceMessages: vi.fn(),
      },
    };
    (session as any).refreshContext = vi.fn(() => session.agent.replaceMessages(compactedMessages));

    const result = await coord._compactWithModel(session, 5000, session.model);

    expect(result.summary).toBe("cache summary");
    expect(emit).toHaveBeenNthCalledWith(1, { type: "compaction_start", reason: "model_switch" });
    expect(emit).toHaveBeenLastCalledWith({
      type: "compaction_end",
      reason: "model_switch",
      result: expect.objectContaining({ summary: "cache summary" }),
      aborted: false,
      willRetry: false,
    });
  });

  it("emits lifecycle and session_compact events for model-switch hard truncation", async () => {
    const coord = new SessionCoordinator({
      agentsDir,
      getAgent: () => ({ sessionDir: `${agentsDir}/hana/sessions` }),
      getActiveAgentId: () => "hana",
      getModels: () => null,
      getResourceLoader: () => null,
      getSkills: () => null,
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: () => {},
      getHomeCwd: () => "/tmp",
      agentIdFromSessionPath: () => null,
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => null,
      listAgents: () => [],
    });

    const branch = [
      { type: "message", id: "entry-old", message: { role: "user", content: "old context" } },
      { type: "message", id: "entry-keep", message: { role: "assistant", content: "keep this" } },
    ];
    const compactedMessages = [{ role: "compactionSummary", summary: "truncated" }];
    const compactionEntry = {
      type: "compaction",
      id: "compaction-entry",
      summary: "[由于模型切换，早期对话历史已被截断]",
    };
    const emit = vi.fn();
    const extensionEmit = vi.fn(async () => {});
    const appendCompaction = vi.fn(() => "compaction-entry");
    const replaceMessages = vi.fn();
    const session = {
      _emit: emit,
      extensionRunner: {
        hasHandlers: vi.fn((event) => event === "session_compact"),
        emit: extensionEmit,
      },
      sessionManager: {
        getBranch: vi.fn(() => branch),
        appendCompaction,
        getEntry: vi.fn(() => compactionEntry),
        buildSessionContext: vi.fn(() => ({ messages: compactedMessages })),
      },
      agent: { replaceMessages },
    };
    (session as any).refreshContext = vi.fn(() => replaceMessages(compactedMessages));

    const result = await coord._hardTruncate(session, 100);

    expect(result.details.reason).toBe("model-switch-truncation");
    expect(appendCompaction).toHaveBeenCalledWith(
      "[由于模型切换，早期对话历史已被截断]",
      "entry-keep",
      expect.any(Number),
      expect.objectContaining({ reason: "model-switch-truncation" }),
      false,
    );
    expect(replaceMessages).toHaveBeenCalledWith(compactedMessages);
    expect(extensionEmit).toHaveBeenCalledWith({
      type: "session_compact",
      compactionEntry,
      fromExtension: false,
    });
    expect(emit).toHaveBeenNthCalledWith(1, { type: "compaction_start", reason: "model_switch" });
    expect(emit).toHaveBeenLastCalledWith({
      type: "compaction_end",
      reason: "model_switch",
      result: expect.objectContaining({
        summary: "[由于模型切换，早期对话历史已被截断]",
      }),
      aborted: false,
      willRetry: false,
    });
  });

  it("falls back from xhigh to high when switching to a model without max thinking support", async () => {
    const coord = new SessionCoordinator({
      agentsDir,
      getAgent: () => ({ sessionDir: `${agentsDir}/hana/sessions` }),
      getActiveAgentId: () => "hana",
      getModels: () => null,
      getResourceLoader: () => null,
      getSkills: () => null,
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: () => {},
      getHomeCwd: () => "/tmp",
      agentIdFromSessionPath: () => null,
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "xhigh" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => null,
      listAgents: () => [],
    });
    (vi.spyOn(coord, "writeSessionMeta").mockResolvedValue as any)();

    const setModel = vi.fn(async () => {});
    const setThinkingLevel = vi.fn();
    const entry = {
      session: {
        model: { id: "max-model", provider: "test", contextWindow: 64000, xhigh: true },
        isCompacting: false,
        getContextUsage: () => ({ tokens: 1000 }),
        agent: { state: { messages: [] } },
        setModel,
        setThinkingLevel,
      },
      modelId: "max-model",
      modelProvider: "test",
      thinkingLevel: "xhigh",
    };
    coord.sessions.set(sessionPath, entry);

    const result = await coord.switchSessionModel(sessionPath, {
      id: "regular-model",
      provider: "test",
      contextWindow: 64000,
    });

    expect(result).toEqual({ adaptations: [], thinkingLevel: "high" });
    expect(setModel).toHaveBeenCalledOnce();
    expect(setThinkingLevel).toHaveBeenCalledWith("high");
    expect(entry.thinkingLevel).toBe("high");
    expect(coord.writeSessionMeta).toHaveBeenCalledWith(sessionPath, expect.objectContaining({
      thinkingLevel: "high",
    }));
  });
});
