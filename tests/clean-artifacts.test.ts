import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupArtifacts, planArtifactCleanup } from "../scripts/clean-artifacts.mjs";

describe("artifacts cleanup", () => {
  let tempRoot = null;

  afterEach(() => {
    if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  });

  function makeArtifacts() {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codia-artifacts-clean-"));
    const artifactsDir = path.join(tempRoot, "artifacts");
    fs.mkdirSync(path.join(artifactsDir, "theme-screenshots"), { recursive: true });
    fs.mkdirSync(path.join(artifactsDir, "pwa-theme-behavior-screenshots"), { recursive: true });
    fs.mkdirSync(path.join(artifactsDir, "ui-overlap-regression"), { recursive: true });
    fs.mkdirSync(path.join(artifactsDir, "cli-package"), { recursive: true });
    fs.writeFileSync(path.join(artifactsDir, "theme-token-audit.json"), "{}", "utf-8");
    fs.writeFileSync(path.join(artifactsDir, "theme-token-audit.md"), "# latest\n", "utf-8");
    fs.writeFileSync(path.join(artifactsDir, "comment-code-audit.json"), "{}", "utf-8");
    fs.writeFileSync(path.join(artifactsDir, "comment-code-audit.md"), "# latest\n", "utf-8");
    fs.writeFileSync(path.join(artifactsDir, "local-health-check.json"), "{}", "utf-8");
    fs.writeFileSync(path.join(artifactsDir, "package-size-trend.json"), "{}", "utf-8");
    fs.writeFileSync(path.join(artifactsDir, "package-size-trend-baseline.json"), "{}", "utf-8");
    fs.writeFileSync(path.join(artifactsDir, "package-size-trend-history.json"), "{}", "utf-8");
    fs.writeFileSync(path.join(artifactsDir, "theme-screenshot-fixture.html"), "<html></html>", "utf-8");
    fs.writeFileSync(path.join(artifactsDir, "test-theme-token-audit.json"), "{}", "utf-8");
    fs.writeFileSync(path.join(artifactsDir, "debug-mojibake.json"), "{}", "utf-8");
    fs.writeFileSync(path.join(artifactsDir, "cli-package", "old.zip"), "zip", "utf-8");
    return artifactsDir;
  }

  it("plans only non-canonical reports and non-screenshot artifact directories", () => {
    const artifactsDir = makeArtifacts();
    const plan = planArtifactCleanup({ artifactsDir });
    const removePaths = plan.remove.map((item) => path.basename(item.path)).sort();
    const keepPaths = plan.keep.map((item) => path.basename(item.path)).sort();

    expect(removePaths).toEqual(["cli-package", "debug-mojibake.json", "test-theme-token-audit.json"]);
    expect(keepPaths).toEqual(expect.arrayContaining([
      "local-health-check.json",
      "comment-code-audit.json",
      "comment-code-audit.md",
      "package-size-trend.json",
      "package-size-trend-baseline.json",
      "package-size-trend-history.json",
      "pwa-theme-behavior-screenshots",
      "theme-screenshot-fixture.html",
      "theme-screenshots",
      "theme-token-audit.json",
      "theme-token-audit.md",
      "ui-overlap-regression",
    ]));
  });

  it("defaults to dry-run and only deletes candidates when apply is explicit", () => {
    const artifactsDir = makeArtifacts();

    const dryRun = cleanupArtifacts({ artifactsDir, apply: false });
    expect(dryRun.removed).toEqual([]);
    expect(fs.existsSync(path.join(artifactsDir, "test-theme-token-audit.json"))).toBe(true);

    const applied = cleanupArtifacts({ artifactsDir, apply: true });
    expect(applied.removed.map((item) => path.basename(item.path)).sort()).toEqual([
      "cli-package",
      "debug-mojibake.json",
      "test-theme-token-audit.json",
    ]);
    expect(fs.existsSync(path.join(artifactsDir, "test-theme-token-audit.json"))).toBe(false);
    expect(fs.existsSync(path.join(artifactsDir, "cli-package"))).toBe(false);
    expect(fs.existsSync(path.join(artifactsDir, "theme-token-audit.json"))).toBe(true);
    expect(fs.existsSync(path.join(artifactsDir, "comment-code-audit.json"))).toBe(true);
    expect(fs.existsSync(path.join(artifactsDir, "package-size-trend-baseline.json"))).toBe(true);
    expect(fs.existsSync(path.join(artifactsDir, "package-size-trend-history.json"))).toBe(true);
    expect(fs.existsSync(path.join(artifactsDir, "theme-screenshots"))).toBe(true);
    expect(fs.existsSync(path.join(artifactsDir, "ui-overlap-regression"))).toBe(true);
  });
});
