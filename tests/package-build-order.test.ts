import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const rootDir = process.cwd();

function packageScripts() {
  return JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf-8")).scripts;
}

function expectClientBeforeServer(scriptName, command) {
  const clientIndex = command.indexOf("npm run build:client");
  const serverIndex = command.indexOf("npm run build:server");
  expect(clientIndex, `${scriptName} must build renderer assets before server packaging`).toBeGreaterThanOrEqual(0);
  expect(serverIndex, `${scriptName} must build the server runtime`).toBeGreaterThanOrEqual(0);
  expect(clientIndex, `${scriptName} must copy a fresh /mobile renderer into the server runtime`).toBeLessThan(serverIndex);
}

function expectTextBefore(label, content, earlier, later) {
  const earlierIndex = content.indexOf(earlier);
  const laterIndex = content.indexOf(later);
  expect(earlierIndex, `${label} must include ${earlier}`).toBeGreaterThanOrEqual(0);
  expect(laterIndex, `${label} must include ${later}`).toBeGreaterThanOrEqual(0);
  expect(earlierIndex, `${label} must build renderer assets before server packaging`).toBeLessThan(laterIndex);
}

describe("package build order", () => {
  it("builds renderer assets before the server runtime for packaged apps", () => {
    const scripts = packageScripts();

    expectClientBeforeServer("pack", scripts.pack);
    expectClientBeforeServer("dist", scripts.dist);
    expectClientBeforeServer("dist:win", scripts["dist:win"]);
    expectClientBeforeServer("dist:linux", scripts["dist:linux"]);
  });

  it("builds renderer assets before the server runtime in local release checks", () => {
    expectTextBefore(
      "release preflight",
      fs.readFileSync(path.join(rootDir, "scripts", "release-preflight.mjs"), "utf-8"),
      '["build:client", ["run", "build:client"]]',
      '["build:server", ["run", "build:server"]]',
    );
    expectTextBefore(
      "local health check",
      fs.readFileSync(path.join(rootDir, "scripts", "local-health-check.mjs"), "utf-8"),
      '["build:client", "npm", ["run", "build:client"]]',
      '["build:server", "npm", ["run", "build:server"]]',
    );
    expectTextBefore(
      "Windows release packager",
      fs.readFileSync(path.join(rootDir, "scripts", "package-win-release.ps1"), "utf-8"),
      'Invoke-Step "npx" @("vite", "build", "--config", "vite.config.ts")',
      'Invoke-Step "node" @("scripts/build-server.mjs", "win32", $arch)',
    );
  });

  it("builds the bundled theme runtime before PWA theme behavior audit", () => {
    expectTextBefore(
      "local health check",
      fs.readFileSync(path.join(rootDir, "scripts", "local-health-check.mjs"), "utf-8"),
      '["build:theme", "npm", ["run", "build:theme"]]',
      '["pwa:theme-behavior", "node", ["scripts/pwa-theme-behavior-audit.mjs"',
    );
  });

  it("checks package artifact size trend before packaging health is accepted", () => {
    const localHealth = fs.readFileSync(path.join(rootDir, "scripts", "local-health-check.mjs"), "utf-8");
    const releasePreflight = fs.readFileSync(path.join(rootDir, "scripts", "release-preflight.mjs"), "utf-8");

    expect(fs.existsSync(path.join(rootDir, "scripts", "package-size-trend.mjs"))).toBe(true);
    expect(localHealth).toContain("package:size-trend");
    expect(localHealth).toContain("scripts/package-size-trend.mjs");
    expect(localHealth).toContain("artifacts/package-size-trend.json");
    expect(localHealth).toContain("artifacts/package-size-trend-history.json");
    expect(localHealth).toContain("--clean-after");
    expect(localHealth).toContain("clean:artifacts");
    expect(releasePreflight).toContain("package:size-trend");
    expect(releasePreflight).toContain("package-size-trend.mjs");
  });

  it("cleans generated artifacts by default before non-Windows npm packaging and after local health checks", () => {
    const scripts = packageScripts();
    const localHealth = fs.readFileSync(path.join(rootDir, "scripts", "local-health-check.mjs"), "utf-8");

    for (const name of ["pack", "dist", "dist:linux"]) {
      const cleanIndex = scripts[name].indexOf("npm run clean:artifacts -- --apply");
      const clientIndex = scripts[name].indexOf("npm run build:client");
      expect(cleanIndex, `${name} should clean generated artifacts before building`).toBeGreaterThanOrEqual(0);
      expect(clientIndex, `${name} should build client artifacts`).toBeGreaterThanOrEqual(0);
      expect(cleanIndex, `${name} should clean before building generated artifacts`).toBeLessThan(clientIndex);
    }
    expect(scripts["dist:win"]).not.toContain("npm run clean:artifacts -- --apply");
    expect(localHealth).toContain('args.has("--keep-artifacts")');
    expect(localHealth).toContain('args.has("--clean-after")');
    expect(localHealth).toContain('await runCleanArtifacts()');
    expect(localHealth).toContain('"--keep-artifacts"');
  });

  it("builds a Windows installer and folder portable output without single-file portable target", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf-8"));
    const distWin = pkg.scripts["dist:win"];
    const packageScript = fs.readFileSync(path.join(rootDir, "scripts", "package-gsap-win.mjs"), "utf-8");

    expect(distWin).toContain("electron-builder --win nsis dir");
    expect(distWin).not.toContain("electron-builder --win nsis portable");
    expect(pkg.build.nsis.artifactName).toBe("${productName}-${version}-Windows-${arch}.${ext}");
    expect(pkg.build.portable).toBeUndefined();
    expect(packageScript).toContain("scripts/package-win-release.ps1");
    expect(packageScript).toContain("-SkipTests");
    expect(packageScript).toContain("-SkipSmoke");
    expect(fs.readFileSync(path.join(rootDir, "scripts", "package-win-release.ps1"), "utf-8"))
      .toContain("Portable-Folder");
  });

  it("routes Windows packaging through the focused G-SAP regression suite", () => {
    const scripts = packageScripts();
    const packageScript = fs.readFileSync(path.join(rootDir, "scripts", "package-gsap-win.mjs"), "utf-8");
    const testScript = fs.readFileSync(path.join(rootDir, "scripts", "test-gsap-regressions.mjs"), "utf-8");

    expect(scripts["test:gsap-regressions"]).toBe("node scripts/test-gsap-regressions.mjs");
    expect(scripts["package:win"]).toBe("node scripts/package-gsap-win.mjs");
    expect(packageScript).toContain('["run", "test:gsap-regressions"]');
    expect(packageScript).toContain("scripts/package-win-release.ps1");
    expect(testScript).toContain("plan-mode-button-position.test.tsx");
    expect(testScript).toContain("todo-display-tree.test.tsx");
    expect(testScript).toContain("screenshot.test.ts");
    expect(testScript).toContain("channel-create-overlay-interaction.test.tsx");
    expect(testScript).toContain("channel-workflow-window-contract.test.ts");
    expect(testScript).toContain("channel-workflow-window-render.test.tsx");
    expect(testScript).toContain("channel-company-task-tree.test.tsx");
    expect(testScript).toContain("InterfaceTabThemeButtons.test.tsx");
  });

  it("does not prepare or package a desktop VS Code runtime", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf-8"));
    const scripts = pkg.scripts;

    expect(scripts["prepare:vscode-runtime"]).toBeUndefined();
    expect(scripts.pack).not.toContain("prepare:vscode-runtime");
    expect(scripts.dist).not.toContain("prepare:vscode-runtime");
    expect(scripts["dist:win"]).not.toContain("prepare:vscode-runtime");
    expect(scripts["dist:linux"]).not.toContain("prepare:vscode-runtime");
    expect(JSON.stringify(pkg.build.extraResources)).not.toContain("vscode-main");
    expect(fs.existsSync(path.join(rootDir, "scripts", "prepare-vscode-runtime.cjs"))).toBe(false);
    expect(fs.readFileSync(path.join(rootDir, "scripts", "package-gsap-win.mjs"), "utf-8"))
      .not.toContain("prepare:vscode-runtime");
    expect(fs.readFileSync(path.join(rootDir, "scripts", "fix-modules.cjs"), "utf-8"))
      .not.toContain("assertPackagedVscodeRuntimeReady");
  });

  it("generates server runtime wrappers without duplicate environment assignments", () => {
    const buildServer = fs.readFileSync(path.join(rootDir, "scripts", "build-server.mjs"), "utf-8");

    expect(buildServer).toContain("--loglevel=error");
    expect((buildServer.match(/set "GSAP_ROOT=%~dp0"/g) || [])).toHaveLength(1);
    expect((buildServer.match(/set "GSAP_SERVER_ENTRY=%~dp0bundle\\\\index\.js"/g) || [])).toHaveLength(1);
    expect((buildServer.match(/export GSAP_ROOT="\$DIR"/g) || [])).toHaveLength(1);
    expect((buildServer.match(/export GSAP_SERVER_ENTRY="\$DIR\/bundle\/index\.js"/g) || [])).toHaveLength(1);
  });
});
