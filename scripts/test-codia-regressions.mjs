#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = process.cwd();
const vitestBin = path.join(ROOT, "node_modules", "vitest", "vitest.mjs");
const tests = [
  "desktop/src/react/__tests__/components/plan-mode-button-position.test.tsx",
  "desktop/src/react/__tests__/components/todo-display-tree.test.tsx",
  "desktop/src/react/__tests__/utils/screenshot.test.ts",
  "desktop/src/react/__tests__/components/channel-create-overlay-interaction.test.tsx",
  "desktop/src/react/__tests__/components/channel-workflow-window-contract.test.ts",
  "desktop/src/react/__tests__/components/channel-workflow-window-render.test.tsx",
  "desktop/src/react/__tests__/components/channel-company-task-tree.test.tsx",
  "desktop/src/react/__tests__/settings/InterfaceTabThemeButtons.test.tsx",
];

for (const testFile of tests) {
  const fullPath = path.join(ROOT, testFile);
  if (!fs.existsSync(fullPath)) {
    console.error(`[test-codia-regressions] missing test: ${testFile}`);
    process.exit(1);
  }
}

const result = spawnSync(process.execPath, [vitestBin, "run", ...tests], {
  cwd: ROOT,
  stdio: "inherit",
  shell: false,
});

if (result.status !== 0) {
  if (result.error) console.error(`[test-codia-regressions] ${result.error.message}`);
  process.exit(result.status || 1);
}
