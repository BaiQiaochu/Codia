import fs from "fs";
import path from "path";
import process from "node:process";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("Windows package titlebar drag-region contract", () => {
  it("checks renderer drag CSS before packaging and inside the portable app.asar", () => {
    const script = fs.readFileSync(path.join(root, "scripts", "package-win-release.ps1"), "utf8");

    expect(script).toContain("function Test-PackagedRendererDragRegion");
    expect(script).toContain("desktop\\dist-renderer\\styles.css");
    expect(script).toContain("node_modules");
    expect(script).toContain("@electron");
    expect(script).toContain("asar");
    expect(script).toContain("Test-PackagedRendererDragRegion -Root $root -SourceOnly");
    expect(script).toContain("Test-PackagedRendererDragRegion -Root $root -PortableDir $portableDir");
    expect(script).toContain("pointer-events:\\s*auto");
    expect(script).toContain("-webkit-app-region:\\s*drag");
    expect(script).toContain("tb-left-group");
    expect(script).toContain("tb-toggle");
    expect(script).toContain("obsidian-ide-menu");
    expect(script).toContain("window-controls");
  });

  it("does not require the removed packaged desktop VS Code runtime before accepting portable artifacts", () => {
    const script = fs.readFileSync(path.join(root, "scripts", "package-win-release.ps1"), "utf8");

    expect(script).not.toContain("function Test-PackagedVscodeRuntime");
    expect(script).not.toContain("resources\\vscode-main");
    expect(script).not.toContain("scripts\\code.bat");
    expect(script).not.toContain("Test-PackagedVscodeRuntime -PortableDir");
    expect(script).not.toContain("build\\lib\\extensions.js");
    expect(script).not.toContain("node_modules\\@vscode\\test-web");
    expect(script).not.toContain("out\\vs\\workbench\\workbench.web.main.js");
  });
});
