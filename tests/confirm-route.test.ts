// @ts-nocheck
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

function runtimeContext() {
  return {
    serverId: "server_1",
    serverNodeId: "node_1",
    userId: "user_1",
    studioId: "studio_1",
    connectionKind: "local",
    credentialKind: "loopback_token",
  };
}

function devicePrincipal(scopes = ["chat"]) {
  return Object.freeze({
    kind: "device",
    credentialKind: "device_credential",
    connectionKind: "lan",
    trustState: "lan",
    serverId: "server_1",
    serverNodeId: "node_1",
    userId: "user_1",
    studioId: "studio_1",
    deviceId: "phone_1",
    scopes,
  });
}

async function makeApp({ pending, principal }) {
  const confirmStore = {
    get: vi.fn(() => pending),
    resolve: vi.fn(() => true),
  };
  const engine = {
    codiaHome: null,
    getRuntimeContext: () => runtimeContext(),
    emitEvent: vi.fn(),
  };
  const { createConfirmRoute } = await import("../server/routes/confirm.js");
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("authPrincipal", principal);
    await next();
  });
  app.route("/api", createConfirmRoute(confirmStore, engine));
  return { app, confirmStore, engine };
}

describe("confirm route", () => {
  it("allows a chat-scoped device to resolve a session tool approval", async () => {
    const { app, confirmStore, engine } = await makeApp({
      principal: devicePrincipal(["chat"]),
      pending: {
        sessionPath: "/sessions/a.jsonl",
        kind: "tool_action_approval",
        payload: { toolName: "write" },
      },
    });

    const res = await app.request("/api/confirm/confirm_1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "confirmed", value: { ok: true } }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(confirmStore.get).toHaveBeenCalledWith("confirm_1");
    expect(confirmStore.resolve).toHaveBeenCalledWith("confirm_1", "confirmed", { ok: true });
    expect(engine.emitEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "confirmation_resolved",
      confirmId: "confirm_1",
      action: "confirmed",
    }), null);
  });

  it("requires settings.write before resolving settings confirmations", async () => {
    const { app, confirmStore } = await makeApp({
      principal: devicePrincipal(["chat"]),
      pending: {
        sessionPath: "/sessions/a.jsonl",
        kind: "settings",
        payload: { key: "model" },
      },
    });

    const res = await app.request("/api/confirm/settings_1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "confirmed" }),
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "insufficient_scope" });
    expect(confirmStore.get).toHaveBeenCalledWith("settings_1");
    expect(confirmStore.resolve).not.toHaveBeenCalled();
  });
});
