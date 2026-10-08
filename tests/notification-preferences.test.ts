import fs from "fs";
import os from "os";
import path from "path";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { PreferencesManager } from "../core/preferences-manager.js";
import { createPreferencesRoute } from "../server/routes/preferences.js";

function makePrefs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-prefs-notification-"));
  const userDir = path.join(root, "user");
  const agentsDir = path.join(root, "agents");
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(path.join(userDir, "preferences.json"), "{}\n");
  return new PreferencesManager({ userDir, agentsDir });
}

describe("notification preferences", () => {
  it("defaults turn completion notifications to never", () => {
    const prefs = makePrefs();

    expect(prefs.getNotificationPreferences()).toEqual({
      turnCompletion: "never",
    });
  });

  it("persists normalized turn completion preference", () => {
    const prefs = makePrefs();

    expect(prefs.setNotificationPreferences({ turnCompletion: "when_unfocused" })).toEqual({
      turnCompletion: "when_unfocused",
    });
    expect(prefs.setNotificationPreferences({ turnCompletion: "when_session_unfocused" })).toEqual({
      turnCompletion: "when_session_unfocused",
    });
    expect(prefs.getPreferences().notifications).toEqual({
      turnCompletion: "when_session_unfocused",
    });
    expect(prefs.setNotificationPreferences({ turnCompletion: "sometimes" })).toEqual({
      turnCompletion: "never",
    });
  });

  it("reads and updates notification preferences through the route", async () => {
    let notifications = { turnCompletion: "never" };
    const engine = {
      getSharedModels: vi.fn(() => ({})),
      getSearchConfig: vi.fn(() => ({})),
      getUtilityApi: vi.fn(() => ({})),
      getNotificationPreferences: vi.fn(() => notifications),
      setNotificationPreferences: vi.fn((patch) => {
        notifications = {
          turnCompletion: patch.turnCompletion === "when_unfocused" || patch.turnCompletion === "when_session_unfocused"
            ? patch.turnCompletion
            : "never",
        };
        return notifications;
      }),
    };
    const app = new Hono();
    app.route("/api", createPreferencesRoute(engine));

    const initial = await app.request("/api/preferences/notifications");
    expect(initial.status).toBe(200);
    expect(await initial.json()).toEqual({ notifications: { turnCompletion: "never" } });

    const updated = await app.request("/api/preferences/notifications", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notifications: { turnCompletion: "when_session_unfocused" } }),
    });

    expect(updated.status).toBe(200);
    expect(engine.setNotificationPreferences).toHaveBeenCalledWith({
      turnCompletion: "when_session_unfocused",
    });
    expect(await updated.json()).toEqual({
      ok: true,
      notifications: { turnCompletion: "when_session_unfocused" },
    });
  });
});
