#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const MAX_ATTEMPTS = 3;
const npmCliCandidates = [
  process.env.npm_execpath,
  path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
  path.resolve(path.dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
].filter(Boolean);
const npmCli = npmCliCandidates.find((candidate) => fs.existsSync(candidate));

if (!npmCli) {
  console.error("[ci-install] Unable to locate npm-cli.js for the active Node.js runtime.");
  process.exit(1);
}

function runNpm(args) {
  return spawnSync(process.execPath, [npmCli, ...args], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
    shell: false,
  });
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

let lastExitCode = 1;
for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
  console.log(`[ci-install] npm ci attempt ${attempt}/${MAX_ATTEMPTS}`);
  const result = runNpm(["ci", "--foreground-scripts", "--loglevel", "verbose"]);
  if (result.status === 0) {
    console.log(`[ci-install] dependencies installed on attempt ${attempt}`);
    process.exit(0);
  }

  lastExitCode = Number.isInteger(result.status) ? result.status : 1;
  console.error(
    `[ci-install] attempt ${attempt} failed${result.signal ? ` with signal ${result.signal}` : ` with exit code ${lastExitCode}`}`,
  );
  if (attempt < MAX_ATTEMPTS) {
    runNpm(["cache", "verify"]);
    await wait(attempt * 5_000);
  }
}

process.exit(lastExitCode);
