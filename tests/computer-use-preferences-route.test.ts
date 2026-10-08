import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createPreferencesRoute } from "../server/routes/preferences.js";

function makeApp(engine, opts) {
  const app = new Hono();
  app.route("/api", createPreferencesRoute(engine, opts));
  return app;
}

describe("Computer Use preference routes", () => {
  it("returns disabled effective status and blocks changes on unsupported platforms", async () => {
    const engine = {
      getSharedModels: vi.fn(() => ({})),
      getSearchConfig: vi.fn(() => ({})),
      getUtilityApi: vi.fn(() => ({})),
      getComputerUseSettings: vi.fn(() => ({
        enabled: true,
        provider_by_platform: { linux: "mock" },
        app_approvals: [],
      })),
      getComputerHost: vi.fn(() => ({
        getStatus: vi.fn(async () => ({ enabled: true, selectedProviderId: "mock" })),
        requestPermissions: vi.fn(async () => ({ providerId: "mock" })),
      })),
      setComputerUseSettings: vi.fn(),
    };
    const app = makeApp(engine, { platform: "linux" });

    const getRes = await app.request("/api/preferences/computer-use");
    const getBody = await getRes.json();

    expect(getRes.status).toBe(200);
    expect(getBody.settings.enabled).toBe(false);
    expect(getBody.status).toMatchObject({
      enabled: false,
      platform: "linux",
      supported: false,
      selectedProviderId: null,
    });
    expect(engine.getComputerHost).not.toHaveBeenCalled();

    const putRes = await app.request("/api/preferences/computer-use", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(putRes.status).toBe(400);
    expect(await putRes.json()).toEqual({ error: "Computer Use is not supported on Linux Preview." });
    expect(engine.setComputerUseSettings).not.toHaveBeenCalled();

    const permissionsRes = await app.request("/api/preferences/computer-use/request-permissions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId: "mock" }),
    });
    expect(permissionsRes.status).toBe(400);
    expect(await permissionsRes.json()).toEqual({ error: "Computer Use is not supported on Linux Preview." });
  });

  it("uses the async Computer Use settings updater when available", async () => {
    const engine = {
      getSharedModels: vi.fn(() => ({})),
      getSearchConfig: vi.fn(() => ({})),
      getUtilityApi: vi.fn(() => ({})),
      getComputerUseSettings: vi.fn(() => ({
        enabled: true,
        provider_by_platform: { win32: "windows:uia" },
        app_approvals: [],
      })),
      getComputerHost: vi.fn(() => ({
        getStatus: vi.fn(async () => ({ enabled: true, selectedProviderId: "windows:uia" })),
      })),
      updateComputerUseSettings: vi.fn(async (partial) => ({
        enabled: partial.enabled,
        provider_by_platform: { win32: "windows:uia" },
        app_approvals: [],
      })),
      setComputerUseSettings: vi.fn(),
    };
    const app = makeApp(engine, { platform: "win32" });

    const res = await app.request("/api/preferences/computer-use", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });

    expect(res.status).toBe(200);
    expect(engine.updateComputerUseSettings).toHaveBeenCalledWith({ enabled: false });
    expect(engine.setComputerUseSettings).not.toHaveBeenCalled();
  });
});
