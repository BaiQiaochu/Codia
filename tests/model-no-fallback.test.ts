// @ts-nocheck
/**
  *
 *
  * */

import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "../server/i18n.js";

const { createAgentSessionMock, sessionManagerCreateMock } = vi.hoisted(() => ({
  createAgentSessionMock: vi.fn(),
  sessionManagerCreateMock: vi.fn(),
}));

vi.mock("../lib/pi-sdk/index.js", () => ({
  createAgentSession: createAgentSessionMock,
  SessionManager: {
    create: sessionManagerCreateMock,
    open: vi.fn(),
  },
  SettingsManager: {
    inMemory: vi.fn(() => ({})),
  },
}));

vi.mock("../lib/debug-log.js", () => ({
  createModuleLogger: () => ({
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { SessionCoordinator } from "../core/session-coordinator.js";

function makeModels(list = []) {
  return {
    authStorage: {},
    modelRegistry: {},
    defaultModel: list[0] || null,
    availableModels: list,
    resolveExecutionModel: (m) => m,
    resolveThinkingLevel: () => "medium",
    inferModelProvider: () => null,
  };
}

function makeCoordinator(tempDir, { agentConfig = {}, models = makeModels() } = {}) {
  sessionManagerCreateMock.mockReturnValue({ getCwd: () => tempDir });
  createAgentSessionMock.mockResolvedValue({
    session: {
      sessionManager: { getSessionFile: () => path.join(tempDir, "s.jsonl") },
      subscribe: vi.fn(() => vi.fn()),
      abort: vi.fn(),
    },
  });

  return new SessionCoordinator({
    agentsDir: tempDir,
    getAgent: () => ({
      agentDir: tempDir,
      sessionDir: tempDir,
      agentName: "test-agent",
      config: agentConfig,
      tools: [],
    }),
    getActiveAgentId: () => "test",
    getModels: () => models,
    getResourceLoader: () => ({ getSystemPrompt: () => "prompt" }),
    getSkills: () => ({ getSkillsForAgent: () => [] }),
    buildTools: () => ({ tools: [], customTools: [] }),
    emitEvent: () => {},
    getHomeCwd: () => tempDir,
    agentIdFromSessionPath: () => null,
    switchAgentOnly: async () => {},
    getConfig: () => ({}),
    getPrefs: () => ({ getThinkingLevel: () => "medium" }),
    getAgents: () => new Map(),
    getActivityStore: () => null,
    getAgentById: (id) => ({
      agentDir: tempDir,
      sessionDir: tempDir,
      agentName: id,
      config: agentConfig,
      tools: [],
    }),
    listAgents: () => [],
  });
}

describe("model selection without fallback", () => {
  let tempDir;

  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codia-model-nofallback-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("resolveModel", () => {
    it("returns the configured model when it exists", () => {
      const models = makeModels([
        { id: "qwen3.5-plus", provider: "dashscope" },
        { id: "gpt-5", provider: "openai" },
      ]);
      const coord = makeCoordinator(tempDir, {
        agentConfig: { models: { chat: { id: "qwen3.5-plus", provider: "dashscope" } } },
        models,
      });
      const ctx = coord.createSessionContext();
      const result = ctx.resolveModel({ models: { chat: { id: "qwen3.5-plus", provider: "dashscope" } } });
      expect(result).toEqual({ id: "qwen3.5-plus", provider: "dashscope" });
    });

    it("falls back to defaultModel when models.chat is not configured", () => {
      const coord = makeCoordinator(tempDir, {
        agentConfig: {},
        models: makeModels([{ id: "some-model", provider: "x" }]),
      });
      const ctx = coord.createSessionContext();
      expect(ctx.resolveModel({})).toEqual({ id: "some-model", provider: "x" });
      expect(ctx.resolveModel({ models: {} })).toEqual({ id: "some-model", provider: "x" });
    });

    it("throws when models.chat and defaultModel are both missing", () => {
      const coord = makeCoordinator(tempDir, {
        agentConfig: {},
        models: makeModels([]),
      });
      const ctx = coord.createSessionContext();
      expect(() => ctx.resolveModel({})).toThrow(t("error.resolveModelNoChatModel"));
    });

    it("falls back to defaultModel when the configured model is unavailable", () => {
      const models = makeModels([
        { id: "gpt-5", provider: "openai" },
        { id: "MiniMax-M2", provider: "minimax" },
      ]);
      const coord = makeCoordinator(tempDir, { models });
      const ctx = coord.createSessionContext();
      expect(ctx.resolveModel({ models: { chat: { id: "qwen3.5-plus", provider: "dashscope" } } }))
        .toEqual({ id: "gpt-5", provider: "openai" });
    });

    it("throws when the configured model is unavailable and no defaultModel exists", () => {
      const models = { ...makeModels([]), defaultModel: null };
      const coord = makeCoordinator(tempDir, { models });
      const ctx = coord.createSessionContext();
      expect(() => ctx.resolveModel({ models: { chat: { id: "qwen3.5-plus", provider: "dashscope" } } }))
        .toThrow(t("error.resolveModelNotAvailable", { id: "dashscope/qwen3.5-plus" }));
    });

    it("throws when availableModels is empty", () => {
      const coord = makeCoordinator(tempDir, { models: makeModels([]) });
      const ctx = coord.createSessionContext();
      expect(() => ctx.resolveModel({ models: { chat: { id: "qwen3.5-plus", provider: "dashscope" } } }))
        .toThrow(t("error.resolveModelNotAvailable", { id: "dashscope/qwen3.5-plus" }));
    });
  });

  describe("executeIsolated", () => {
    it("agent submit throws when no chat model or default model is configured", async () => {
      const coord = makeCoordinator(tempDir, {
        agentConfig: {},
        models: makeModels([]),
      });
      const result = await coord.executeIsolated("hello");
      expect(result.error).toContain(t("error.executeIsolatedNoModel", { name: "test-agent" }));
    });

    it("agent submit throws when configured model is unavailable and no default model exists", async () => {
      const coord = makeCoordinator(tempDir, {
        agentConfig: { models: { chat: { id: "nonexistent-model", provider: "dashscope" } } },
        models: { ...makeModels([]), defaultModel: null },
      });
      const result = await coord.executeIsolated("hello");
      expect(result.error).toContain(t("error.executeIsolatedNoModel", { name: "test-agent" }));
    });

    it("agent submit runs when model resolution succeeds", async () => {
      const coord = makeCoordinator(tempDir, {
        agentConfig: { models: { chat: { id: "qwen3.5-plus", provider: "dashscope" } } },
        models: makeModels([{ id: "qwen3.5-plus", provider: "dashscope" }]),
      });

      createAgentSessionMock.mockResolvedValue({
        session: {
          sessionManager: { getSessionFile: () => path.join(tempDir, "s.jsonl") },
          subscribe: vi.fn(() => vi.fn()),
          prompt: vi.fn(),
        },
      });

      const result = await coord.executeIsolated("hello");
      expect(result.error).toBeFalsy();
      expect(createAgentSessionMock).toHaveBeenCalledOnce();
      expect(createAgentSessionMock.mock.calls[0][0].model).toEqual({
        id: "qwen3.5-plus",
        provider: "dashscope",
      });
    });

    it("uses opts.model directly without looking up config", async () => {
      const explicitModel = { id: "explicit", provider: "test" };
      const coord = makeCoordinator(tempDir, {
        agentConfig: {},
        models: makeModels([explicitModel]),
      });

      createAgentSessionMock.mockResolvedValue({
        session: {
          sessionManager: { getSessionFile: () => path.join(tempDir, "s.jsonl") },
          subscribe: vi.fn(() => vi.fn()),
          prompt: vi.fn(),
        },
      });

      const result = await coord.executeIsolated("hello", { model: explicitModel });
      expect(result.error).toBeFalsy();
    });
  });

  describe("resolveUtilityConfig", () => {
    let ModelManager;
    let ExecutionRouter;

    beforeEach(async () => {
      const mod = await import("../core/model-manager.js");
      ModelManager = mod.ModelManager;
      const routerMod = await import("../core/execution-router.js");
      ExecutionRouter = routerMod.ExecutionRouter;
    });

    function setupRouter(mm) {
      mm.executionRouter = new ExecutionRouter(
        (ref) => {
          if (!ref) return null;
          if (typeof ref === "object" && ref.id && ref.provider) {
            return mm._availableModels.find((m) => m.id === ref.id && m.provider === ref.provider);
          }
          return null;
        },
        {
          getCredentials: (provider) => {
            const model = mm._availableModels.find((m) => m.provider === provider);
            if (!model?._cred) return null;
            return model._cred;
          },
        },
      );
    }

    it("throws when utility is not configured", () => {
      const mm = new ModelManager({ codiaHome: tempDir });
      setupRouter(mm);
      expect(() => mm.resolveUtilityConfig({}, {}, {})).toThrow(t("error.noUtilityModel"));
    });

    it("throws when utility_large is not configured", () => {
      const mm = new ModelManager({ codiaHome: tempDir });
      setupRouter(mm);
      mm._availableModels = [{ id: "some-model", provider: "x" }];
      expect(() => mm.resolveUtilityConfig({}, { utility: { id: "some-model", provider: "x" } }, {}))
        .toThrow(t("error.noUtilityLargeModel"));
    });

    it("returns both utility and utility_large when both are configured", () => {
      const mm = new ModelManager({ codiaHome: tempDir });
      mm._availableModels = [
        { id: "util-model", provider: "test-provider", _cred: { api: "openai-completions", apiKey: "sk-test", baseUrl: "https://test.example.com/v1" } },
        { id: "large-model", provider: "test-provider", _cred: { api: "openai-completions", apiKey: "sk-test", baseUrl: "https://test.example.com/v1" } },
      ];
      setupRouter(mm);
      const result = mm.resolveUtilityConfig(
        {},
        {
          utility: { id: "util-model", provider: "test-provider" },
          utility_large: { id: "large-model", provider: "test-provider" },
        },
        {},
      );
      expect(result.utility).toMatchObject({ id: "util-model", provider: "test-provider" });
      expect(result.utility_large).toMatchObject({ id: "large-model", provider: "test-provider" });
      expect(result.api_key).toBe("sk-test");
      expect(result.api).toBe("openai-completions");
    });

    it("throws when utility_api provider does not match the model provider", () => {
      const mm = new ModelManager({ codiaHome: tempDir });
      mm._availableModels = [
        { id: "util-model", provider: "test-provider", _cred: { api: "openai-completions", apiKey: "sk-test", baseUrl: "https://test.example.com/v1" } },
        { id: "large-model", provider: "test-provider", _cred: { api: "openai-completions", apiKey: "sk-test", baseUrl: "https://test.example.com/v1" } },
      ];
      setupRouter(mm);
      expect(() => mm.resolveUtilityConfig(
        {},
        {
          utility: { id: "util-model", provider: "test-provider" },
          utility_large: { id: "large-model", provider: "test-provider" },
        },
        { provider: "openai", api_key: "sk-test", base_url: "https://api.openai.com/v1" },
      )).toThrow(t("error.utilityApiProviderMismatch", { model: { id: "util-model", provider: "test-provider" } }));
    });
  });
});
