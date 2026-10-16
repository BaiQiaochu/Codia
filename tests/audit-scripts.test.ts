import fs from "fs";
import path from "path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import eslintConfig from "../eslint.config.js";

const root = process.cwd();

function runNode(args) {
  return spawnSync(process.execPath, args, {
    cwd: root,
    encoding: "utf-8",
  });
}

describe("audit scripts", () => {
  it("keeps generated artifact outputs outside eslint source scans", () => {
    const ignoreBlock = eslintConfig.find((entry) => Array.isArray(entry?.ignores));

    expect(ignoreBlock?.ignores).toContain("artifacts/**");
    expect(ignoreBlock?.ignores).toContain("desktop/dist-renderer/**");
    expect(ignoreBlock?.ignores).toContain("dist-server/**");
  });

  it("keeps theme token blockers out of status and diagnostic UI", () => {
    const report = path.join(root, "artifacts", "test-theme-token-audit.json");
    const result = runNode(["scripts/theme-token-audit.mjs", `--report=${report}`, "--json"]);
    expect(result.status).toBe(0);

    const data = JSON.parse(fs.readFileSync(report, "utf-8"));
    expect(data.ok).toBe(true);
    expect(data.counts.blockers).toBe(0);
    expect(data.counts.warnings).toBeGreaterThanOrEqual(0);
    expect(data.counts.ignored).toBeGreaterThan(0);
    const warningText = JSON.stringify(data.warnings);
    expect(warningText).not.toContain("rgba(var(--accent-rgb)");
    expect(warningText).not.toContain("rgba(var(--coral-rgb)");
    expect(warningText).not.toContain(".theme-card[data-theme=");
    expect(warningText).not.toContain("MediaViewer/MediaViewer.module.css");
    const ignoredReasons = new Set(data.ignored.map((item) => item.reason));
    expect(ignoredReasons).toContain("theme-card-preview-palette");
    expect(ignoredReasons).toContain("fixed-media-viewer-chrome");
  });

  it("audits desktop, PWA, and CLI feature parity from source contracts", () => {
    const report = path.join(root, "artifacts", "test-surface-feature-audit.json");
    const result = runNode(["scripts/surface-feature-audit.mjs", `--report=${report}`, "--json"]);
    expect(result.status).toBe(0);

    const data = JSON.parse(fs.readFileSync(report, "utf-8"));
    expect(data.ok).toBe(true);
    expect(data.matrix.surfaces).toEqual(["desktop", "pwa", "cli"]);
    expect(data.rows.every((row) => row.surfaces.desktop.ok && row.surfaces.pwa.ok && row.surfaces.cli.ok)).toBe(true);
    expect(JSON.stringify(data.rows)).toContain("CLI runtime modules");
    expect(JSON.stringify(data.rows)).toContain("Appearance settings");
  });

  it("audits theme visual tokens and baseline contrast without browser runtime", () => {
    const report = path.join(root, "artifacts", "test-theme-visual-audit.json");
    const result = runNode(["scripts/theme-visual-audit.mjs", `--report=${report}`, "--json"]);
    expect(result.status).toBe(0);

    const data = JSON.parse(fs.readFileSync(report, "utf-8"));
    expect(data.ok).toBe(true);
    expect(data.scannedThemes).toBeGreaterThan(0);
    expect(data.counts.blockers).toBe(0);
    expect(data.requiredAliasTokens).toContain("--text-secondary");
    expect(data.requiredAliasTokens).toContain("--bg-card-alt");
    expect(data.requiredAliasTokens).toContain("--text-link");
    expect(data.requiredAliasTokens).toContain("--text-error");
    expect(data.surfaces.every((surface) => surface.ok)).toBe(true);
  });

  it("exposes a dry-run artifacts cleanup script", () => {
    const result = runNode(["scripts/clean-artifacts.mjs", "--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("clean-artifacts");
    expect(result.stdout).toContain("--apply");
    expect(result.stdout).toContain("dry-run");
  });

  it("exposes the browser screenshot audit with setup guidance", () => {
    const result = runNode(["scripts/theme-screenshot-audit.mjs", "--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("theme-screenshot-audit");
    expect(result.stdout).toContain("--screenshots");
  });

  it("lets the UI overlap regression use an installed Edge runtime", () => {
    const source = fs.readFileSync(path.join(root, "scripts", "ui-overlap-regression.mjs"), "utf-8");
    expect(source).toContain("PLAYWRIGHT_CHROMIUM_CHANNEL");
    expect(source).toContain('"msedge"');
    expect(source).toContain("browserRuntime");
    expect(source).toContain("channel:${channel}");
  });

  it("lets the theme screenshot audit use an installed Edge runtime", () => {
    const source = fs.readFileSync(path.join(root, "scripts", "theme-screenshot-audit.mjs"), "utf-8");
    expect(source).toContain("PLAYWRIGHT_CHROMIUM_CHANNEL");
    expect(source).toContain('"msedge"');
    expect(source).toContain("browserRuntime");
    expect(source).toContain("channel:${channel}");
  });

  it("covers theme selector button states in the screenshot audit fixture", () => {
    const source = fs.readFileSync(path.join(root, "scripts", "theme-screenshot-audit.mjs"), "utf-8");
    expect(source).toContain('themeSelectorPanel("settings-theme-selector"');
    expect(source).toContain('themeSelectorPanel("onboarding-theme-selector"');
    expect(source).toContain('themeComparatorPanel("theme-preview-comparator"');
    expect(source).toContain('themeComparatorSurface("Desktop"');
    expect(source).toContain('themeComparatorSurface("PWA"');
    expect(source).toContain('themeComparatorSurface("Settings"');
    expect(source).toContain('themeComparatorSurface("Modal"');
    expect(source).toContain('data-theme-state="${state}"');
    expect(source).toContain('"hover"');
    expect(source).toContain('"disabled"');
    expect(source).toContain('"focus"');
  });

  it("audits React buttons for explicit button types", () => {
    const report = path.join(root, "artifacts", "test-react-button-type-audit.json");
    const result = runNode(["scripts/react-button-type-audit.mjs", `--report=${report}`, "--json"]);
    expect(result.status).toBe(0);

    const data = JSON.parse(fs.readFileSync(report, "utf-8"));
    expect(data.ok).toBe(true);
    expect(data.counts.blockers).toBe(0);
    expect(data.counts.buttons).toBeGreaterThan(0);
    expect(data.scannedFiles).toBeGreaterThan(0);
  });

  it("audits icon and action button UI guardrails", () => {
    const report = path.join(root, "artifacts", "test-react-action-button-audit.json");
    const result = runNode(["scripts/react-action-button-audit.mjs", `--report=${report}`, "--json"]);
    expect(result.status).toBe(0);

    const data = JSON.parse(fs.readFileSync(report, "utf-8"));
    expect(data.ok).toBe(true);
    expect(data.counts.blockers).toBe(0);
    expect(data.counts.guardedClasses).toBeGreaterThan(0);
    expect(data.requirements).toEqual(expect.arrayContaining([
      "fixed-size",
      "accessible-name",
      "disabled-state",
      "focus-visible",
    ]));
  });

  it("exposes a PWA theme behavior audit for mobile and access surfaces", () => {
    const result = runNode(["scripts/pwa-theme-behavior-audit.mjs", "--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("pwa-theme-behavior-audit");
    expect(result.stdout).toContain("/mobile/");
    expect(result.stdout).toContain("Access & Devices");
    expect(result.stdout).toContain("theme sync");
    expect(result.stdout).toContain("--screenshots");
  });

  it("lets the PWA theme behavior audit use an installed Edge runtime", () => {
    const source = fs.readFileSync(path.join(root, "scripts", "pwa-theme-behavior-audit.mjs"), "utf-8");
    expect(source).toContain("PLAYWRIGHT_CHROMIUM_CHANNEL");
    expect(source).toContain('"msedge"');
    expect(source).toContain("browserRuntime");
    expect(source).toContain("channel:${channel}");
  });

  it("builds the browser theme runtime before the PWA theme behavior audit copies it", () => {
    const source = fs.readFileSync(path.join(root, "scripts", "pwa-theme-behavior-audit.mjs"), "utf-8");
    expect(source).toContain("ensureThemeRuntime");
    expect(source).toContain("runNpmScript");
    expect(source).toContain("npm");
    expect(source).toContain("build:theme");
    expect(source).toContain("cmd.exe");
    expect(source).toContain('"/d"');
    expect(source).toContain('"/s"');
    expect(source).toContain('"/c"');
    expect(source).toContain("windowsHide: true");
    expect(source.indexOf("ensureThemeRuntime")).toBeLessThan(source.indexOf("prepareMobileDistFixture"));
  });

  it("captures PWA behavior screenshots and checks for visual blockers", () => {
    const source = fs.readFileSync(path.join(root, "scripts", "pwa-theme-behavior-audit.mjs"), "utf-8");
    expect(source).toContain("captureBehaviorScreenshot");
    expect(source).toContain("assertNoVisualBlockers");
    expect(source).toContain("pwa-theme-behavior-screenshots");
    expect(source).toContain("counts.screenshots");
    expect(source).toContain("mobile-legacy-theme-normalized");
    expect(source).toContain('window.setTheme("workbench")');
    expect(source).toContain("expectedStoredTheme: registry.DEFAULT_THEME");
    expect(source).toContain("access-devices");
  });

  it("audits HTML injection surfaces without blockers", () => {
    const report = path.join(root, "artifacts", "test-html-surface-audit.json");
    const result = runNode(["scripts/html-surface-audit.mjs", `--report=${report}`, "--json"]);
    expect(result.status).toBe(0);

    const data = JSON.parse(fs.readFileSync(report, "utf-8"));
    expect(data.ok).toBe(true);
    expect(data.counts.blockers).toBe(0);
    expect(data.scannedFiles).toBeGreaterThan(0);
    expect(data.surfaces.length).toBeGreaterThan(0);
    expect(data.allowed.every((item) => item.reason && item.reason !== "known static or sanitized HTML source")).toBe(true);
    expect(data.allowed.every((item) => !item.reason.includes("manual review required"))).toBe(true);
    expect(JSON.stringify(data.allowed)).toContain("artifact HTML iframe is sandboxed and tracked as the intentional artifact preview surface");
    expect(JSON.stringify(data.allowed)).not.toContain("artifact docx/xlsx/design preview HTML");
    expect(JSON.stringify(data.allowed)).toContain("plugin widget iframe is the intentional sandboxed plugin isolation boundary");
    expect(JSON.stringify(data.allowed)).toContain("markdown preview HTML is routed through the central sanitized markdown renderer");
    expect(JSON.stringify(data.allowed)).toContain("skill viewer markdown HTML is produced by renderMarkdownPreview()");
  });

  it("audits source text for mojibake blockers", () => {
    const report = path.join(root, "artifacts", "test-mojibake-audit.json");
    const result = runNode(["scripts/mojibake-audit.mjs", `--report=${report}`, "--json"]);
    expect(result.status).toBe(0);

    const data = JSON.parse(fs.readFileSync(report, "utf-8"));
    expect(data.ok).toBe(true);
    expect(data.counts.blockers).toBe(0);
    expect(data.counts.warnings).toBe(0);
    expect(data.scannedFiles).toBeGreaterThan(0);
    expect(data.scope).toEqual(expect.arrayContaining(["hub", "server", "lib", "core", "tests"]));
    const serialized = JSON.stringify(data);
    expect(serialized).not.toContain("injectAgentsMdDesc");
    expect(serialized).not.toContain("injectClaudeMdDesc");
    expect(serialized).not.toContain("cover-gallery-presets.js");
  });

  it("flags replacement-question-mark mojibake in scanned text", () => {
    const fixture = path.join(root, "tests", ".tmp-mojibake-question-mark-fixture.js");
    const report = path.join(root, "artifacts", "test-mojibake-question-mark-audit.json");
    fs.writeFileSync(
      fixture,
      `export const label = ${JSON.stringify("?".repeat(8))};\n`,
      "utf-8",
    );

    try {
      const result = runNode(["scripts/mojibake-audit.mjs", `--report=${report}`, "--json"]);
      expect([0, 1]).toContain(result.status);

      const data = JSON.parse(fs.readFileSync(report, "utf-8"));
      expect(data.counts.blockers).toBeGreaterThan(0);
      expect(JSON.stringify(data.blockers)).toContain(".tmp-mojibake-question-mark-fixture.js");
    } finally {
      fs.rmSync(fixture, { force: true });
    }
  });

  it("flags broken template interpolation mojibake in scanned text", () => {
    const fixture = path.join(root, "tests", ".tmp-mojibake-template-fixture.js");
    const report = path.join(root, "artifacts", "test-mojibake-template-audit.json");
    const brokenArrow = String.fromCodePoint(0x922b);
    fs.writeFileSync(
      fixture,
      `export const label = \`next ${brokenArrow}?{value}\`;\n`,
      "utf-8",
    );

    try {
      const result = runNode(["scripts/mojibake-audit.mjs", `--report=${report}`, "--json"]);
      expect([0, 1]).toContain(result.status);

      const data = JSON.parse(fs.readFileSync(report, "utf-8"));
      expect(data.counts.blockers).toBeGreaterThan(0);
      expect(JSON.stringify(data.blockers)).toContain(".tmp-mojibake-template-fixture.js");
    } finally {
      fs.rmSync(fixture, { force: true });
    }
  });

  it("flags mojibake in comments and stylesheet comments", () => {
    const tsFixture = path.join(root, "tests", ".tmp-mojibake-comment-fixture.ts");
    const cssFixture = path.join(root, "tests", ".tmp-mojibake-comment-fixture.css");
    const report = path.join(root, "artifacts", "test-mojibake-comment-audit.json");
    const brokenText = String.fromCharCode(0x93c3, 0x5815, 0x66b1);
    fs.writeFileSync(
      tsFixture,
      `// ${brokenText} should be caught even though this is comment-only\nexport const ok = true;\n`,
      "utf-8",
    );
    fs.writeFileSync(
      cssFixture,
      `/* ${brokenText} should be caught in stylesheet comments */\n.tmp { color: red; }\n`,
      "utf-8",
    );

    try {
      const result = runNode(["scripts/mojibake-audit.mjs", `--report=${report}`, "--json"]);
      expect([0, 1]).toContain(result.status);

      const data = JSON.parse(fs.readFileSync(report, "utf-8"));
      const blockers = JSON.stringify(data.blockers);
      expect(blockers).toContain(".tmp-mojibake-comment-fixture.ts");
      expect(blockers).toContain(".tmp-mojibake-comment-fixture.css");
    } finally {
      fs.rmSync(tsFixture, { force: true });
      fs.rmSync(cssFixture, { force: true });
    }
  });

  it("flags UTF-8 text decoded through the wrong Chinese code page", () => {
    const fixture = path.join(root, "tests", ".tmp-mojibake-cjk-fixture.ts");
    const report = path.join(root, "artifacts", "test-mojibake-cjk-audit.json");
    const brokenText = String.fromCodePoint(0x9471, 0x5a42, 0x3049, 0x7481, 0x677f, 0x7d8d);
    fs.writeFileSync(
      fixture,
      `export const label = ${JSON.stringify(brokenText)};\n`,
      "utf-8",
    );

    try {
      const result = runNode(["scripts/mojibake-audit.mjs", `--report=${report}`, "--json"]);
      expect([0, 1]).toContain(result.status);

      const data = JSON.parse(fs.readFileSync(report, "utf-8"));
      expect(data.counts.blockers).toBeGreaterThan(0);
      expect(JSON.stringify(data.blockers)).toContain(".tmp-mojibake-cjk-fixture.ts");
    } finally {
      fs.rmSync(fixture, { force: true });
    }
  });

  it("audits comments that appear to hide executable code", () => {
    const report = path.join(root, "artifacts", "test-comment-code-audit.json");
    const result = runNode(["scripts/comment-code-audit.mjs", `--report=${report}`, "--json"]);
    expect(result.status).toBe(0);

    const data = JSON.parse(fs.readFileSync(report, "utf-8"));
    expect(data.ok).toBe(true);
    expect(data.counts.blockers).toBe(0);
    expect(data.riskPatterns).toEqual(expect.arrayContaining([
      "// ... if (",
      "// ... window.",
      "// ... return",
    ]));
    expect(data.scannedFiles).toBeGreaterThan(0);
  });

  it("runs comment-code audit as part of local health checks", () => {
    const source = fs.readFileSync(path.join(root, "scripts", "local-health-check.mjs"), "utf-8");
    expect(source).toContain("comment-code:audit");
    expect(source).toContain("scripts/comment-code-audit.mjs");
    expect(source).toContain("artifacts/comment-code-audit.json");
  });

  it("detects untracked or deleted release source files before packaging", async () => {
    const audit = await import(pathToFileURL(path.join(root, "scripts", "source-tree-audit.mjs")).href);
    const report = audit.auditGitStatusText([
      "?? core/model-manager.ts",
      " D core/model-manager.js",
      "?? desktop/keep-awake.cjs",
      " D desktop/vscode-runtime.cjs",
      "D  core/legacy-runtime.js",
      "A  core/new-runtime.ts",
      "?? artifacts/test-output.json",
      " M desktop/main.bundle.cjs",
      " M docs/product-note.md",
      "RM lib/old-runtime.js -> lib/new-runtime.ts",
    ].join("\n"));

    expect(report.ok).toBe(false);
    expect(report.counts.blockers).toBe(4);
    expect(report.blockers.map((item) => item.path)).toEqual([
      "core/model-manager.ts",
      "core/model-manager.js",
      "desktop/keep-awake.cjs",
      "desktop/vscode-runtime.cjs",
    ]);
    expect(report.blockers.map((item) => item.kind)).toEqual([
      "untracked_release_source",
      "deleted_release_source",
      "untracked_release_source",
      "deleted_release_source",
    ]);
    expect(report.warnings.map((item) => item.path)).toEqual(expect.arrayContaining([
      "core/legacy-runtime.js",
      "core/new-runtime.ts",
      "lib/new-runtime.ts",
    ]));
    expect(report.warnings.map((item) => item.kind)).toEqual(expect.arrayContaining([
      "staged_deleted_release_source",
      "changed_release_source",
      "renamed_release_source",
    ]));
    expect(report.ignored.map((item) => item.path)).toEqual(expect.arrayContaining([
      "artifacts/test-output.json",
      "desktop/main.bundle.cjs",
      "docs/product-note.md",
    ]));
    expect(report.warnings.map((item) => item.path)).toContain("lib/new-runtime.ts");
  });

  it("wires source tree consistency audit into health and release checks", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"));
    const localHealth = fs.readFileSync(path.join(root, "scripts", "local-health-check.mjs"), "utf-8");
    const releasePreflight = fs.readFileSync(path.join(root, "scripts", "release-preflight.mjs"), "utf-8");
    const winPackage = fs.readFileSync(path.join(root, "scripts", "package-win-release.ps1"), "utf-8");

    expect(pkg.scripts["audit:source-tree"]).toBe("node scripts/source-tree-audit.mjs");
    for (const scriptName of ["pack", "dist", "dist:win", "dist:linux"]) {
      expect(pkg.scripts[scriptName]).toContain("npm run audit:source-tree -- --strict");
    }
    expect(localHealth).toContain("source-tree:audit");
    expect(localHealth).toContain("source-tree-audit.mjs");
    expect(localHealth).toContain("--strict");
    expect(releasePreflight).toContain("source-tree:audit");
    expect(releasePreflight).toContain("audit:source-tree");
    expect(winPackage).toContain("Test-SourceTreeConsistency");
    expect(winPackage).toContain("source-tree-audit.mjs");
  });
});
