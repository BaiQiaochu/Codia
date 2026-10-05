/**
 * Startup compatibility checks and data migrations.
 */

import { checkDirs } from "./checks/dirs.ts";
import { checkFactsDb } from "./checks/facts-db.ts";
import { checkConfigYaml } from "./checks/config-yaml.ts";
import { createModuleLogger } from "../debug-log.ts";

const moduleLog = createModuleLogger("compat");

const checks = [
  { name: "dirs", run: checkDirs },
  { name: "facts-db", run: checkFactsDb },
  { name: "config-yaml", run: checkConfigYaml },
];

type CompatContext = {
  agentDir: string;
  gsapHome?: string;
  hanakoHome?: string;
  log?: (msg: string) => void;
};

export async function runCompatChecks(ctx: CompatContext) {
  const log = ctx.log || (() => {});
  const checkContext = { ...ctx, log };
  let passed = 0;
  let fixed = 0;

  for (const check of checks) {
    try {
      const result = await check.run(checkContext);
      if (result?.fixed) {
        fixed++;
        log(`  [compat] ${check.name}: ${result.message || "已修复"}`);
      }
      passed++;
    } catch (err) {
      moduleLog.error(`${check.name} 检查失败（不影响启动）`, err);
    }
  }

  if (fixed > 0) {
    log(`  [compat] ${passed} 项检查完成，${fixed} 项已修复`);
  }
}
