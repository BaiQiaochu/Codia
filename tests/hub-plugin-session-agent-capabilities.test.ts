import { describe, expect, it, vi } from "vitest";

import { Hub } from "../hub/index.ts";

function createEngine(overrides: any = {}) {
  const engine: any = {
    agentsDir: "/agents",
    currentAgentId: "agent-a",
    setHubCallbacks: vi.fn(),
    setEventBus: vi.fn(),
    isSessionStreaming: vi.fn(() => false),
    promptSession: vi.fn(async () => {}),
    abortSession: vi.fn(async () => true),
    ensureSessionLoaded: vi.fn(async () => ({ sessionManager: { getCwd: () => "/work" } })),
    getSessionWorkspaceFolders: vi.fn(() => ["/work"]),
    getSessionAuthorizedFolders: vi.fn(() => ["/work"]),
    getSessionThinkingLevel: vi.fn(() => "medium"),
    getSessionPermissionMode: vi.fn(() => "default"),
    listSessions: vi.fn(async () => [{
      path: "/agents/agent-a/sessions/s.jsonl",
      title: "S",
      agentId: "agent-a",
      agentName: "Agent A",
      cwd: "/work",
    }]),
    createSession: vi.fn(async () => ({ sessionPath: "/agents/agent-a/sessions/new.jsonl", agentId: "agent-a" })),
    createSessionForAgent: vi.fn(async () => ({ sessionPath: "/agents/agent-b/sessions/new.jsonl", agentId: "agent-b" })),
    createDetachedSession: vi.fn(async () => ({ sessionPath: "/agents/agent-b/sessions/new.jsonl", agentId: "agent-b" })),
    setSessionPinned: vi.fn(async () => "2026-06-07T00:00:00.000Z"),
    setSessionProjectAssignment: vi.fn(async () => ({})),
    setSessionThinkingLevel: vi.fn(async (_sessionPath, level) => ({ ok: true, thinkingLevel: level })),
    setSessionPermissionModeForSession: vi.fn(() => ({ ok: true, permissionMode: "read-only" })),
    listAgents: vi.fn(() => [{
      id: "agent-a",
      name: "Agent A",
      yuan: "gsap",
      identity: "public intro",
      plugin: { ownerPluginId: null, visibility: "public" },
      isCurrent: true,
      isPrimary: true,
    }]),
    getAgent: vi.fn((agentId) => agentId === "agent-a"
      ? {
        id: "agent-a",
        agentName: "Agent A",
        config: { agent: { name: "Agent A", yuan: "gsap" }, plugin: { visibility: "public" } },
        personality: "identity text",
        memoryMasterEnabled: true,
        experienceEnabled: false,
      }
      : null),
    createAgent: vi.fn(async ({ name, id }) => ({ id: id || "plugin-agent", name })),
    updateConfig: vi.fn(async () => ({})),
    invalidateAgentListCache: vi.fn(),
    providerRegistry: {
      getCredentials: vi.fn(),
      getModelsByType: vi.fn(() => []),
      getAllModelsByType: vi.fn(() => []),
      getMediaProviders: vi.fn(() => []),
      getMediaProviderCredentialStatus: vi.fn(() => ({
        hasCredentials: true,
        lanes: [],
        activeLaneId: null,
        activeProviderId: null,
      })),
    },
    ...overrides,
  };
  return engine;
}

describe("Hub plugin-facing session and agent capabilities", () => {
  it("creates plugin-owned sessions through the detached engine session creation API", async () => {
    const engine = createEngine();
    const hub = new Hub({ engine });

    const result = await hub.eventBus.request("session:create", {
      agentId: "agent-b",
      cwd: "/work",
      memoryEnabled: false,
      ownerPluginId: "tavern",
      kind: "tavern",
      visibility: "plugin_private",
    });

    expect(result).toMatchObject({
      sessionPath: "/agents/agent-b/sessions/new.jsonl",
      agentId: "agent-b",
      ownerPluginId: "tavern",
      kind: "tavern",
      visibility: "plugin_private",
    });
    expect(engine.createDetachedSession).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-b",
        cwd: "/work",
        memoryEnabled: false,
        ownerPluginId: "tavern",
        sessionKind: "tavern",
        sessionVisibility: "plugin_private",
      }),
    );
    expect(engine.createSessionForAgent).not.toHaveBeenCalled();
  });

  it("updates session metadata without writing conversation history directly", async () => {
    const engine = createEngine();
    const hub = new Hub({ engine });

    const result = await hub.eventBus.request("session:update", {
      sessionPath: "/agents/agent-a/sessions/s.jsonl",
      pinned: true,
      projectId: "project-a",
      thinkingLevel: "high",
      permissionMode: "read-only",
      visibility: "plugin_private",
    });

    expect(result.ok).toBe(true);
    expect(engine.setSessionPinned).toHaveBeenCalledWith("/agents/agent-a/sessions/s.jsonl", true);
    expect(engine.setSessionProjectAssignment).toHaveBeenCalledWith({
      sessionPath: "/agents/agent-a/sessions/s.jsonl",
      projectId: "project-a",
    });
    expect(engine.setSessionThinkingLevel).toHaveBeenCalledWith("/agents/agent-a/sessions/s.jsonl", "high");
    expect(engine.setSessionPermissionModeForSession).toHaveBeenCalledWith("/agents/agent-a/sessions/s.jsonl", "read-only");
  });

  it("returns public agent profiles and creates plugin-owned agents", async () => {
    const engine = createEngine();
    const hub = new Hub({ engine });

    await expect(hub.eventBus.request("agent:profile", { agentId: "agent-a" })).resolves.toMatchObject({
      profile: {
        id: "agent-a",
        name: "Agent A",
        memoryPolicy: { enabled: true },
      },
    });

    const created = await hub.eventBus.request("agent:create", {
      name: "Tavern Character",
      ownerPluginId: "tavern",
      visibility: "plugin_private",
    });

    expect(created).toMatchObject({
      agent: {
        id: "plugin-agent",
        name: "Tavern Character",
        ownerPluginId: "tavern",
        visibility: "plugin_private",
      },
    });
    expect(engine.createAgent).toHaveBeenCalledWith(expect.objectContaining({
      name: "Tavern Character",
    }));
    expect(engine.updateConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        plugin: expect.objectContaining({
          ownerPluginId: "tavern",
          visibility: "plugin_private",
        }),
      }),
      { agentId: "plugin-agent" },
    );
  });
});
