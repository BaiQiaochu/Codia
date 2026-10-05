import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

const root = process.cwd();
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"));
const bootstrapPath = path.join(root, "desktop", "bootstrap.cjs");
const desktopMainPath = path.join(root, "desktop", "main.cjs");

describe("desktop launch bootstrap contract", () => {
  it("routes dev and packaged Electron through the pre-main bootstrap", () => {
    expect(packageJson.main).toBe("desktop/bootstrap.cjs");
    expect(packageJson.build?.extraMetadata?.main).toBe("desktop/bootstrap.cjs");
    expect(packageJson.build?.files).toContain("desktop/bootstrap.cjs");
    expect(packageJson.build?.files).toContain("desktop/gsap-home.cjs");
    expect(packageJson.build?.files).toContain("desktop/src/shared/launch-integrity.cjs");
    expect(packageJson.build?.files).toContain("desktop/main.bundle.cjs");
  });

  it("registers diagnostics before loading the full desktop main", () => {
    expect(fs.existsSync(bootstrapPath)).toBe(true);
    if (!fs.existsSync(bootstrapPath)) return;

    const source = fs.readFileSync(bootstrapPath, "utf-8");
    const uncaughtIndex = source.indexOf("uncaughtException");
    const rejectionIndex = source.indexOf("unhandledRejection");
    const markerIndex = source.indexOf("writeLaunchMarker");
    const loadIndex = source.indexOf("loadDesktopMain");

    expect(uncaughtIndex).toBeGreaterThan(-1);
    expect(rejectionIndex).toBeGreaterThan(-1);
    expect(markerIndex).toBeGreaterThan(-1);
    expect(loadIndex).toBeGreaterThan(-1);
    expect(uncaughtIndex).toBeLessThan(loadIndex);
    expect(rejectionIndex).toBeLessThan(loadIndex);
    expect(markerIndex).toBeLessThan(loadIndex);
    expect(source).toContain("main.bundle.cjs");
    expect(source).toContain("main.cjs");
    expect(source).not.toMatch(/Hanako|Hana Launch|HANA_HOME|hana-runtime/);
  });

  it("suppresses Electron's default English menu on the main window", () => {
    const source = fs.readFileSync(desktopMainPath, "utf-8");
    expect(source).toContain("autoHideMenuBar: true");
    expect(source).toContain("mainWindow.setMenuBarVisibility(false)");
    expect(source).toContain("mainWindow.removeMenu()");
  });
});
