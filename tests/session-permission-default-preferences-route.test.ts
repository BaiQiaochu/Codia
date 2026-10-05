import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

import { createPreferencesRoute } from "../server/routes/preferences.ts";

function makeApp(defaultMode = "auto") {
  let permissionMode = defaultMode;
  const engine = {
    getSessionPermissionModeDefault: vi.fn(() => permissionMode),
    setSessionPermissionModeDefault: vi.fn((mode) => {
      permissionMode = mode;
      return permissionMode;
    }),
  };
  const app = new Hono();
  app.route("/api", createPreferencesRoute(engine));
  return { app, engine };
}

describe("session permission default preferences route", () => {
  it("reads the new-session permission default without touching session state", async () => {
    const { app, engine } = makeApp("auto");

    const res = await app.request("/api/preferences/session-permission-default");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ permissionMode: "auto" });
    expect(engine.getSessionPermissionModeDefault).toHaveBeenCalledOnce();
    expect(engine.setSessionPermissionModeDefault).not.toHaveBeenCalled();
  });

  it("persists the new-session permission default as a user preference", async () => {
    const { app, engine } = makeApp("ask");

    const res = await app.request("/api/preferences/session-permission-default", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ permissionMode: "read_only" }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(engine.setSessionPermissionModeDefault).toHaveBeenCalledWith("read_only");
    expect(body).toEqual({ ok: true, permissionMode: "read_only" });

    const readBack = await app.request("/api/preferences/session-permission-default");
    expect(await readBack.json()).toEqual({ permissionMode: "read_only" });
  });

  it("rejects invalid default permission modes explicitly", async () => {
    const { app, engine } = makeApp("auto");

    const res = await app.request("/api/preferences/session-permission-default", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ permissionMode: "danger" }),
    });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toContain("permissionMode");
    expect(engine.setSessionPermissionModeDefault).not.toHaveBeenCalled();
  });
});
