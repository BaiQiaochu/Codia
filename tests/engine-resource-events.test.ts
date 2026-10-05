import path from "path";
import { describe, expect, it, vi } from "vitest";
import { GsapEngine } from "../core/engine.ts";

describe("GsapEngine ResourceEvent emission", () => {
  it("emits agent SessionFile writes as resource.changed without a legacy app-event projection", () => {
    const engine = Object.create(GsapEngine.prototype);
    const listener = vi.fn();
    engine._eventBus = null;
    engine._listeners = new Set([listener]);
    const sessionPath = path.join("/sessions", "a.jsonl");
    const filePath = path.join("/workspace", "draft.md");
    const file = {
      id: "sf_created",
      sessionPath,
      filePath,
      realPath: filePath,
      origin: "agent_write",
      operations: ["created"],
      mtimeMs: 123,
      size: 5,
    };
    engine.registerSessionFile = vi.fn(() => file);

    const result = engine.recordSessionFileOperation({
      sessionPath,
      filePath,
      origin: "agent_write",
      operation: "created",
    });

    expect(result).toBe(file);
    const events = listener.mock.calls.map(([event]) => event);
    expect(events[0]).toMatchObject({
      type: "resource.changed",
      source: "agent_tool",
      reason: "agent_write",
      sessionPath,
      fileId: "sf_created",
      operation: "created",
      resource: {
        kind: "local-file",
        provider: "local_fs",
        path: filePath,
        filePath,
      },
    });
    expect(events).toHaveLength(1);
  });

  it("emits bare ResourceIO resource.changed without a legacy app-event projection", () => {
    const engine = Object.create(GsapEngine.prototype);
    const listener = vi.fn();
    engine._eventBus = null;
    engine._listeners = new Set([listener]);

    engine._emitEvent({
      type: "resource.changed",
      changeType: "modified",
      source: "agent_tool",
      reason: "agent_write",
      sessionPath: "/sessions/a.jsonl",
      resourceKey: "local_fs:/workspace/draft.md",
      resource: {
        kind: "local-file",
        provider: "local_fs",
        path: "/workspace/draft.md",
        filePath: "/workspace/draft.md",
      },
      sequence: 1,
      occurredAt: "2026-06-21T00:00:00.000Z",
    }, "/sessions/a.jsonl");

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0]).toMatchObject({ type: "resource.changed" });
  });
});
