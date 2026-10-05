import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskRegistry } from "../lib/task-registry.js";
import { registerTaskRegistryBusHandlers } from "../server/task-bus-handlers.js";

afterEach(() => {
  vi.useRealTimers();
});

function createBusHarness() {
  const handlers = new Map();
  return {
    bus: {
      handle: vi.fn((type, handler) => {
        handlers.set(type, handler);
      }),
    },
    request(type, payload) {
      const handler = handlers.get(type);
      if (!handler) throw new Error(`missing handler ${type}`);
      return handler(payload);
    },
  };
}

describe("registerTaskRegistryBusHandlers", () => {
  it("preserves task handler run callbacks for scheduled tasks", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-02T00:00:00.000Z"));
    const registry = new TaskRegistry();
    const { bus, request } = createBusHarness();
    const abort = vi.fn();
    const run = vi.fn(async () => ({ ok: true }));

    registerTaskRegistryBusHandlers(bus, registry);
    request("task:register-handler", { type: "digest", abort, run });
    request("task:schedule", {
      scheduleId: "daily",
      type: "digest",
      runAt: Date.now() + 1000,
    });

    await vi.advanceTimersByTimeAsync(1000);

    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      scheduleId: "daily",
      type: "digest",
    }));
    expect(registry.querySchedule("daily")).toMatchObject({
      enabled: false,
      runCount: 1,
      lastResult: { ok: true },
    });
    registry.clearTimers();
  });

  it("keeps abort-only handlers valid for ordinary task cancellation", () => {
    const registry = new TaskRegistry();
    const { bus, request } = createBusHarness();
    const abort = vi.fn();

    registerTaskRegistryBusHandlers(bus, registry);
    request("task:register-handler", { type: "render", abort });
    request("task:register", { taskId: "t1", type: "render" });

    expect(request("task:cancel", { taskId: "t1", reason: "user" })).toEqual({
      result: "aborted",
      canceled: true,
    });
    expect(abort).toHaveBeenCalledWith("t1");
  });

  it("preserves G-SAP retry handlers on task registrations", () => {
    const registry = new TaskRegistry();
    const { bus, request } = createBusHarness();
    const retry = vi.fn(() => ({ restarted: true }));

    registerTaskRegistryBusHandlers(bus, registry);
    request("task:register-handler", { type: "image", abort: vi.fn(), retry });
    request("task:register", { taskId: "retry-me", type: "image" });
    request("task:fail", { taskId: "retry-me", reason: "network" });

    expect(request("task:retry", { taskId: "retry-me" })).toMatchObject({
      status: "retrying",
      result: { restarted: true },
    });
    expect(retry).toHaveBeenCalledWith("retry-me", expect.objectContaining({
      taskId: "retry-me",
      type: "image",
    }));
  });
});
