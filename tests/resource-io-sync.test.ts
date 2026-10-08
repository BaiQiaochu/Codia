import { describe, expect, it, vi } from "vitest";
import { ResourceEventBus } from "../lib/resource-io/resource-event-bus.ts";

describe("ResourceIO sync cursor", () => {
  it("retains recent resource events for catch-up by sequence", () => {
    const emit = vi.fn();
    const bus = new ResourceEventBus({
      emit,
      now: () => new Date("2026-06-22T00:00:00.000Z"),
    });

    bus.changed({
      changeType: "modified",
      resourceKey: "local_fs:/repo/a.md",
      resource: { kind: "local-file", path: "/repo/a.md" },
      source: "provider_watch",
      sessionPath: "/sessions/a.jsonl",
    });

    expect(bus.since(0)).toEqual({
      stale: false,
      latestSequence: 1,
      events: [expect.objectContaining({
        type: "resource.changed",
        sequence: 1,
        resourceKey: "local_fs:/repo/a.md",
      })],
    });
  });

  it("reports stale cursors when requested events have rolled out of memory", () => {
    const bus = new ResourceEventBus({
      emit: vi.fn(),
      retentionSize: 1,
    });

    bus.changed({
      changeType: "modified",
      resourceKey: "local_fs:/repo/a.md",
      resource: { kind: "local-file", path: "/repo/a.md" },
      source: "api",
    });
    bus.changed({
      changeType: "modified",
      resourceKey: "local_fs:/repo/b.md",
      resource: { kind: "local-file", path: "/repo/b.md" },
      source: "api",
    });

    expect(bus.since(0)).toMatchObject({
      stale: true,
      latestSequence: 2,
    });
  });
});
