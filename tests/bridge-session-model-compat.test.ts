// @ts-nocheck
import fs from "fs";
import os from "os";
import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { createAgentSessionMock, sessionManagerCreateMock, sessionManagerOpenMock } = vi.hoisted(() => ({
  createAgentSessionMock: vi.fn(),
  sessionManagerCreateMock: vi.fn(),
  sessionManagerOpenMock: vi.fn(),
}));

vi.mock("../lib/pi-sdk/index.js", () => ({
  createAgentSession: createAgentSessionMock,
  emitSessionShutdown: vi.fn(),
  SessionManager: {
    create: sessionManagerCreateMock,
    open: sessionManagerOpenMock,
  },
  SettingsManager: {
    inMemory: vi.fn(() => ({})),
  },
}));

vi.mock("../lib/debug-log.js", () => ({
  debugLog: () => null,
  createModuleLogger: () => ({
    log: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

describe("BridgeSessionManager model compatibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("accepts legacy string chat model refs for bridge sessions", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-model-compat-"));
    const sessionDir = path.join(tempRoot, "sessions");
    fs.mkdirSync(sessionDir, { recursive: true });
    const bridgeSessionFile = path.join(sessionDir, "bridge", "owner", "bridge.jsonl");
    fs.mkdirSync(path.dirname(bridgeSessionFile), { recursive: true });

    sessionManagerCreateMock.mockReturnValue({
      getSessionFile: () => bridgeSessionFile,
    });
    createAgentSessionMock.mockResolvedValue({
      session: {
        model: { id: "gpt-4o", provider: "openai", vision: false },
        sessionManager: { getSessionFile: () => bridgeSessionFile },
        subscribe: vi.fn(() => vi.fn()),
        prompt: vi.fn(async () => {}),
        isStreaming: false,
      },
    });

    const { BridgeSessionManager } = await import("../core/bridge-session-manager.js");
    const chatModel = { id: "gpt-4o", provider: "openai", vision: false };
    const mm = {
      availableModels: [chatModel],
      authStorage: {},
      modelRegistry: {},
      resolveExecutionModel: vi.fn((ref) => {
        if (ref === "openai/gpt-4o") return chatModel;
        return null;
      }),
      resolveThinkingLevel: vi.fn(() => "medium"),
    };

    const mgr = new BridgeSessionManager({
      getAgent: () => ({
        id: "agent-a",
        agentName: "Agent A",
        agentDir: tempRoot,
        sessionDir,
        yuanPrompt: "yuan",
        publicIshiki: "ishiki",
        buildSystemPrompt: () => "prompt",
        tools: [],
        config: { models: { chat: "openai/gpt-4o" }, bridge: {} },
      }),
      getAgentById: () => null,
      getModelManager: () => mm,
      getResourceLoader: () => ({ getSystemPrompt: () => "prompt", getSkills: () => ({ skills: [], diagnostics: [] }) }),
      getPreferences: () => ({ thinking_level: "auto" }),
      buildTools: () => ({ tools: [], customTools: [] }),
      getHomeCwd: () => tempRoot,
    });

    const result = await mgr.executeExternalMessage("hello", "wx_dm_owner@agent-a", { userId: "owner" }, { agentId: "agent-a" });

    expect(mm.resolveExecutionModel).toHaveBeenCalledWith("openai/gpt-4o");
    expect(createAgentSessionMock).toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it("falls back to the current default model when models.chat is missing", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-model-fallback-"));
    const sessionDir = path.join(tempRoot, "sessions");
    fs.mkdirSync(sessionDir, { recursive: true });
    const bridgeSessionFile = path.join(sessionDir, "bridge", "owner", "bridge.jsonl");
    fs.mkdirSync(path.dirname(bridgeSessionFile), { recursive: true });

    sessionManagerCreateMock.mockReturnValue({
      getSessionFile: () => bridgeSessionFile,
    });
    createAgentSessionMock.mockResolvedValue({
      session: {
        model: { id: "gpt-4o-mini", provider: "openai", vision: false },
        sessionManager: { getSessionFile: () => bridgeSessionFile },
        subscribe: vi.fn(() => vi.fn()),
        prompt: vi.fn(async () => {}),
        isStreaming: false,
      },
    });

    const { BridgeSessionManager } = await import("../core/bridge-session-manager.js");
    const defaultModel = { id: "gpt-4o-mini", provider: "openai", vision: false };
    const mm = {
      availableModels: [defaultModel],
      authStorage: {},
      modelRegistry: {},
      currentModel: defaultModel,
      resolveExecutionModel: vi.fn((ref) => {
        if (!ref) return defaultModel;
        return null;
      }),
      resolveThinkingLevel: vi.fn(() => "medium"),
    };

    const mgr = new BridgeSessionManager({
      getAgent: () => ({
        id: "agent-b",
        agentName: "Agent B",
        agentDir: tempRoot,
        sessionDir,
        yuanPrompt: "yuan",
        publicIshiki: "ishiki",
        buildSystemPrompt: () => "prompt",
        tools: [],
        config: { models: {}, bridge: {} },
      }),
      getAgentById: () => null,
      getModelManager: () => mm,
      getResourceLoader: () => ({ getSystemPrompt: () => "prompt", getSkills: () => ({ skills: [], diagnostics: [] }) }),
      getPreferences: () => ({ thinking_level: "auto" }),
      buildTools: () => ({ tools: [], customTools: [] }),
      getHomeCwd: () => tempRoot,
    });

    const result = await mgr.executeExternalMessage("hello", "wx_dm_owner@agent-b", { userId: "owner" }, { agentId: "agent-b" });

    expect(mm.resolveExecutionModel).toHaveBeenCalledWith(undefined);
    expect(createAgentSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: defaultModel,
      }),
    );
    expect(result).toBeNull();
  });

  it("passes bridge read-only permission mode into owner tools", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-read-only-"));
    const sessionDir = path.join(tempRoot, "sessions");
    const { BridgeSessionManager } = await import("../core/bridge-session-manager.js");
    const chatModel = { id: "gpt-4o", provider: "openai", input: ["text"] };
    const buildTools = vi.fn(() => ({ tools: [], customTools: [] }));
    const agent = {
      id: "agent-c",
      agentName: "Agent C",
      agentDir: tempRoot,
      sessionDir,
      buildSystemPrompt: () => "prompt",
      getToolsSnapshot: vi.fn(() => []),
      memoryMasterEnabled: true,
      config: { models: { chat: { id: "gpt-4o", provider: "openai" } } },
    };
    const mm = {
      availableModels: [chatModel],
      resolveExecutionModel: vi.fn(() => chatModel),
      resolveThinkingLevel: vi.fn(() => "medium"),
    };

    const mgr = new BridgeSessionManager({
      getAgent: () => agent,
      getAgentById: () => agent,
      getModelManager: () => mm,
      getResourceLoader: () => ({ getSystemPrompt: () => "prompt", getSkills: () => ({ skills: [], diagnostics: [] }) }),
      getPreferences: () => ({ bridge: { readOnly: true }, thinking_level: "auto" }),
      buildTools,
      getHomeCwd: () => tempRoot,
    });

    mgr._buildOwnerSessionOpts(agent, mm, tempRoot);

    expect(buildTools).toHaveBeenCalledWith(
      tempRoot,
      [],
      expect.objectContaining({
        workspace: tempRoot,
        agentDir: tempRoot,
        getPermissionMode: expect.any(Function),
      }),
    );
    const opts = buildTools.mock.calls[0][2];
    expect(opts.getPermissionMode()).toBe("read_only");
  });

  it("injects visual context through the bridge resource loader extension", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-vision-context-"));
    const sessionDir = path.join(tempRoot, "sessions");
    const bridgeSessionFile = path.join(sessionDir, "bridge", "owner", "bridge.jsonl");
    fs.mkdirSync(path.dirname(bridgeSessionFile), { recursive: true });
    const { BridgeSessionManager } = await import("../core/bridge-session-manager.js");
    const chatModel = { id: "deepseek-chat", provider: "deepseek", input: ["text"] };
    const visionBridge = {
      prepareResources: vi.fn(async ({ resources }) => ({
        notes: resources.map((resource) => ({
          key: resource.key,
          label: resource.label,
          note: "image_overview: bridge screenshot",
        })),
      })),
      injectNotes: vi.fn((messages) => ({ messages, injected: 0 })),
    };
    const agent = {
      id: "agent-d",
      agentName: "Agent D",
      agentDir: tempRoot,
      sessionDir,
      buildSystemPrompt: () => "prompt",
      getToolsSnapshot: vi.fn(() => []),
      memoryMasterEnabled: true,
      config: { models: { chat: { id: "deepseek-chat", provider: "deepseek" } } },
    };
    const mm = {
      availableModels: [chatModel],
      resolveExecutionModel: vi.fn(() => chatModel),
      resolveThinkingLevel: vi.fn(() => "medium"),
    };
    const mgr = new BridgeSessionManager({
      getAgent: () => agent,
      getAgentById: () => agent,
      getModelManager: () => mm,
      getResourceLoader: () => ({ getSystemPrompt: () => "prompt", getSkills: () => ({ skills: [], diagnostics: [] }) }),
      getPreferences: () => ({ thinking_level: "auto" }),
      buildTools: () => ({ tools: [], customTools: [] }),
      getHomeCwd: () => tempRoot,
      getVisionBridge: () => visionBridge,
      isVisionAuxiliaryEnabled: () => true,
    });

    const sessionOpts = mgr._buildOwnerSessionOpts(agent, mm, tempRoot, { current: bridgeSessionFile });
    const { extensions } = sessionOpts.resourceLoader.getExtensions();
    const contextHandler = extensions[0].handlers.get("context")[0];
    const messages = [
      { role: "user", content: "review the screenshot" },
      {
        role: "toolResult",
        content: [
          { type: "text", text: "screenshot captured" },
          { type: "image", mimeType: "image/png", data: "SCREENSHOT_BASE64" },
        ],
      },
    ];

    const result = await contextHandler({ messages }, { model: chatModel });

    expect(visionBridge.prepareResources).toHaveBeenCalledOnce();
    expect(result.messages[1].content[0].text).toContain("<vision-context>");
    expect(result.messages[1].content[0].text).toContain("image_overview: bridge screenshot");
  });
});
