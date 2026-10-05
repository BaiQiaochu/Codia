import { describe, expect, it, vi } from "vitest";
import { DeferredResultStore } from "../lib/deferred-result-store.ts";
import { registerDeferredResultBusHandlers } from "../server/deferred-result-bus-handlers.ts";

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

describe("registerDeferredResultBusHandlers", () => {
  it("passes sessionId-first refs into the deferred result store", () => {
    const store = new (DeferredResultStore as any)();
    const { bus, request } = createBusHarness();

    registerDeferredResultBusHandlers(bus, store);

    const result = request("deferred:register", {
      taskId: "task_img",
      sessionId: "sess_deferred_bus",
      sessionPath: "/sessions/old.jsonl",
      meta: { type: "image-generation" },
    });

    expect(result).toMatchObject({
      ok: true,
      sessionId: "sess_deferred_bus",
      sessionPath: "/sessions/old.jsonl",
    });
    expect(store.query("task_img")).toMatchObject({
      sessionId: "sess_deferred_bus",
      sessionPath: "/sessions/old.jsonl",
      sessionRef: {
        sessionId: "sess_deferred_bus",
        sessionPath: "/sessions/old.jsonl",
      },
    });
    expect(store.listPending({
      sessionId: "sess_deferred_bus",
      sessionPath: "/sessions/new.jsonl",
    }).map((task) => task.taskId)).toEqual(["task_img"]);
  });
});
