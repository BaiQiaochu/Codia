import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function readPackageJson() {
  return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
}

describe("electron-builder native rebuild contract", () => {
  it("does not rebuild server native addons against Electron ABI", () => {
    const pkg = readPackageJson();

    expect(pkg.build.npmRebuild).toBe(false);
    expect(pkg.build.files).toContain("!**/node_modules/**");
    expect(pkg.build.files).toContain("node_modules/ws/**");
    expect(pkg.build.files).not.toContain("node_modules/better-sqlite3/**");
  });
});
