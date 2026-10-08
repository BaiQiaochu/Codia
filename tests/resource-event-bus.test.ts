import { describe, expect, it, vi } from "vitest";
import { ResourceEventBus } from "../lib/resource-io/resource-event-bus.ts";

describe("ResourceEventBus", () => {
  it("adds sequence and occurredAt before emitting resource events", () => {
    const emit = vi.fn();
    const bus = new ResourceEventBus({
      emit,
      now: () => new Date("2026-06-21T00:00:00.000Z"),
    });

    bus.changed({
      changeType: "modified",
      resourceKey: "local_fs:/repo/a.md",
      resource: { kind: "local-file", path: "/repo/a.md" },
      source: "agent_tool",
      sessionPath: "/sessions/a.jsonl",
    });

    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      type: "resource.changed",
      sequence: 1,
      occurredAt: "2026-06-21T00:00:00.000Z",
      resourceKey: "local_fs:/repo/a.md",
    }), "/sessions/a.jsonl");
  });

  it("dedupes identical versioned changed events", () => {
    const emit = vi.fn();
    const bus = new ResourceEventBus({
      emit,
      now: () => new Date("2026-06-21T00:00:00.000Z"),
    });
    const event = {
      changeType: "modified" as const,
      resourceKey: "local_fs:/repo/a.md",
      resource: { kind: "local-file" as const, path: "/repo/a.md" },
      version: { mtimeMs: 1, size: 2 },
      source: "provider_watch" as const,
      sessionPath: null,
    };

    bus.changed(event);
    bus.changed(event);

    expect(emit).toHaveBeenCalledTimes(1);
  });
});
