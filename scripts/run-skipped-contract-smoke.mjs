import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const allExplicitSkipTests = [
  "tests/agent-executor-teardown.test.ts",
  "tests/agent-manager-create-defaults.test.ts",
  "tests/agent-platform-prompt.test.ts",
  "tests/agent-switch-workspace.test.ts",
  "tests/bridge-manager-rc-attached.test.ts",
  "tests/bridge-route-sessions.test.ts",
  "tests/bridge-session-teardown.test.ts",
  "tests/bridge-status.test.ts",
  "tests/bridge-strip-internal-tags.test.ts",
  "tests/browser-search-extractors.test.ts",
  "tests/browser-tool-schema.test.ts",
  "tests/server-startup-diagnostics-contract.test.ts",
  "tests/computer-use-macos-cua-provider.test.ts",
];
const filters = process.argv.slice(2);
const explicitSkipTests = filters.length > 0
  ? allExplicitSkipTests.filter((testPath) => filters.some((filter) => testPath.includes(filter)))
  : allExplicitSkipTests;
if (explicitSkipTests.length === 0) {
  throw new Error(`No skipped-contract smoke tests match: ${filters.join(", ")}`);
}

const generated = [];
const reportPath = path.join(root, "artifacts", "desktop-full-smoke", "skipped-contract-smoke.json");

function activateSkippedContracts(source) {
  return source
    .replaceAll("describe.skip(", "describe(")
    .replaceAll("it.skip(", "it(")
    .replaceAll("it.skipIf(!isMacOS)(", "it(");
}

try {
  for (const relativePath of explicitSkipTests) {
    const sourcePath = path.join(root, relativePath);
    const generatedPath = sourcePath.replace(/\.test\.ts$/u, ".skipped-smoke.generated.test.ts");
    fs.writeFileSync(generatedPath, activateSkippedContracts(fs.readFileSync(sourcePath, "utf8")), "utf8");
    generated.push(generatedPath);
  }

  const args = [
    path.join(root, "node_modules", "vitest", "vitest.mjs"),
    "run",
    ...generated,
    "--reporter=json",
    `--outputFile=${reportPath}`,
  ];
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    env: { ...process.env, GSAP_SKIPPED_CONTRACT_SMOKE: "1" },
    stdio: "inherit",
  });
  if (fs.existsSync(reportPath)) {
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    console.log(JSON.stringify({
      passed: report.numPassedTests,
      failed: report.numFailedTests,
      skipped: report.numPendingTests,
      reportPath,
    }, null, 2));
  }
  process.exitCode = result.status ?? 1;
} finally {
  for (const generatedPath of generated) {
    fs.rmSync(generatedPath, { force: true });
  }
}
