import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const root = process.cwd();
const tempDirs = [];

function makeTempPackage(version = "0.217.0") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-version-bump-"));
  tempDirs.push(dir);
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "g-sap", version }, null, 2) + "\n",
    "utf-8",
  );
  fs.writeFileSync(
    path.join(dir, "package-lock.json"),
    JSON.stringify({
      name: "g-sap",
      version,
      lockfileVersion: 3,
      packages: {
        "": { name: "g-sap", version },
      },
    }, null, 2) + "\n",
    "utf-8",
  );
  return dir;
}

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("package version bumping", () => {
  it("increments package.json and root package-lock version from the 0.217.0 baseline", async () => {
    const { bumpPackageVersion } = await import(pathToFileURL(path.join(root, "scripts", "bump-package-version.mjs")).href);
    const dir = makeTempPackage("0.217.0");

    const result = bumpPackageVersion({ rootDir: dir });

    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf-8"));
    const lock = JSON.parse(fs.readFileSync(path.join(dir, "package-lock.json"), "utf-8"));
    expect(result).toEqual({ previousVersion: "0.217.0", nextVersion: "0.217.1" });
    expect(pkg.version).toBe("0.217.1");
    expect(lock.version).toBe("0.217.1");
    expect(lock.packages[""].version).toBe("0.217.1");
  });

  it("runs version bumping before npm Electron packaging scripts", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"));
    for (const scriptName of ["pack", "dist", "dist:win", "dist:linux"]) {
      expect(pkg.scripts[scriptName], `${scriptName} must bump version before building artifacts`)
        .toMatch(/^npm run bump:package-version && /);
    }

    expect(pkg.scripts["package:win"]).toBe("node scripts/package-gsap-win.mjs");
    expect(pkg.scripts["package:win"]).not.toContain("bump:package-version");
    expect(pkg.scripts["package:surfaces"]).toBe("node scripts/package-surface-artifacts.mjs");
    expect(pkg.scripts["package:surfaces"]).not.toContain("bump:package-version");
  });
});
