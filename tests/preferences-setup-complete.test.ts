import fs from "fs";
import os from "os";
import path from "path";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { PreferencesManager } from "../core/preferences-manager.js";
import { createPreferencesRoute } from "../server/routes/preferences.js";

function makeDirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codia-prefs-setup-"));
  return {
    root,
    userDir: path.join(root, "user"),
    agentsDir: path.join(root, "agents"),
    prefsPath: path.join(root, "user", "preferences.json"),
  };
}

function seedPrefsFile(dirs, contents) {
  fs.mkdirSync(dirs.userDir, { recursive: true });
  fs.writeFileSync(dirs.prefsPath, JSON.stringify(contents, null, 2) + "\n", "utf-8");
}

function readPrefsFile(dirs) {
  return JSON.parse(fs.readFileSync(dirs.prefsPath, "utf-8"));
}

function makeApp(engine) {
  const app = new Hono();
  app.route("/api", createPreferencesRoute(engine));
  return app;
}

describe("PreferencesManager setup completion", () => {
  it("reads setupComplete from existing preferences for old users", () => {
    const dirs = makeDirs();
    seedPrefsFile(dirs, { setupComplete: true, locale: "zh-CN" });

    const prefs = new PreferencesManager(dirs);

    expect(prefs.getSetupComplete()).toBe(true);
    expect(prefs.getPreferences().locale).toBe("zh-CN");
  });

  it("preserves setupComplete already on disk when a stale server cache saves another preference", () => {
    const dirs = makeDirs();
    const prefs = new PreferencesManager(dirs);

    seedPrefsFile(dirs, { setupComplete: true });
    prefs.setLocale("en");

    const stored = readPrefsFile(dirs);
    expect(stored.setupComplete).toBe(true);
    expect(stored.locale).toBe("en");
  });

  it("marks setupComplete through an atomic write and read-back verification", () => {
    const dirs = makeDirs();
    seedPrefsFile(dirs, { locale: "zh-CN" });
    const prefs = new PreferencesManager(dirs);

    const result = prefs.markSetupComplete();

    expect(result).toEqual({ setupComplete: true });
    expect(prefs.getSetupComplete()).toBe(true);
    expect(readPrefsFile(dirs).setupComplete).toBe(true);
  });
});

describe("preferences setup completion route", () => {
  it("submits onboarding completion intent through PreferencesManager", async () => {
    const engine = {
      markSetupComplete: vi.fn(() => ({ setupComplete: true })),
    };
    const app = makeApp(engine);

    const res = await app.request("/api/preferences/setup-complete", { method: "POST" });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true, setupComplete: true });
    expect(engine.markSetupComplete).toHaveBeenCalledTimes(1);
  });

  it("rejects setup completion when read-back verification fails", async () => {
    const engine = {
      markSetupComplete: vi.fn(() => {
        throw new Error("setupComplete read-back verification failed");
      }),
    };
    const app = makeApp(engine);

    const res = await app.request("/api/preferences/setup-complete", { method: "POST" });
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toMatch(/read-back verification failed/);
  });
});
