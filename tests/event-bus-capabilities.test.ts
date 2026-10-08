import { describe, expect, it } from "vitest";
import { EventBus } from "../hub/event-bus.js";

describe("EventBus capability directory", () => {
  it("lists built-in capabilities with availability derived from handlers", () => {
    const bus = new EventBus();

    const before = bus.getCapability("session:send");
    expect(before).toMatchObject({
      type: "session:send",
      permission: "session.write",
      available: false,
    });

    const off = bus.handle("session:send", async () => ({ ok: true }));
    const after = bus.getCapability("session:send");
    expect(after.available).toBe(true);

    off();
    expect(bus.getCapability("session:send").available).toBe(false);
  });

  it("registers and unregisters dynamic capabilities with handlers", () => {
    const bus = new EventBus();

    const off = bus.handle("demo:preview", async () => ({ ok: true }), {
      capability: {
        title: "Preview demo",
        description: "Preview demo data.",
        inputSchema: { type: "object", properties: { id: { type: "string" } } },
        outputSchema: { type: "object", properties: { ok: { type: "boolean" } } },
        permission: "demo.preview",
        errors: ["NO_HANDLER", "TIMEOUT"],
        owner: "plugin:demo",
        stability: "experimental",
      },
    });

    expect(bus.getCapability("demo:preview")).toMatchObject({
      type: "demo:preview",
      title: "Preview demo",
      permission: "demo.preview",
      owner: "plugin:demo",
      available: true,
    });

    off();
    expect(bus.getCapability("demo:preview")).toBeNull();
  });

  it("returns cloned capability records", () => {
    const bus = new EventBus();
    const capability = bus.getCapability("agent:config");
    capability.inputSchema.properties.agentId.type = "number";

    expect(bus.getCapability("agent:config").inputSchema.properties.agentId.type).toBe("string");
  });

  it("keeps capability declarations while clear removes handlers", () => {
    const bus = new EventBus();

    bus.handle("demo:preview", async () => ({ ok: true }), {
      capability: {
        title: "Preview demo",
        permission: "demo.preview",
      },
    });

    expect(bus.getCapability("demo:preview")).toMatchObject({
      type: "demo:preview",
      available: true,
    });

    bus.clear();

    expect(bus.hasHandler("demo:preview")).toBe(false);
    expect(bus.getCapability("demo:preview")).toMatchObject({
      type: "demo:preview",
      available: false,
    });
    expect(bus.getCapability("session:send")).toMatchObject({
      type: "session:send",
      available: false,
    });
  });

  it("declares usage:list as an experimental usage read capability", () => {
    const bus = new EventBus();

    expect(bus.getCapability("usage:list")).toMatchObject({
      type: "usage:list",
      permission: "usage.read",
      stability: "experimental",
      available: false,
    });

    const off = bus.handle("usage:list", () => ({ entries: [], nextCursor: null }));
    expect(bus.getCapability("usage:list").available).toBe(true);
    off();
  });
});
