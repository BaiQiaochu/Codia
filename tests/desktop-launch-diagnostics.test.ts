// @ts-nocheck
import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

describe("desktop launch diagnostics", () => {
  let tmpDir = null;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  it("writes redacted startup events to a stable desktop-launch log path", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codia-launch-diagnostics-"));
    const mod = await import("../desktop/src/shared/desktop-launch-diagnostics.cjs");
    const { createDesktopLaunchDiagnostics } = mod.default || mod;
    let tick = 0;
    const diagnostics = createDesktopLaunchDiagnostics({
      codiaHome: tmpDir,
      startupId: "startup-1",
      appVersion: "1.2.3",
      platform: "win32",
      arch: "x64",
      now: () => `2026-06-06T00:00:0${tick++}.000Z`,
      redactText: (value) => String(value).replaceAll("secret-value", "<redacted>"),
    });

    diagnostics.reset({ argv: ["codia", "secret-value"] });
    diagnostics.append("console-message", {
      message: "token=secret-value",
      nested: { path: "secret-value" },
    });

    expect(diagnostics.rendererLogPath).toBe(path.join(tmpDir, "diagnostics", "desktop-launch", "renderer.log"));
    const lines = fs.readFileSync(diagnostics.rendererLogPath, "utf-8").trim().split("\n").map(JSON.parse);

    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      event: "desktop-launch-start",
      startupId: "startup-1",
      appVersion: "1.2.3",
      platform: "win32",
      arch: "x64",
      details: { argv: ["codia", "<redacted>"] },
    });
    expect(lines[1]).toMatchObject({
      event: "console-message",
      details: {
        message: "token=<redacted>",
        nested: { path: "<redacted>" },
      },
    });
  });

  it("keeps main-process window lifecycle coverage for blank-launch diagnostics", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "desktop/main.cjs"), "utf-8");

    for (const required of [
      "createDesktopLaunchDiagnostics",
      "attachRendererLaunchDiagnostics",
      "desktop-launch-diagnostics.cjs",
      '"window-created"',
      '"dom-ready"',
      '"did-finish-load"',
      '"did-fail-load"',
      '"render-process-gone"',
      '"console-message"',
      '"app-ready-timeout"',
      '"app-ready"',
      "backgroundThrottling: false",
    ]) {
      expect(source).toContain(required);
    }

    for (const label of [
      'attachRendererLaunchDiagnostics(splashWindow, "splash")',
      'attachRendererLaunchDiagnostics(mainWindow, "main")',
      'attachRendererLaunchDiagnostics(onboardingWindow, "onboarding")',
      'attachRendererLaunchDiagnostics(settingsWindow, "settings")',
      'attachRendererLaunchDiagnostics(browserViewerWindow, "browser-viewer")',
    ]) {
      expect(source).toContain(label);
    }
  });
});
