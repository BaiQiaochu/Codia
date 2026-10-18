#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createReferenceModelAdapter, loadModelTaskDataset, runModelTaskEvaluation, parseModelTaskReport } from './model-task-evaluation.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const USAGE = `Usage: node scripts/model-task-evaluation-cli.mjs [--mock | --live --adapter <trusted-local.mjs>] [--output <report.json>] [--baseline <report.json>] [--timeout-ms <milliseconds>]
Default: disabled, no adapter loaded and no model calls. --mock only validates the harness.
Live adapters must export createAdapter() returning {mode:'live', versions, generate(request)}.
Bundled configured adapter: scripts/model-task-evaluation-configured-adapter.mjs.
Live execution can transmit the public fixture prompts and incur provider charges. See docs/implementation/model-task-evaluation.md.`;

export async function runModelTaskEvaluationCli(args = process.argv.slice(2), { stdout = console.log, stderr = console.error } = {}) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (['--mock', '--live', '--help'].includes(arg)) {
      if (options[arg.slice(2)]) throw new Error('Duplicate option.');
      options[arg.slice(2)] = true;
    } else if (['--adapter', '--output', '--baseline', '--timeout-ms'].includes(arg)) {
      if (options[arg.slice(2)] || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error('Missing or duplicate option value.');
      options[arg.slice(2)] = args[++index];
    } else throw new Error('Unknown evaluation option.');
  }
  if (options.help) { stdout(USAGE); return 0; }
  if (options.mock && options.live) throw new Error('Choose mock or live mode, never both.');
  if (options.adapter && !options.live) throw new Error('Adapters are loaded only with --live.');
  if (options.live && !options.adapter) throw new Error('Live mode requires an explicitly configured local adapter.');
  const timeoutMs = options['timeout-ms'] === undefined ? 30_000 : Number(options['timeout-ms']);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw new Error('Invalid per-task timeout.');
  const dataset = loadModelTaskDataset();
  // Validate the baseline before loading executable adapter code or making calls.
  const baseline = options.baseline ? parseModelTaskReport(JSON.parse(fs.readFileSync(path.resolve(options.baseline), 'utf8'))) : null;
  let adapter;
  if (options.mock) adapter = createReferenceModelAdapter(dataset);
  if (options.live) {
    const adapterPath = path.resolve(options.adapter);
    if (!/\.(?:mjs|js)$/.test(adapterPath) || !fs.statSync(adapterPath).isFile()) throw new Error('Adapter must be a trusted local JavaScript module.');
    const module = await import(pathToFileURL(adapterPath).href);
    if (typeof module.createAdapter !== 'function') throw new Error('Adapter must export createAdapter().');
    adapter = await module.createAdapter();
    if (adapter?.mode !== 'live') throw new Error('Live mode requires a live adapter, not a mock.');
  }
  const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  const status = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' });
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  let report;
  try {
    report = await runModelTaskEvaluation({ dataset, adapter, allowLive: options.live === true, versions: adapter?.versions || { provider: 'reference-fixture', model: 'reference-answer', prompt: 'v1', template: 'bounded-json-v1', strategy: 'single-agent' }, timeoutMs, baseline, signal: controller.signal,
      revision: revision.status === 0 ? revision.stdout.trim() : null, workingTree: status.status !== 0 ? 'unknown' : status.stdout.trim() ? 'modified' : 'clean' });
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
  const output = path.resolve(options.output || path.join(ROOT, 'artifacts/model-task-evaluation-report.json'));
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  // Existing files may predate the private default mode.
  fs.chmodSync(output, 0o600);
  stdout(`Model-task benchmark: ${report.executionMode}; ${report.summary.passedCases}/${report.summary.totalCases} passed; ${report.summary.score}/${report.summary.maximumScore} points.`);
  if (report.executionMode !== 'live') stdout('No real model was evaluated. Mock replay is harness verification only.');
  if (report.executionMode === 'disabled') stderr('Model execution is disabled. Configure an adapter and explicitly choose --live, or use --mock for an offline harness check.');
  return report.executionMode === 'disabled' ? 2 : report.passed ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await runModelTaskEvaluationCli(); }
  catch { console.error('Model-task evaluation could not start. Check explicit mode, adapter configuration, baseline, and output path. No raw adapter error is exported.'); process.exitCode = 2; }
}
