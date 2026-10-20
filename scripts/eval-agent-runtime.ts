import fs from 'node:fs';
import path from 'node:path';
import { runRuntimeCases } from '../evals/agent-runtime-cases.ts';
import { runLiveRuntimeCase } from '../evals/agent-runtime-live.ts';

const args = process.argv.slice(2);
let output = path.resolve('artifacts/agent-runtime.json');
let liveConfig: string | undefined;
let allowModelCalls = false;
let requireAll = false;
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (arg === '--output' || arg === '--live-config') {
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(`${arg} requires a file path`);
    if (arg === '--output') output = path.resolve(value); else liveConfig = value;
  } else if (arg === '--allow-model-calls') allowModelCalls = true;
  else if (arg === '--require-all') requireAll = true;
  else throw new Error(`Unknown option: ${arg}`);
}
if (Boolean(liveConfig) !== allowModelCalls) throw new Error('Live evaluation requires both --live-config and --allow-model-calls.');
const rows = liveConfig
  ? await runLiveRuntimeCase(JSON.parse(fs.readFileSync(liveConfig, 'utf8')))
  : await runRuntimeCases();
const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), mode: liveConfig ? 'live-model-smoke' : 'deterministic-runtime-mechanisms',
  realModelSuccessRate: liveConfig ? rows.filter(row => row.status === 'passed').length / rows.length : null,
  paidModelCalls: liveConfig ? null : 0, costKnown: !liveConfig, productionConfigurationRead: false,
  passed: rows.filter(row => row.status === 'passed').length,
  failed: rows.filter(row => row.status === 'failed').length,
  environmentBlocked: rows.filter(row => row.status === 'environment_blocked').length, cases: rows };
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ output, passed: report.passed, failed: report.failed, environmentBlocked: report.environmentBlocked }));
if (report.failed || (requireAll && report.environmentBlocked)) process.exitCode = 1;
