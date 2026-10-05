// @ts-nocheck
import { describe, expect, it, vi } from "vitest";
import { SessionCoordinator } from "../core/session-coordinator.ts";

function makeCoordinator(memoryTicker = { notifySessionEnd: vi.fn(async () => {}) }) {
  const agent = { id: "test-agent", _memoryTicker: memoryTicker };
  return new SessionCoordinator({
    agentsDir: "/tmp/fake/agents",
    getAgent: () => agent,
    getAgentById: () => agent,
    getActiveAgentId: () => "test-agent",
    agentIdFromSessionPath: () => "test-agent",
    getConfirmStore: () => ({ abortBySession: vi.fn() }),
    getDeferredResultStore: () => ({ clearBySession: vi.fn() }),
    closeTerminalsForSession: vi.fn(),
    onSessionRuntimeDiscarded: vi.fn(),
  });
}

describe("SessionCoordinator discardSessionRuntime", () => {
  it("skips memory session-end notification when requested", async () => {
    const memoryTicker = { notifySessionEnd: vi.fn(async () => {}) };
    const coord = makeCoordinator(memoryTicker);
    const sessionPath = "/tmp/fake/agents/test-agent/sessions/a.jsonl";
    coord.sessions.set(sessionPath, {
      session: { isStreaming: false },
      agentId: "test-agent",
      lastTouchedAt: 0,
    });
    coord._teardownSessionEntry = vi.fn(async () => {});
    coord._notifySessionRuntimeDiscarded = vi.fn(async () => {});

    const discarded = await coord.discardSessionRuntime(sessionPath, "parent session archived", { skipMemory: true });

    expect(discarded).toBe(true);
    expect(memoryTicker.notifySessionEnd).not.toHaveBeenCalled();
    expect(coord._teardownSessionEntry).toHaveBeenCalledWith(expect.anything(), sessionPath, "parent session archived");
    expect(coord.sessions.has(sessionPath)).toBe(false);
  });

  it("keeps closeSession memory behavior through discardSessionRuntime", async () => {
    const memoryTicker = { notifySessionEnd: vi.fn(async () => {}) };
    const coord = makeCoordinator(memoryTicker);
    const sessionPath = "/tmp/fake/agents/test-agent/sessions/a.jsonl";
    coord.sessions.set(sessionPath, {
      session: { isStreaming: false },
      agentId: "test-agent",
      lastTouchedAt: 0,
    });
    coord._teardownSessionEntry = vi.fn(async () => {});
    coord._notifySessionRuntimeDiscarded = vi.fn(async () => {});

    await coord.closeSession(sessionPath);

    expect(memoryTicker.notifySessionEnd).toHaveBeenCalledWith(sessionPath);
  });
});
