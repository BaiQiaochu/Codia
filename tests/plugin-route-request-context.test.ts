import { describe, it, expect, vi } from "vitest";
import { EventBus } from "../hub/event-bus.ts";
import {
  PluginBusCapabilityError,
  createPluginRouteRequestContext,
} from "../core/plugin-route-request-context.ts";

function makeBusWithSessionCreate() {
  const bus = new EventBus();
  const handler = vi.fn(async () => ({ ok: true, sessionPath: "/agents/gsap/sessions/new.jsonl" }));
  bus.handle("session:create", handler);
  return { bus, handler };
}

function makeContext(overrides: any = {}) {
  const bus = overrides.bus || makeBusWithSessionCreate().bus;
  return createPluginRouteRequestContext({
    pluginCtx: { pluginId: "media-board", bus },
    accessLevel: overrides.accessLevel ?? "full-access",
    capabilities: overrides.capabilities,
    sensitiveCapabilities: overrides.sensitiveCapabilities,
    principal: overrides.principal ?? null,
    agentId: overrides.agentId ?? null,
  });
}

describe("createPluginRouteRequestContext", () => {
  it("exposes request principal, plugin identity, and capability grant", () => {
    const principal = {
      kind: "plugin",
      pluginId: "media-board",
      credentialKind: "plugin_surface_session",
      connectionKind: "local",
    };
    const ctx = makeContext({
      capabilities: ["session"],
      principal,
      agentId: "gsap-agent",
    });

    expect(ctx.pluginId).toBe("media-board");
    expect(ctx.agentId).toBe("gsap-agent");
    expect(ctx.principal).toMatchObject({
      kind: "plugin",
      pluginId: "media-board",
      credentialKind: "plugin_surface_session",
    });
    expect(ctx.capabilityGrant).toMatchObject({
      accessLevel: "full-access",
      declaredPermissions: ["session"],
      legacyDeclaration: false,
    });
    expect(Object.isFrozen(ctx)).toBe(true);
  });

  it("allows declared sensitive capabilities for granted full-access plugins", async () => {
    const { bus, handler } = makeBusWithSessionCreate();
    const ctx = makeContext({ bus, capabilities: ["session"] });

    const result = await ctx.bus.request("session:create", { agentId: "gsap-agent" });

    expect(result).toMatchObject({ ok: true, sessionPath: expect.any(String) });
    expect(handler).toHaveBeenCalledWith({ agentId: "gsap-agent" });
  });

  it("accepts exact permission declarations through sensitiveCapabilities", async () => {
    const { bus, handler } = makeBusWithSessionCreate();
    const ctx = makeContext({ bus, sensitiveCapabilities: ["session.write"] });

    await ctx.bus.request("session:create", {});

    expect(handler).toHaveBeenCalled();
  });

  it("keeps legacy manifests without capability declarations working", async () => {
    const { bus, handler } = makeBusWithSessionCreate();
    const ctx = makeContext({ bus, capabilities: null, sensitiveCapabilities: undefined });

    await ctx.bus.request("session:create", {});

    expect(handler).toHaveBeenCalled();
    expect(ctx.capabilityGrant.legacyDeclaration).toBe(true);
  });

  it("treats explicitly empty capability declarations as strict denial, not legacy", async () => {
    const { bus, handler } = makeBusWithSessionCreate();
    const ctx = makeContext({ bus, capabilities: [], sensitiveCapabilities: [] });

    expect(ctx.capabilityGrant.legacyDeclaration).toBe(false);
    expect(ctx.capabilityGrant.declaredPermissions).toEqual([]);
    await expect(ctx.bus.request("session:create", {})).rejects.toMatchObject({
      code: "PLUGIN_CAPABILITY_NOT_DECLARED",
      status: 403,
      declared: false,
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("treats a single explicitly declared list as strict even when the other is missing", async () => {
    const { bus, handler } = makeBusWithSessionCreate();
    const ctx = makeContext({ bus, capabilities: [], sensitiveCapabilities: null });

    expect(ctx.capabilityGrant.legacyDeclaration).toBe(false);
    await expect(ctx.bus.request("session:create", {})).rejects.toMatchObject({
      code: "PLUGIN_CAPABILITY_NOT_DECLARED",
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("rejects undeclared sensitive capabilities with a diagnosable error", async () => {
    const { bus, handler } = makeBusWithSessionCreate();
    const ctx = makeContext({ bus, capabilities: ["agent"] });

    await expect(ctx.bus.request("session:create", {})).rejects.toMatchObject({
      code: "PLUGIN_CAPABILITY_NOT_DECLARED",
      status: 403,
      capability: "session:create",
      permission: "session.write",
      pluginId: "media-board",
      declared: false,
      granted: true,
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("rejects sensitive capabilities for plugins without user-granted full access", async () => {
    const { bus, handler } = makeBusWithSessionCreate();
    const ctx = makeContext({ bus, accessLevel: "restricted", capabilities: ["session"] });

    await expect(ctx.bus.request("session:create", {})).rejects.toMatchObject({
      code: "PLUGIN_CAPABILITY_NOT_GRANTED",
      capability: "session:create",
      permission: "session.write",
      declared: true,
      granted: false,
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("passes plugin-owned and unregistered capability types through without the gate", async () => {
    const bus = new EventBus();
    const customHandler = vi.fn(async () => ({ ok: true }));
    bus.handle("media-board:refresh", customHandler, {
      capability: {
        type: "media-board:refresh",
        owner: "plugin",
        permission: "plugin.bus.request",
      },
    });
    const unregisteredHandler = vi.fn(async () => "pong");
    bus.handle("media-board:ping", unregisteredHandler);
    const ctx = makeContext({ bus, capabilities: ["agent"] });

    await ctx.bus.request("media-board:refresh", {});
    await ctx.bus.request("media-board:ping", {});

    expect(customHandler).toHaveBeenCalled();
    expect(unregisteredHandler).toHaveBeenCalled();
  });
});
