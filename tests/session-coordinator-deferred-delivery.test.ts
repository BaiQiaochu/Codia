// @ts-nocheck
import { describe, expect, it, vi } from "vitest";

import { SessionCoordinator } from "../core/session-coordinator.ts";

function makeCoordinator( overrides: any = {}) {
  return new SessionCoordinator({
    agentsDir: "/tmp/fake/agents",
    getAgent: () => ({ id: "test-agent" }),
    getActiveAgentId: () => "test-agent",
    getModels: () => ({}),
    getResourceLoader: () => ({}),
    getSkills: () => ({}),
    buildTools: () => ({ tools: [], customTools: [] }),
    emitEvent: () => {},
    getHomeCwd: () => "/tmp",
    agentIdFromSessionPath: () => "test-agent",
    switchAgentOnly: async () => {},
    getConfig: () => ({}),
    getAgents: () => new Map(),
    getActivityStore: () => ({}),
    getAgentById: () => ({ id: "test-agent" }),
    listAgents: () => [],
    getPrefs: () => ({ getThinkingLevel: () => "medium" }),
    ...overrides,
  });
}

function makeSession({ isStreaming }) {
  return {
    isStreaming,
    sendCustomMessage: vi.fn().mockResolvedValue(undefined),
  };
}

describe("SessionCoordinator deferred custom delivery", () => {
  it("wakes an idle live session with triggerTurn instead of steer", async () => {
    const coord = makeCoordinator();
    const session = makeSession({ isStreaming: false });
    const sessionPath = "/tmp/fake/agents/test-agent/sessions/a.jsonl";
    coord.sessions.set(sessionPath, {
      session,
      agentId: "test-agent",
      lastTouchedAt: 0,
    });
    coord.steerSession = vi.fn();

    const result = await coord.deliverCustomMessage(sessionPath, {
      customType: "codia-background-result",
      content: "<codia-background-result />",
      display: false,
    });

    expect(result).toMatchObject({ ok: true, mode: "triggerTurn" });
    expect(session.sendCustomMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: "codia-background-result", display: false }),
      { triggerTurn: true },
    );
    expect(coord.steerSession).not.toHaveBeenCalled();
  });

  it("queues custom delivery as a follow-up when the session is currently streaming", async () => {
    const coord = makeCoordinator();
    const session = makeSession({ isStreaming: true });
    const sessionPath = "/tmp/fake/agents/test-agent/sessions/a.jsonl";
    coord.sessions.set(sessionPath, {
      session,
      agentId: "test-agent",
      lastTouchedAt: 0,
    });

    const result = await coord.deliverCustomMessage(sessionPath, {
      customType: "codia-background-result",
      content: "<codia-background-result />",
      display: false,
    });

    expect(result).toMatchObject({ ok: true, mode: "followUp" });
    expect(session.sendCustomMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: "codia-background-result", display: false }),
      { deliverAs: "followUp" },
    );
  });

  it("cold-loads an unloaded session before delivering the custom message", async () => {
    const coord = makeCoordinator();
    const session = makeSession({ isStreaming: false });
    const sessionPath = "/tmp/fake/agents/test-agent/sessions/cold.jsonl";
    coord.ensureSessionLoaded = vi.fn(async (sessionPath) => {
      coord.sessions.set(sessionPath, {
        session,
        agentId: "test-agent",
        lastTouchedAt: 0,
      });
      return session;
    });

    const result = await coord.deliverCustomMessage(sessionPath, {
      customType: "codia-background-result",
      content: "<codia-background-result />",
      display: false,
    });

    expect(result).toMatchObject({ ok: true, mode: "triggerTurn" });
    expect(coord.ensureSessionLoaded).toHaveBeenCalledWith(sessionPath);
    expect(session.sendCustomMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: "codia-background-result", display: false }),
      { triggerTurn: true },
    );
  });

  it("refuses to cold-load archived sessions for custom delivery", async () => {
    const coord = makeCoordinator();
    coord.ensureSessionLoaded = vi.fn();
    const archivedPath = "/tmp/fake/agents/test-agent/sessions/archived/cold.jsonl";

    await expect(
      coord.deliverCustomMessage(archivedPath, {
        customType: "codia-background-result",
        content: "<codia-background-result />",
        display: false,
      }),
    ).rejects.toThrow(/active desktop session/);

    expect(coord.ensureSessionLoaded).not.toHaveBeenCalled();
  });

  it("can deliver a notification without triggering a parent turn", async () => {
    const coord = makeCoordinator();
    const session = makeSession({ isStreaming: false });
    const sessionPath = "/tmp/fake/agents/test-agent/sessions/a.jsonl";
    coord.sessions.set(sessionPath, {
      session,
      agentId: "test-agent",
      lastTouchedAt: 0,
    });

    const result = await coord.deliverCustomMessage(
      sessionPath,
      {
        customType: "codia-background-result",
        content: "<codia-background-result />",
        display: false,
      },
      { triggerTurn: false },
    );

    expect(result).toMatchObject({ ok: true, mode: "notifyOnly" });
    expect(session.sendCustomMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: "codia-background-result", display: false }),
      { triggerTurn: false },
    );
  });

  it("records non-context custom entries on a live session manager without sending a custom message", () => {
    const coord = makeCoordinator();
    const session = makeSession({ isStreaming: false });
    (session as any).sessionManager = {
      appendCustomEntry: vi.fn(),
    };
    const sessionPath = "/tmp/fake/agents/test-agent/sessions/a.jsonl";
    coord.sessions.set(sessionPath, {
      session,
      agentId: "test-agent",
      lastTouchedAt: 0,
    });

    const result = coord.recordCustomEntry(sessionPath, "codia-deferred-result", {
      taskId: "task-img",
    });

    expect(result).toMatchObject({ ok: true, mode: "live" });
    expect((session as any).sessionManager.appendCustomEntry).toHaveBeenCalledWith(
      "codia-deferred-result",
      { taskId: "task-img" },
    );
    expect(session.sendCustomMessage).not.toHaveBeenCalled();
  });
});
