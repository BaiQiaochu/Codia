import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function read(relPath) {
  return fs.readFileSync(path.join(root, relPath), "utf8");
}

describe("Playwright UI overlap regression contract", () => {
  it("exposes one screenshot and DOM bounding-box regression for the critical UI surfaces", () => {
    const scriptPath = path.join(root, "scripts", "ui-overlap-regression.mjs");
    expect(fs.existsSync(scriptPath)).toBe(true);

    const script = read("scripts/ui-overlap-regression.mjs");
    const pkg = JSON.parse(read("package.json"));

    expect(pkg.scripts["e2e:ui-overlap"]).toBe("node scripts/ui-overlap-regression.mjs");
    expect(script).toContain("artifacts/ui-overlap-regression");
    expect(script).toContain("page.screenshot");
    expect(script).toContain("getBoundingClientRect");
    expect(script).toContain("overlapArea");
    expect(script).toContain("thresholds");
    expect(script).toContain("selectorFor");
    expect(script).toContain("captureBlockerCrops");
    expect(script).toContain("failure-crops");
    expect(script).toContain("crop");
    expect(script).toContain("boundingBox");
    expect(script).toContain("cropRect");
    expect(script).toContain("--skip-missing-browser");
    expect(script).toContain("MISSING_BROWSER_EXIT_CODE");
    expect(script).toContain("isMissingBrowserRuntime");

    for (const surface of ["settings", "reader", "chat", "workflow"]) {
      expect(script).toContain(`id: "${surface}"`);
      expect(script).toContain(`${surface}.png`);
    }
  });

  it("runs the overlap regression from local and release health checks", () => {
    const localHealth = read("scripts/local-health-check.mjs");
    const releasePreflight = read("scripts/release-preflight.mjs");

    expect(localHealth).toContain("ui:overlap");
    expect(localHealth).toContain("scripts/ui-overlap-regression.mjs");
    expect(localHealth).toContain("artifacts/ui-overlap-regression/report.json");
    expect(localHealth).toContain("--skip-missing-browser");
    expect(releasePreflight).toContain("ui:overlap");
    expect(releasePreflight).toContain("e2e:ui-overlap");
    expect(releasePreflight).toContain("--skip-missing-browser");
  });

  it("provides a China mirror installer for bundled Playwright Chromium", () => {
    const pkg = JSON.parse(read("package.json"));
    const installer = read("scripts/install-playwright-cn.mjs");

    expect(pkg.scripts["install:playwright-cn"]).toBe("node scripts/install-playwright-cn.mjs");
    expect(installer).toContain("registry.npmmirror.com/-/binary");
    expect(installer).toContain("chrome-for-testing");
    expect(installer).toContain("chromium.launch");
    expect(installer).toContain("bundled Chromium ready");
  });
});
