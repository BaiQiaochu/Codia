#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const args = new Set(process.argv.slice(2));
const skipBuild = args.has("--skip-build");
// Preserve local build/debug evidence unless cleanup was explicitly requested.
const cleanAfter = args.has("--clean-after") && !args.has("--keep-artifacts");
const jsonOnly = args.has("--json");
const reportArg = process.argv.find((arg) => arg.startsWith("--report="));
const reportPath = reportArg ? path.resolve(reportArg.slice("--report=".length)) : null;
const isWindows = process.platform === "win32";

const checks = [
  ["cli:syntax", "node", ["--check", "scripts/codiactl.mjs"]],
  ["cli:runtime-syntax", "node", ["--check", "lib/cli/main.ts"]],
  ["source-tree:audit", "node", ["scripts/source-tree-audit.mjs", "--strict", "--report=artifacts/source-tree-audit.json", "--markdown=artifacts/source-tree-audit.md"]],
  ["build:theme", "npm", ["run", "build:theme"]],
  ["theme:audit", "node", ["scripts/theme-token-audit.mjs", "--report=artifacts/theme-token-audit.json", "--markdown=artifacts/theme-token-audit.md"]],
  ["theme:visual", "node", ["scripts/theme-visual-audit.mjs", "--report=artifacts/theme-visual-audit.json", "--markdown=artifacts/theme-visual-audit.md"]],
  ["theme:screenshots", "node", ["scripts/theme-screenshot-audit.mjs", "--report=artifacts/theme-screenshot-audit.json", "--markdown=artifacts/theme-screenshot-audit.md"]],
  ["ui:overlap", "node", ["scripts/ui-overlap-regression.mjs", "--report=artifacts/ui-overlap-regression/report.json", "--screenshots=artifacts/ui-overlap-regression", "--skip-missing-browser"]],
  ["pwa:theme-behavior", "node", ["scripts/pwa-theme-behavior-audit.mjs", "--report=artifacts/pwa-theme-behavior-audit.json", "--markdown=artifacts/pwa-theme-behavior-audit.md"]],
  ["react-buttons:audit", "node", ["scripts/react-button-type-audit.mjs", "--report=artifacts/react-button-type-audit.json", "--markdown=artifacts/react-button-type-audit.md"]],
  ["react-action-buttons:audit", "node", ["scripts/react-action-button-audit.mjs", "--report=artifacts/react-action-button-audit.json", "--markdown=artifacts/react-action-button-audit.md"]],
  ["surface:audit", "node", ["scripts/surface-feature-audit.mjs", "--report=artifacts/surface-feature-audit.json", "--markdown=artifacts/surface-feature-audit.md"]],
  ["html:surface", "node", ["scripts/html-surface-audit.mjs", "--report=artifacts/html-surface-audit.json", "--markdown=artifacts/html-surface-audit.md"]],
  ["mojibake:audit", "node", ["scripts/mojibake-audit.mjs", "--report=artifacts/mojibake-audit.json", "--markdown=artifacts/mojibake-audit.md"]],
  ["comment-code:audit", "node", ["scripts/comment-code-audit.mjs", "--report=artifacts/comment-code-audit.json", "--markdown=artifacts/comment-code-audit.md"]],
  ["lint:quiet", "npm", ["run", "lint", "--", "--quiet"]],
  ["typecheck", "npm", ["run", "typecheck"]],
  ["test:core", "npm", ["run", "test:core", "--", "--reporter=dot"]],
];

if (skipBuild) {
  checks.push(["surface:package", "npm", ["run", "package:surfaces", "--", "--skip-build"]]);
}

checks.push(["package:size-trend", "node", ["scripts/package-size-trend.mjs", "--report=artifacts/package-size-trend.json", "--history=artifacts/package-size-trend-history.json"]]);

if (!skipBuild) {
  checks.push(
    ["build:client", "npm", ["run", "build:client"]],
    ["build:server", "npm", ["run", "build:server"]],
  );
}

const startedAt = new Date();
const results = [];

for (const [name, command, commandArgs] of checks) {
  if (!jsonOnly) console.log(`\n==> ${name}`);
  const started = Date.now();
  const result = spawn(command, commandArgs);
  const item = {
    name,
    command: [command, ...commandArgs].join(" "),
    status: result.status ?? 1,
    durationMs: Date.now() - started,
  };
  results.push(item);
  if (item.status !== 0) {
    item.error = result.error?.message || null;
    writeReport(false);
    process.exit(item.status || 1);
  }
}

if (cleanAfter) {
  await runCleanArtifacts();
}

writeReport(true);

function spawn(command, commandArgs) {
  if (isWindows && command === "npm") {
    return spawnSync("cmd.exe", ["/d", "/s", "/c", "npm", ...commandArgs], {
      cwd: process.cwd(),
      stdio: jsonOnly ? "pipe" : "inherit",
      shell: false,
      encoding: "utf-8",
    });
  }
  return spawnSync(command, commandArgs, {
    cwd: process.cwd(),
    stdio: jsonOnly ? "pipe" : "inherit",
    shell: false,
    encoding: "utf-8",
  });
}

function writeReport(ok) {
  const report = {
    ok,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    skippedBuild: skipBuild,
    cleanAfter,
    checks: results,
  };
  if (reportPath) {
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  if (jsonOnly) {
    console.log(JSON.stringify(report, null, 2));
  } else if (ok) {
    console.log("\n[local-health] checks passed");
    if (reportPath) console.log(`[local-health] report: ${reportPath}`);
  }
}

async function runCleanArtifacts() {
  const result = spawn("node", ["scripts/clean-artifacts.mjs", "--apply"]);
  if (result.status !== 0) {
    if (!jsonOnly) {
      console.error(`[local-health] clean:artifacts failed with exit ${result.status ?? "unknown"}`);
    }
    process.exit(result.status || 1);
  }
}
