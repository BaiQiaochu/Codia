import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

describe("Linux preview build configuration", () => {
  it("keeps Linux targets outside the source-only release workflow", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf-8"));
    const workflow = fs.readFileSync(path.join(process.cwd(), ".github", "workflows", "build.yml"), "utf-8");

    expect(pkg.scripts["dist:linux"]).toMatch(/electron-builder --linux/);
    expect(pkg.build.linux.target).toEqual(expect.arrayContaining(["AppImage", "deb"]));
    expect(pkg.build.linux.maintainer).toMatch(/^.+ <.+@.+>$/);
    expect(pkg.build.linux.artifactName).toContain("Linux");
    expect(workflow).toContain("runs-on: ubuntu-latest");
    expect(workflow).toContain("Source code (zip)");
    expect(workflow).not.toContain("electron-builder");
    expect(workflow).not.toContain("dist:linux");
  });
});
