#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const powershellCommand = process.platform === "win32" ? "powershell.exe" : "pwsh";
const args = new Set(process.argv.slice(2));
const root = process.cwd();

const steps = [
  ...(args.has("--skip-tests") ? [] : [["regressions", npmCommand, ["run", "test:codia-regressions"]]]),
  [
    "windows release",
    powershellCommand,
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      "scripts/package-win-release.ps1",
      "-SkipTests",
      ...(args.has("--smoke") ? [] : ["-SkipSmoke"]),
    ],
  ],
];

for (const [name, command, commandArgs] of steps) {
  console.log(`\n==> ${name}`);
  runCommand(command, commandArgs);
}

function runCommand(command, commandArgs) {
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    if (result.error) console.error(`[package-codia-win] ${result.error.message}`);
    process.exit(result.status || 1);
  }
}
