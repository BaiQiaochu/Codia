import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import { PreferencesManager } from "../core/preferences-manager.ts";

function makePrefs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-prefs-hardware-accel-"));
  return new PreferencesManager({
    userDir: path.join(root, "user"),
    agentsDir: path.join(root, "agents"),
  });
}

describe("PreferencesManager hardware acceleration preference", () => {
  it("defaults hardware acceleration to enabled", () => {
    const prefs = makePrefs();

    expect(prefs.getHardwareAcceleration()).toBe(true);
  });

  it("stores hardware acceleration as an explicit boolean", () => {
    const prefs = makePrefs();

    prefs.setHardwareAcceleration("false");
    expect(prefs.getHardwareAcceleration()).toBe(false);
    expect(prefs.getPreferences().hardware_acceleration).toBe(false);

    prefs.setHardwareAcceleration(true);
    expect(prefs.getHardwareAcceleration()).toBe(true);
    expect(prefs.getPreferences().hardware_acceleration).toBe(true);
  });
});
