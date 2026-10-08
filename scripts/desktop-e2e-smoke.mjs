#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const steps = [
  ["media-settings", "scripts/e2e-media-settings-defaults.mjs"],
  ["desk-workflow", "scripts/e2e-desk-workflow.mjs"],
  ["image-input", "scripts/e2e-image-input.mjs"],
];

for (const [name, script] of steps) {
  console.log(`\n==> desktop:e2e:${name}`);
  const result = spawnSync(process.execPath, [script], {
    cwd: process.cwd(),
    stdio: "inherit",
    shell: false,
  });
  if (result.status !== 0) {
    if (result.error) console.error(`[desktop-e2e] ${result.error.message}`);
    console.error(`[desktop-e2e] ${name} failed with exit ${result.status ?? "unknown"}`);
    process.exit(result.status || 1);
  }
}

console.log("\n[desktop-e2e] smoke checks passed");
