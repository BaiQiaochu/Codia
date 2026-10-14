import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";

const root = process.cwd();

describe("release preflight contract", () => {
  it("exposes a one-command release check script", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"));
    expect(pkg.scripts["check:release"]).toBe("node scripts/release-preflight.mjs");
    expect(pkg.scripts["check:local"]).toBe("node scripts/local-health-check.mjs");
    expect(pkg.scripts["clean:artifacts"]).toBe("node scripts/clean-artifacts.mjs");
    expect(pkg.scripts["audit:theme"]).toBe("node scripts/theme-token-audit.mjs");
    expect(pkg.scripts["audit:theme-visual"]).toBe("node scripts/theme-visual-audit.mjs");
    expect(pkg.scripts["audit:theme-screenshots"]).toBe("node scripts/theme-screenshot-audit.mjs");
    expect(pkg.scripts["audit:pwa-theme-behavior"]).toBe("node scripts/pwa-theme-behavior-audit.mjs");
    expect(pkg.scripts["audit:surfaces"]).toBe("node scripts/surface-feature-audit.mjs");
    expect(pkg.scripts["e2e:desktop-smoke"]).toBe("node scripts/desktop-e2e-smoke.mjs");
    expect(pkg.scripts["e2e:desktop-packaged-smoke"]).toBe("node scripts/desktop-e2e-packaged-smoke.mjs");
    expect(pkg.scripts["e2e:packaged-runtime-smoke"]).toBe("node scripts/packaged-runtime-smoke.mjs");
    expect(pkg.scripts["surface:package-smoke"]).toBeUndefined();
    expect(pkg.scripts["build:windows-sandbox-helper"]).toBe("node scripts/build-windows-sandbox-helper.mjs");
    expect(pkg.scripts["test:core"]).toContain("tests/filename-sanitizer.test.ts");
    expect(pkg.scripts["test:core"]).toContain("tests/local-user-account.test.ts");
    expect(pkg.scripts["test:core"]).toContain("tests/package-build-order.test.ts");
    expect(pkg.scripts["test:core"]).toContain("tests/audit-scripts.test.ts");
    expect(pkg.scripts["test:core"]).toContain("tests/build-server-runtime-assets.test.ts");
    expect(pkg.scripts["test:core"]).toContain("tests/renderer-build-contract.test.ts");
    expect(pkg.scripts["test:core"]).toContain("tests/mobile-static-route.test.ts");
    expect(pkg.scripts["test:core"]).toContain("tests/pwa-branding-contract.test.ts");
    expect(pkg.scripts["test:core"]).toContain("desktop/src/react/__tests__/mobile/MobileEntrySplit.test.ts");
    expect(pkg.scripts["test:core"]).toContain("tests/release-preflight-contract.test.ts");
    expect(pkg.scripts["test:core"]).toContain("tests/build-windows-sandbox-helper.test.ts");
    expect(pkg.scripts["test:core"]).toContain("tests/win32-policy.test.ts");
    expect(pkg.scripts["dist:win"]).toContain("build:win-release-resources");
    expect(pkg.scripts["build:win-release-resources"]).toContain("build:windows-sandbox-helper");
    const effectiveWindowsExtraResources = [
      ...(pkg.build.extraResources || []),
      ...(pkg.build.win.extraResources || []),
    ];
    expect(effectiveWindowsExtraResources).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: "dist-server/${os}-${arch}/", to: "server/" }),
      expect.objectContaining({ from: "desktop/src/screenshot-themes/", to: "screenshot-themes/" }),
      expect.objectContaining({ from: "vendor/git-portable", to: "git" }),
      expect.objectContaining({ from: "dist-sandbox/win-${arch}/", to: "sandbox/windows/" }),
    ]));
    expect(pkg.build.files).toEqual(expect.arrayContaining([
      "scripts/codiactl.mjs",
      "lib/cli/**",
    ]));

    const script = fs.readFileSync(path.join(root, "scripts", "release-preflight.mjs"), "utf-8");
    expect(script).toContain('"theme:audit"');
    expect(script).toContain('"theme:visual"');
    expect(script).toContain('"theme:screenshots"');
    expect(script).toContain('"surface:audit"');
    expect(script).toContain('"lint"');
    expect(script).toContain('"typecheck"');
    expect(script).toContain('"test:core"');
    expect(script).toContain('"test"');
    expect(script).toContain('"desktop:e2e"');
    expect(script).toContain('"build:server"');
    expect(script).toContain('"build:client"');
    expect(script).toContain('"package:surfaces"');
    expect(script).not.toContain('"surface:package-smoke"');
    expect(script).toContain("--skip-build");

    const buildServerScript = fs.readFileSync(path.join(root, "scripts", "build-server.mjs"), "utf-8");
    expect(buildServerScript).toContain("copyServerRuntimeAssets");
    expect(buildServerScript).toContain("build-server-runtime-assets.mjs");
    expect(buildServerScript).toContain('path.join(ROOT, "skills2set")');
    expect(buildServerScript).toContain('fs.cpSync(skillsSrc, path.join(outDir, "skills2set")');
    const serverViteConfig = fs.readFileSync(path.join(root, "vite.config.server.js"), "utf-8");
    expect(serverViteConfig).toContain('"node-pty"');

    const healthScript = fs.readFileSync(path.join(root, "scripts", "local-health-check.mjs"), "utf-8");
    expect(healthScript).toContain("cli:syntax");
    expect(healthScript).toContain("cli:runtime-syntax");
    expect(healthScript).toContain("lib/cli/main.ts");
    expect(healthScript).toContain("theme:audit");
    expect(healthScript).toContain("theme:visual");
    expect(healthScript).toContain("theme:screenshots");
    expect(healthScript).toContain("pwa:theme-behavior");
    expect(healthScript).toContain("surface:audit");
    expect(healthScript).toContain("lint:quiet");
    expect(healthScript).toContain("typecheck");
    expect(healthScript).toContain("test:core");
    expect(healthScript).toContain("build:server");
    expect(healthScript).toContain("build:client");

    const surfacePackageScript = fs.readFileSync(path.join(root, "scripts", "package-surface-artifacts.mjs"), "utf-8");
    expect(surfacePackageScript).toContain('process.platform === "win32" ? "npm.cmd" : "npm"');
    expect(surfacePackageScript).toContain("process.env.npm_execpath");
    expect(surfacePackageScript).toContain("runNpm");
    expect(surfacePackageScript).toContain("CompressionLevel]::Fastest");
    expect(surfacePackageScript).toContain('{ source: "lib/cli", to: "lib/cli" }');
    expect(surfacePackageScript).not.toContain('run("npm"');

    const pwaPackageScript = fs.readFileSync(path.join(root, "scripts", "package-pwa-release.ps1"), "utf-8");
    expect(pwaPackageScript).toContain("Resolve-NpmInvocation");
    expect(pwaPackageScript).toContain("$env:npm_execpath");
    expect(pwaPackageScript).toContain("surface-package-smoke.mjs");
    expect(pwaPackageScript).toContain('Invoke-Step "node" $smokeArgs');
    expect(pwaPackageScript).not.toContain('"run", "surface:package-smoke"');
    expect(pwaPackageScript).not.toContain('$npm = if ($env:OS -eq "Windows_NT")');

    const winPackageScript = fs.readFileSync(path.join(root, "scripts", "package-win-release.ps1"), "utf-8");
    expect(winPackageScript).toContain("Resolve-InstallerArtifactPath");
    expect(winPackageScript).toContain("Resolve-PackageVersionForPackaging");
    expect(winPackageScript).toContain("Increment-PackagePatchVersion");
    expect(winPackageScript).toContain("auto-incremented package version");
    expect(winPackageScript).toContain("Get-NormalizedWindowsArtifactVersion");
    expect(winPackageScript).toContain("normalizing installer artifact name");
    expect(winPackageScript).toContain("Test-PackagedDesktopE2E");
    expect(winPackageScript).toContain("Test-PrePackageHealth");
    expect(winPackageScript).toContain("local-health-check.mjs");
    expect(winPackageScript).toContain("--report=artifacts/local-health-check.json");
    expect(winPackageScript).toContain("Test-PackagedRuntimeSmoke");
    expect(winPackageScript).toContain("desktop-e2e-packaged-smoke.mjs");
    expect(winPackageScript).toContain("packaged-runtime-smoke.mjs");
    expect(winPackageScript).toContain("CODIA_E2E_DESKTOP_APP");
    expect(winPackageScript).toContain("CODIA_PACKAGE_SMOKE_BASE_URL");
    expect(winPackageScript).toContain("patch-electron-builder-win-asar-integrity.cjs");
    const electronBuilderPatchScript = fs.readFileSync(path.join(root, "scripts", "patch-electron-builder-win-asar-integrity.cjs"), "utf-8");
    expect(electronBuilderPatchScript).toContain("CODIA_WIN_ASAR_INTEGRITY_RETRY");
    expect(electronBuilderPatchScript).toContain("retryWinAsarIntegrityMutation");

    const packagedSmokeScript = fs.readFileSync(path.join(root, "scripts", "packaged-runtime-smoke.mjs"), "utf-8");
    expect(packagedSmokeScript).toContain("CODIA_PACKAGE_SMOKE_SCREENSHOTS");
    expect(packagedSmokeScript).toContain("/api/mobile/bootstrap");
    expect(packagedSmokeScript).toContain("/api/web-auth/login");
    expect(packagedSmokeScript).toContain("mobile-desktop-root");
    expect(packagedSmokeScript).toContain("waitForPwaShellReady");
    expect(packagedSmokeScript).toContain("captureSmokeScreenshot");
    expect(packagedSmokeScript).toContain("PWA identity visible");
    expect(winPackageScript).toContain('$psi.EnvironmentVariables["CODIA_PORT"] = "0"');
    expect(winPackageScript).not.toContain('@("playwright", "install", "chromium")');


    const resolverStart = winPackageScript.indexOf("function Resolve-InstallerArtifactPath");
    const resolverEnd = winPackageScript.indexOf("\nfunction ConvertTo-RootRelativePath", resolverStart);
    const resolverBody = winPackageScript.slice(resolverStart, resolverEnd);
    expect(resolverBody.indexOf("Get-NormalizedWindowsArtifactVersion")).toBeLessThan(
      resolverBody.indexOf("Test-Path -LiteralPath $ExpectedPath"),
    );
    expect(resolverBody).toContain("Move-Item -LiteralPath $normalizedPath -Destination $ExpectedPath -Force");
  });

  it("uses env-only remote debugging and a sanitized environment for packaged desktop E2E launches", async () => {
    const { desktopLaunchCommand, desktopLaunchEnv } = await import(pathToFileURL(path.join(root, "scripts", "e2e-desktop-launcher.mjs")).href);
    const previous = process.env.CODIA_E2E_DESKTOP_APP;
    const previousMode = process.env.CODIA_E2E_DESKTOP_MODE;
    const previousElectronRunAsNode = process.env.ELECTRON_RUN_AS_NODE;
    const extraArgs = ["--remote-debugging-port=12345", "--remote-allow-origins=*"];

    try {
      process.env.ELECTRON_RUN_AS_NODE = "1";
      delete process.env.CODIA_E2E_DESKTOP_APP;
      delete process.env.CODIA_E2E_DESKTOP_MODE;
      const source = desktopLaunchCommand(root, extraArgs);
      expect(source.mode).toBe("source");
      expect(source.args).toEqual(["scripts/launch.js", "electron", ...extraArgs]);
      expect(desktopLaunchEnv({ CODIA_E2E: "1" }).ELECTRON_RUN_AS_NODE).toBeUndefined();
      expect(desktopLaunchEnv({ CODIA_E2E: "1" }).CODIA_PORT).toBe("0");
      expect(desktopLaunchEnv({ CODIA_E2E: "1", CODIA_PORT: "32123" }).CODIA_PORT).toBe("32123");

      process.env.CODIA_E2E_DESKTOP_MODE = "built";
      const built = desktopLaunchCommand(root, extraArgs);
      expect(built.mode).toBe("built");
      expect(built.args).toEqual(["scripts/launch.js", "electron-built", ...extraArgs]);

      const packagedApp = path.join(root, "dist", "Codia.exe");
      process.env.CODIA_E2E_DESKTOP_APP = packagedApp;
      const packaged = desktopLaunchCommand(root, extraArgs);
      expect(packaged.mode).toBe("packaged");
      expect(packaged.command).toBe(packagedApp);
      expect(packaged.args).toEqual([]);
      expect(packaged.cwd).toBe(path.dirname(packagedApp));
    } finally {
      if (previousMode === undefined) delete process.env.CODIA_E2E_DESKTOP_MODE;
      else process.env.CODIA_E2E_DESKTOP_MODE = previousMode;
      if (previous === undefined) delete process.env.CODIA_E2E_DESKTOP_APP;
      else process.env.CODIA_E2E_DESKTOP_APP = previous;
      if (previousElectronRunAsNode === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
      else process.env.ELECTRON_RUN_AS_NODE = previousElectronRunAsNode;
    }
  });

  it("seeds isolated desktop E2E homes as professional edition without license activation", async () => {
    const { createIsolatedE2EHome, removeE2EHome } = await import(pathToFileURL(path.join(root, "scripts", "e2e-env.mjs")).href);
    const home = createIsolatedE2EHome({ mockBaseUrl: "http://127.0.0.1:9/v1" });
    try {
      const marker = JSON.parse(fs.readFileSync(path.join(home, ".ephemeral", "professional-edition.json"), "utf-8"));
      expect(marker).toMatchObject({
        edition: "professional",
        licenseRequired: false,
        features: ["full"],
      });
      const config = fs.readFileSync(path.join(home, 'agents', 'codia', 'config.yaml'), 'utf8');
      expect(config).toContain(path.join(home, 'workspace'));
      expect(fs.existsSync(path.join(home, 'workspace'))).toBe(true);
      expect(fs.existsSync(path.join(home, 'Desktop'))).toBe(true);
    } finally {
      removeE2EHome(home);
    }
  });
});
