#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const isWindows = process.platform === "win32";
const args = new Set(process.argv.slice(2));
const skipBuild = args.has("--skip-build");

const steps = [
  ["source-tree:audit", ["run", "audit:source-tree", "--", "--strict", "--report=artifacts/source-tree-audit.json", "--markdown=artifacts/source-tree-audit.md"]],
  ["theme:audit", ["run", "audit:theme", "--", "--report=artifacts/theme-token-audit.json", "--markdown=artifacts/theme-token-audit.md"]],
  ["theme:visual", ["run", "audit:theme-visual", "--", "--report=artifacts/theme-visual-audit.json", "--markdown=artifacts/theme-visual-audit.md"]],
  ["theme:screenshots", ["run", "audit:theme-screenshots", "--", "--report=artifacts/theme-screenshot-audit.json", "--markdown=artifacts/theme-screenshot-audit.md"]],
  ["ui:overlap", ["run", "e2e:ui-overlap", "--", "--report=artifacts/ui-overlap-regression/report.json", "--screenshots=artifacts/ui-overlap-regression", "--skip-missing-browser"]],
  ["surface:audit", ["run", "audit:surfaces", "--", "--report=artifacts/surface-feature-audit.json", "--markdown=artifacts/surface-feature-audit.md"]],
  ["lint", ["run", "lint", "--", "--quiet"]],
  ["typecheck", ["run", "typecheck"]],
  ["test:core", ["run", "test:core", "--", "--reporter=dot"]],
  ["test", ["test", "--", "--reporter=dot"]],
  ["package:size-trend", "node", ["scripts/package-size-trend.mjs", "--report=artifacts/package-size-trend.json", "--history=artifacts/package-size-trend-history.json"]],
];

if (!skipBuild) {
  steps.push(
    ["build:client", ["run", "build:client"]],
    ["build:server", ["run", "build:server"]],
    ["desktop:e2e", ["run", "e2e:desktop-smoke"]],
    ["package:surfaces", ["run", "package:surfaces", "--", "--skip-build"]],
  );
}

for (const [name, commandOrArgs, maybeArgs] of steps) {
  console.log(`\n==> ${name}`);
  const usesNpm = Array.isArray(commandOrArgs);
  const stepCommand = usesNpm ? "npm" : commandOrArgs;
  const stepArgs = usesNpm ? commandOrArgs : maybeArgs;
  const command = isWindows && stepCommand === "npm" ? "cmd.exe" : stepCommand;
  const commandArgs = isWindows && stepCommand === "npm" ? ["/d", "/s", "/c", "npm", ...stepArgs] : stepArgs;
  const result = spawnSync(command, commandArgs, {
    cwd: process.cwd(),
    stdio: "inherit",
    shell: false,
  });
  if (result.status !== 0) {
    if (result.error) console.error(`[release-preflight] ${result.error.message}`);
    console.error(`\n[release-preflight] ${name} failed with exit ${result.status ?? "unknown"}`);
    process.exit(result.status || 1);
  }
}

console.log("\n[release-preflight] checks passed");
