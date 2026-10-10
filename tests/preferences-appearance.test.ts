import fs from "fs";
import os from "os";
import path from "path";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { PreferencesManager } from "../core/preferences-manager.js";
import { createPreferencesRoute } from "../server/routes/preferences.js";

function makePrefs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codia-prefs-appearance-"));
  return new PreferencesManager({
    userDir: path.join(root, "user"),
    agentsDir: path.join(root, "agents"),
  });
}

function makeApp(engine) {
  const app = new Hono();
  app.route("/api", createPreferencesRoute(engine));
  return app;
}

describe("PreferencesManager appearance preferences", () => {
  it("merges synced appearance preferences without dropping migrated typography fields", () => {
    const prefs = makePrefs();

    expect(prefs.getAppearance()).toEqual({});
    prefs.setAppearance({ theme: "workbench", serif: true });
    prefs.setAppearance({ paperTexture: false });

    expect(prefs.getAppearance()).toEqual({
      theme: "workbench",
      serif: true,
      paperTexture: false,
    });
    expect(prefs.getPreferences().appearance).toEqual({
      theme: "workbench",
      serif: true,
      paperTexture: false,
    });
  });

  it("drops unknown appearance fields before persisting", () => {
    const prefs = makePrefs();

    prefs.setAppearance({ theme: "precision-ide", unknown: true, leavesOverlay: true });

    expect(prefs.getAppearance()).toEqual({
      theme: "precision-ide",
      leavesOverlay: true,
    });
  });
});

describe("preferences appearance route", () => {
  it("updates appearance and emits only changed UI events", async () => {
    const prefs = makePrefs();
    prefs.setAppearance({ theme: "studio-light", serif: true });
    const engine = {
      getAppearance: () => prefs.getAppearance(),
      setAppearance: (patch) => prefs.setAppearance(patch),
      emitEvent: vi.fn(),
    };
    const app = makeApp(engine);

    const res = await app.request("/api/preferences/appearance", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paperTexture: true, theme: "nocturne" }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      ok: true,
      appearance: {
        theme: "nocturne",
        serif: true,
        paperTexture: true,
      },
    });
    expect(engine.emitEvent).toHaveBeenCalledTimes(2);
    expect(engine.emitEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: { type: "theme-changed", payload: { theme: "nocturne" }, source: "server" },
      type: "app_event",
    }), null);
    expect(engine.emitEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: { type: "paper-texture-changed", payload: { enabled: true }, source: "server" },
      type: "app_event",
    }), null);
  });

  it("returns the persisted appearance preferences", async () => {
    const prefs = makePrefs();
    prefs.setAppearance({ theme: "workbench", leavesOverlay: true });
    const app = makeApp({
      getAppearance: () => prefs.getAppearance(),
      setAppearance: (patch) => prefs.setAppearance(patch),
    });

    const res = await app.request("/api/preferences/appearance");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ appearance: { theme: "workbench", leavesOverlay: true } });
  });
});
