import fs from "fs";
import os from "os";
import path from "path";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_BROWSER_PREFERENCES,
  mergeBrowserPreferences,
  normalizeBrowserPreferences,
} from "../shared/browser-preferences.ts";
import { PreferencesManager } from "../core/preferences-manager.js";
import { createPreferencesRoute } from "../server/routes/preferences.js";

function makePrefs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codia-browser-prefs-"));
  return new PreferencesManager({
    userDir: path.join(root, "user"),
    agentsDir: path.join(root, "agents"),
  });
}

describe("browser preferences", () => {
  it("normalizes and merges browser preferences", () => {
    expect(normalizeBrowserPreferences()).toEqual(DEFAULT_BROWSER_PREFERENCES);
    expect(normalizeBrowserPreferences({ acceptCookies: false, agentOpenBehavior: "new_tab" })).toEqual({
      acceptCookies: false,
      agentOpenBehavior: "new_tab",
    });
    expect(normalizeBrowserPreferences({ acceptCookies: "no", agentOpenBehavior: "unknown" })).toEqual({
      acceptCookies: true,
      agentOpenBehavior: "smart",
    });
    expect(mergeBrowserPreferences({ acceptCookies: false }, { agentOpenBehavior: "current_tab" })).toEqual({
      acceptCookies: false,
      agentOpenBehavior: "current_tab",
    });
  });

  it("persists browser preferences through PreferencesManager", () => {
    const prefs = makePrefs();

    expect(prefs.getBrowserPreferences()).toEqual({
      acceptCookies: true,
      agentOpenBehavior: "smart",
    });

    prefs.setBrowserPreferences({ acceptCookies: false });
    prefs.setBrowserPreferences({ agentOpenBehavior: "new_tab" });

    expect(prefs.getBrowserPreferences()).toEqual({
      acceptCookies: false,
      agentOpenBehavior: "new_tab",
    });
    expect(prefs.getPreferences().browser).toEqual({
      acceptCookies: false,
      agentOpenBehavior: "new_tab",
    });
  });

  it("reads, updates, applies, and clears browser preferences through the route", async () => {
    const prefs = makePrefs();
    const applyBrowserPreferences = vi.fn();
    const clearBrowserCookiesAndSiteData = vi.fn();
    const engine = {
      getBrowserPreferences: () => prefs.getBrowserPreferences(),
      setBrowserPreferences: (patch: unknown) => prefs.setBrowserPreferences(patch),
    };
    const app = new Hono();
    app.route("/api", createPreferencesRoute(engine, {
      applyBrowserPreferences,
      clearBrowserCookiesAndSiteData,
    }));

    const initial = await app.request("/api/preferences/browser");
    expect(initial.status).toBe(200);
    expect(await initial.json()).toEqual({
      browser: { acceptCookies: true, agentOpenBehavior: "smart" },
    });

    const updated = await app.request("/api/preferences/browser", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ browser: { acceptCookies: false, agentOpenBehavior: "new_tab" } }),
    });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toEqual({
      ok: true,
      browser: { acceptCookies: false, agentOpenBehavior: "new_tab" },
    });
    expect(applyBrowserPreferences).toHaveBeenCalledWith({
      acceptCookies: false,
      agentOpenBehavior: "new_tab",
    });

    const cleared = await app.request("/api/preferences/browser/clear-cookies", { method: "POST" });
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toEqual({ ok: true });
    expect(clearBrowserCookiesAndSiteData).toHaveBeenCalledTimes(1);
  });
});
