import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { PreferencesManager } from "../core/preferences-manager.js";

let tempRoot;

function makeUserDirs() {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-prefs-sandbox-network-"));
  return {
    userDir: path.join(tempRoot, "user"),
    agentsDir: path.join(tempRoot, "agents"),
  };
}

function makePrefs() {
  return new PreferencesManager(makeUserDirs());
}

function seedPrefsFile(dirs, contents) {
  fs.mkdirSync(dirs.userDir, { recursive: true });
  fs.writeFileSync(path.join(dirs.userDir, "preferences.json"), JSON.stringify(contents), "utf-8");
}

describe("PreferencesManager sandbox network preference", () => {
  afterEach(() => {
    if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  });

  it("defaults sandbox networking to enabled", () => {
    const prefs = makePrefs();

    expect(prefs.getSandboxNetwork()).toBe(true);
  });

  it("stores sandbox networking as an explicit boolean", () => {
    const prefs = makePrefs();

    prefs.setSandboxNetwork("true");
    expect(prefs.getSandboxNetwork()).toBe(true);
    expect(prefs.getPreferences().sandbox_network).toBe(true);

    prefs.setSandboxNetwork(false);
    expect(prefs.getSandboxNetwork()).toBe(false);
    expect(prefs.getPreferences().sandbox_network).toBe(false);
  });

  it("relaxes legacy sandbox_network=false once when no migration marker exists", () => {
    const dirs = makeUserDirs();
    seedPrefsFile(dirs, { sandbox_network: false, locale: "zh-CN" });

    const prefs = new PreferencesManager(dirs);

    expect(prefs.getSandboxNetwork()).toBe(true);
    const stored = prefs.getPreferences();
    expect(stored.sandbox_network).toBeUndefined();
    expect(stored._defaultsRelaxedMigrated).toBe(true);
    expect(stored.locale).toBe("zh-CN");
  });

  it("respects an explicit false after the migration marker exists", () => {
    const dirs = makeUserDirs();
    seedPrefsFile(dirs, { sandbox_network: false, _defaultsRelaxedMigrated: true });

    const prefs = new PreferencesManager(dirs);

    expect(prefs.getSandboxNetwork()).toBe(false);
    expect(prefs.getPreferences().sandbox_network).toBe(false);
  });

  it("stores normalized editor typography in global preferences", () => {
    const prefs = makePrefs();

    prefs.setEditor({
      markdown: {
        bodyFontSize: 99,
        lineHeight: "1.8",
        contentPadding: 32,
      },
    });

    expect(prefs.getEditor()).toMatchObject({
      markdown: {
        bodyFontSize: 24,
        lineHeight: 1.8,
        contentPadding: 32,
      },
    });
    expect(prefs.getPreferences().editor.markdown.bodyFontSize).toBe(24);
  });
});
