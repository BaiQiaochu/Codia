import fs from "fs";
import os from "os";
import path from "path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { PreferencesManager } from "../core/preferences-manager.js";
import { createPreferencesRoute } from "../server/routes/preferences.js";

function makePrefs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codia-plugin-ui-prefs-"));
  return new PreferencesManager({
    userDir: path.join(root, "user"),
    agentsDir: path.join(root, "agents"),
  });
}

function makeApp(prefs: PreferencesManager) {
  const app = new Hono();
  app.route("/api", createPreferencesRoute({
    getPluginUiPrefs: () => prefs.getPluginUiPrefs(),
    setPluginUiPrefs: (patch: any) => prefs.setPluginUiPrefs(patch),
  }));
  return app;
}

describe("plugin UI preferences", () => {
  it("normalizes current and upstream plugin UI fields", () => {
    const prefs = makePrefs();

    prefs.setPluginUiPrefs({
      pluginTabOrder: ["plugin:graph"],
      pluginPinnedWidgets: ["weather"],
      pluginHiddenTabs: ["old-tab"],
      hiddenWidgets: ["legacy-widget"],
    });

    expect(prefs.getPluginUiPrefs()).toEqual({
      tabOrder: ["plugin:graph"],
      pinnedWidgets: ["weather"],
      hiddenTabs: ["old-tab"],
      hiddenWidgets: ["legacy-widget"],
    });
  });

  it("serves dedicated and legacy root preference routes for plugin UI state", async () => {
    const prefs = makePrefs();
    const app = makeApp(prefs);

    const dedicated = await app.request("/api/preferences/plugin-ui", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tabOrder: ["plugin:notes"], pinnedWidgets: ["notes"] }),
    });
    expect(dedicated.status).toBe(200);
    await expect(dedicated.json()).resolves.toMatchObject({
      ok: true,
      tabOrder: ["plugin:notes"],
      pinnedWidgets: ["notes"],
    });

    const legacy = await app.request("/api/preferences", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pluginTabOrder: ["plugin:calendar"],
        pluginPinnedWidgets: ["calendar"],
        pluginHiddenTabs: ["debug"],
      }),
    });
    expect(legacy.status).toBe(200);
    await expect(legacy.json()).resolves.toMatchObject({
      ok: true,
      pluginUi: {
        tabOrder: ["plugin:calendar"],
        pinnedWidgets: ["calendar"],
        hiddenTabs: ["debug"],
      },
    });

    const get = await app.request("/api/preferences/plugin-ui");
    expect(get.status).toBe(200);
    await expect(get.json()).resolves.toEqual({
      tabOrder: ["plugin:calendar"],
      pinnedWidgets: ["calendar"],
      hiddenTabs: ["debug"],
      hiddenWidgets: [],
    });
  });
});
