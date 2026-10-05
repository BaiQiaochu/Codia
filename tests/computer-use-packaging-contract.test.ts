import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const fixModules = require("../scripts/fix-modules.cjs").default;

const tempDirs = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-computer-use-packaging-"));
  tempDirs.push(dir);
  return dir;
}

function makeMacAfterPackContext(appOutDir) {
  return {
    appOutDir,
    arch: 3,
    packager: {
      platform: { name: "mac" },
      appInfo: { productFilename: "G-SAP" },
    },
  };
}

function resourcesDir(appOutDir) {
  return path.join(appOutDir, "G-SAP.app", "Contents", "Resources");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("Computer Use packaging contract", () => {
  it("fails macOS afterPack when the helper binary is missing from app resources", async () => {
    const appOutDir = makeTempDir();
    fs.mkdirSync(resourcesDir(appOutDir), { recursive: true });

    await expect(fixModules(makeMacAfterPackContext(appOutDir))).rejects.toThrow(
      /Computer Use helper missing/,
    );
  });

  it("runs the helper build before macOS electron-builder packaging", () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8"));

    expect(pkg.scripts.pack).toContain("npm run build:computer-use-helper");
    expect(pkg.scripts.dist).toContain("npm run build:computer-use-helper");
    expect(pkg.build.mac.extraResources).toContainEqual({
      from: "dist-computer-use/mac-${arch}/",
      to: "computer-use/macos/",
    });
  });

  it("keeps the Windows release script aligned with packaged helper resources", () => {
    const script = fs.readFileSync(path.resolve("scripts", "package-win-release.ps1"), "utf8");

    expect(script).toContain('Invoke-Step "node" @("scripts/build-computer-use-helper.mjs")');
  });

  it("does not prepare or ship the removed desktop VS Code runtime during release packaging", () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8"));
    const winPackageScript = fs.readFileSync(path.resolve("scripts", "package-win-release.ps1"), "utf8");

    expect(pkg.scripts["prepare:vscode-runtime"]).toBeUndefined();
    expect(pkg.scripts.pack).not.toContain("prepare:vscode-runtime");
    expect(pkg.scripts.dist).not.toContain("prepare:vscode-runtime");
    expect(pkg.scripts["dist:win"]).not.toContain("prepare:vscode-runtime");
    expect(pkg.scripts["dist:linux"]).not.toContain("prepare:vscode-runtime");
    expect(JSON.stringify(pkg.build.extraResources)).not.toContain("vscode-main");
    expect(winPackageScript).not.toContain('Invoke-Step "npm" @("run", "prepare:vscode-runtime")');
    expect(winPackageScript).not.toContain('Test-PackagedVscodeRuntime');
  });
});
