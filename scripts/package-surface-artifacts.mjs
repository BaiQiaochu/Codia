#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = process.cwd();
const args = new Set(process.argv.slice(2));
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const stageDir = path.join(ROOT, "artifacts", "surface-package");
const outFile = path.join(ROOT, "artifacts", `codia-surfaces-${process.platform}-${process.arch}.zip`);

const entries = [
  { source: "desktop/dist-renderer", to: "desktop/dist-renderer" },
  { source: "dist-server-bundle/index.js", to: "server/index.js" },
  { source: "lib/cli", to: "lib/cli" },
  { source: "scripts/codiactl.mjs", to: "scripts/codiactl.mjs" },
  { source: "package.json", to: "package.json" },
];

if (!args.has("--skip-build")) {
  runNpm(["run", "build:client"]);
  runNpm(["run", "build:server"]);
}

fs.rmSync(stageDir, { recursive: true, force: true });
fs.mkdirSync(stageDir, { recursive: true });

for (const entry of entries) {
  const from = path.join(ROOT, entry.source);
  if (!fs.existsSync(from)) continue;
  const to = path.join(stageDir, entry.to);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true });
}

fs.rmSync(outFile, { force: true });
zipDirectory(stageDir, outFile);
console.log(`[package-surface-artifacts] wrote ${path.relative(ROOT, outFile).replace(/\\/g, "/")}`);

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, {
    cwd: ROOT,
    stdio: "inherit",
    shell: false,
  });
  if (result.status !== 0) {
    if (result.error) console.error(`[package-surface-artifacts] ${result.error.message}`);
    process.exit(result.status || 1);
  }
}

function runNpm(commandArgs) {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath && fs.existsSync(npmExecPath)) {
    run(process.execPath, [npmExecPath, ...commandArgs]);
    return;
  }
  run(npmCommand, commandArgs);
}

function zipDirectory(sourceDir, targetFile) {
  if (process.platform === "win32") {
    const script = [
      "Add-Type -AssemblyName System.IO.Compression.FileSystem",
      `$source = ${quotePs(sourceDir)}`,
      `$target = ${quotePs(targetFile)}`,
      "if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Force }",
      "[System.IO.Compression.ZipFile]::CreateFromDirectory($source, $target, [System.IO.Compression.CompressionLevel]::Fastest, $false)",
    ].join("\n");
    run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script]);
    return;
  }
  run("tar", ["-a", "-cf", targetFile, "-C", sourceDir, "."]);
}

function quotePs(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}
