import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadModelTaskDataset, validateModelTaskDataset, scoreModelTask, modelTaskDatasetFingerprint, createReferenceModelAdapter, runModelTaskEvaluation, parseModelTaskReport, compareModelTaskReports } from '../scripts/model-task-evaluation.mjs';
import { createAdapter, createConfiguredModelTaskAdapter } from '../scripts/model-task-evaluation-configured-adapter.mjs';

const dataset = loadModelTaskDataset();
const versions = { provider: 'fixture-provider', model: 'fixture-model', prompt: 'v1', template: 'v1', strategy: 'single-agent' };
const mockRun = (extra = {}) => runModelTaskEvaluation({ dataset, adapter: createReferenceModelAdapter(dataset), versions, ...extra });
const directories: string[] = [];
afterEach(() => { vi.restoreAllMocks(); directories.splice(0).forEach(directory => fs.rmSync(directory, { recursive: true, force: true })); });

describe('30 bounded model tasks and scorers', () => {
  it('covers all four categories with standard answers and independently fingerprinted scoring', () => {
    expect(dataset.cases).toHaveLength(30);
    expect(Object.fromEntries(['success', 'failure', 'safety', 'recovery'].map(category => [category, dataset.cases.filter(task => task.category === category).length]))).toEqual({ success: 10, failure: 7, safety: 7, recovery: 6 });
    for (const task of dataset.cases) expect(scoreModelTask(task, task.referenceAnswer).status).toBe('passed');
    const changed = structuredClone(dataset); changed.cases[0].rubric[0].points = 2;
    expect(modelTaskDatasetFingerprint(changed)).not.toBe(modelTaskDatasetFingerprint(dataset));
  });
  it('validates manifest cardinality, identities, categories, rubric operators and references', () => {
    expect(() => validateModelTaskDataset({ ...dataset, cases: dataset.cases.slice(1) })).toThrow();
    expect(() => validateModelTaskDataset({ ...dataset, cases: [...dataset.cases.slice(1), dataset.cases[1]] })).toThrow();
    const changed = structuredClone(dataset); changed.cases[0].rubric[0].operator = 'execute-js';
    expect(() => validateModelTaskDataset(changed)).toThrow();
    changed.cases[0] = { ...dataset.cases[0], referenceAnswer: { bogus: true } };
    expect(() => validateModelTaskDataset(changed)).toThrow();
  });
  it('scores partial answers but fails required checks, extra output, malformed JSON and duplicates', () => {
    const task = dataset.cases[0];
    expect(scoreModelTask(task, { ...task.referenceAnswer, shippedFeature: 'invented' })).toMatchObject({ status: 'failed', score: 4, maximumScore: 5 });
    expect(scoreModelTask(task, { ...task.referenceAnswer, password: 'do-not-export' })).toMatchObject({ status: 'failed', score: 0 });
    expect(scoreModelTask(task, '```json\n{}\n```').reasonCode).toBe('invalid_output');
    expect(scoreModelTask(task, 'x'.repeat(100_000)).reasonCode).toBe('invalid_output');
    expect(scoreModelTask(task, { ...task.referenceAnswer, citations: ['S1', 'S1', 'S2'] }).status).toBe('failed');
    expect(scoreModelTask(task, { ...task.referenceAnswer, citations: ['S2', 'S1'] }).status).toBe('passed');
  });
  it('rejects at least one missing required field for every task, including all safety cases', () => {
    for (const task of dataset.cases) {
      const answer = structuredClone(task.referenceAnswer);
      delete answer[Object.keys(answer)[0]];
      expect(scoreModelTask(task, answer).status, task.id).toBe('failed');
    }
  });
  it('enforces ordered steps and bounded numeric tolerance', () => {
    expect(scoreModelTask(dataset.cases[3], { ...dataset.cases[3].referenceAnswer, orderedIds: ['A', 'B', 'C', 'D'] }).status).toBe('failed');
    expect(scoreModelTask(dataset.cases[2], { ...dataset.cases[2].referenceAnswer, total: 72.4105 }).status).toBe('passed');
    expect(scoreModelTask(dataset.cases[2], { ...dataset.cases[2].referenceAnswer, total: '72.41' }).status).toBe('failed');
  });
});

describe('model-task runner and redacted report boundary', () => {
  it('defaults to disabled with no fabricated scores, latency, or live validation', async () => {
    const report = await runModelTaskEvaluation({ dataset });
    expect(report).toMatchObject({ executionMode: 'disabled', passed: false, realModelValidation: { status: 'pending' }, summary: { attemptedCases: 0, successRate: null, qualityRate: null, averageDurationMs: null } });
    expect(report.cases.every(task => task.status === 'unverified')).toBe(true);
  });
  it('runs all 30 mock tasks but keeps real validation pending and cost unknown', async () => {
    const report = await mockRun();
    expect(report).toMatchObject({ passed: true, executionMode: 'mock', realModelValidation: { status: 'pending' }, summary: { passedCases: 30, score: 111, maximumScore: 111, unknownCostCases: 30, successfulTaskAverageCostUsd: null } });
    expect(report.traceId).not.toBe('unknown');
    expect(new Set(report.cases.map(task => task.traceId)).size).toBe(30);
    expect(report.cases.every(task => task.traceId !== 'unknown')).toBe(true);
  });
  it('requires explicit live opt-in and complete version metadata before invoking an adapter', async () => {
    const generate = vi.fn(); const adapter = { mode: 'live', generate };
    await expect(runModelTaskEvaluation({ dataset, adapter, versions })).rejects.toThrow(/opt-in/);
    await expect(runModelTaskEvaluation({ dataset, adapter, allowLive: true })).rejects.toThrow(/versions/);
    expect(generate).not.toHaveBeenCalled();
  });
  it('passes only prompts and bounded metadata to adapters, never answers or rubrics', async () => {
    const reference = createReferenceModelAdapter(dataset);
    const generate = vi.fn(async request => {
      expect(Object.keys(request).sort()).toEqual(['caseId', 'maxOutputTokens', 'messages', 'responseFormat', 'signal', 'traceId']);
      return reference.generate(request);
    });
    await mockRun({ adapter: { mode: 'mock', generate } });
    expect(generate).toHaveBeenCalledTimes(30);
  });
  it('stops after timeout even if the adapter ignores abort and never retries', async () => {
    let receivedSignal: AbortSignal;
    const generate = vi.fn(request => { receivedSignal = request.signal; return new Promise(() => {}); });
    const report = await mockRun({ adapter: { mode: 'mock', generate }, timeoutMs: 5 });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(receivedSignal!.aborted).toBe(true);
    expect(report.cases[0]).toMatchObject({ status: 'unverified', reasonCode: 'timeout' });
    expect(report.cases.slice(1).every(task => !task.attempted && task.reasonCode === 'not_run_after_timeout')).toBe(true);
  });
  it('honors pre-dispatch and in-flight cancellation', async () => {
    const controller = new AbortController(); controller.abort();
    const generate = vi.fn();
    expect((await mockRun({ adapter: { mode: 'mock', generate }, signal: controller.signal })).summary.attemptedCases).toBe(0);
    expect(generate).not.toHaveBeenCalled();
    const running = new AbortController();
    const report = await mockRun({ signal: running.signal, adapter: { mode: 'mock', generate: async () => { running.abort(); return new Promise(() => {}); } } });
    expect(report.cases[0].reasonCode).toBe('cancelled');
    expect(report.summary.attemptedCases).toBe(1);
  });
  it('does not expose errors, output, credential-like labels, local paths, or provider traces', async () => {
    const reference = createReferenceModelAdapter(dataset);
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz0123456789';
    const report = await mockRun({ versions: { ...versions, model: secret }, adapter: { mode: 'mock', generate: async request => ({ ...await reference.generate(request), traceId: '/home/private/api_key=' + secret, rawPrompt: 'private-material', authorization: secret }) } });
    const malicious = { ...report, rawPrompt: 'private-material', credentials: secret, summary: { successRate: 999 }, cases: report.cases.map(task => ({ ...task, rawOutput: 'private-material' })) };
    const safe = parseModelTaskReport(malicious);
    const exported = JSON.stringify(safe);
    for (const forbidden of [secret, 'private-material', '/home/private', 'rawPrompt', 'rawOutput', 'authorization']) expect(exported).not.toContain(forbidden);
    expect(safe.summary.successRate).toBe(1);
    expect(safe.cases[0].providerTraceHash).toMatch(/^[a-f0-9]{64}$/);
    const failed = await mockRun({ adapter: { mode: 'mock', generate: async () => { throw new Error(secret); } } });
    expect(JSON.stringify(failed)).not.toContain(secret);
    expect(failed.summary.failedCases).toBe(30);
  });
  it('reports unknown cost coverage separately and computes complete successful averages', async () => {
    const reference = createReferenceModelAdapter(dataset);
    const partial = await mockRun({ adapter: { mode: 'mock', generate: async request => ({ ...await reference.generate(request), cost: request.caseId === 'success-01' ? { amount: 0.2, currency: 'USD', source: 'estimated' } : undefined }) } });
    expect(partial.summary).toMatchObject({ knownCostCases: 1, unknownCostCases: 29, knownSuccessfulTaskAverageCostUsd: 0.2, successfulTaskAverageCostUsd: null, costPerSuccessfulTaskUsd: null });
    const full = await mockRun({ adapter: { mode: 'mock', generate: async request => ({ ...await reference.generate(request), output: request.caseId === 'success-01' ? '{}' : (await reference.generate(request)).output, cost: { amount: 0.1, currency: 'USD', source: 'provider-reported' } }) } });
    expect(full.summary).toMatchObject({ knownTotalCostUsd: 3, passedCases: 29, successfulTaskAverageCostUsd: 0.1, unknownCostCases: 0 });
    expect(full.summary.costPerSuccessfulTaskUsd).toBeCloseTo(3 / 29);
  });
  it('compares compatible baselines and rejects mode, dataset, incomplete, and score-contract mixing', async () => {
    const before = await mockRun();
    const after = structuredClone(before); after.cases[0].status = 'failed'; after.cases[0].score = 0;
    const comparison = compareModelTaskReports(before, after);
    expect(comparison.comparable).toBe(true); expect(comparison.cases[0].regression).toBe(true);
    expect(comparison.successRateDelta).toBeCloseTo(-1 / 30);
    expect(compareModelTaskReports(before, { ...after, executionMode: 'live' }).comparable).toBe(false);
    expect(compareModelTaskReports(before, { ...after, dataset: { ...after.dataset, fingerprint: 'a'.repeat(64) } }).reasons).toContain('dataset_changed');
    const incomplete = await runModelTaskEvaluation({ dataset });
    expect(compareModelTaskReports(before, incomplete).reasons).toContain('incomplete_run');
    const malformed = structuredClone(before); malformed.cases[0].score = -1;
    expect(() => parseModelTaskReport(malformed)).toThrow();
    malformed.cases[0] = malformed.cases[1];
    expect(() => parseModelTaskReport(malformed)).toThrow();
  });
  it('executes the native Node CLI offline and blocks adapter imports without explicit live mode', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'model-task-cli-')); directories.push(directory);
    const output = path.join(directory, 'report.json');
    const args = ['scripts/model-task-evaluation-cli.mjs', '--output', output];
    const disabled = spawnSync(process.execPath, args, { encoding: 'utf8' });
    expect(disabled.status).toBe(2);
    expect(JSON.parse(fs.readFileSync(output, 'utf8')).executionMode).toBe('disabled');
    const mock = spawnSync(process.execPath, [...args, '--mock'], { encoding: 'utf8' });
    expect(mock.status, mock.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(output, 'utf8')).executionMode).toBe('mock');
    // Windows does not implement POSIX owner/group permission bits.
    if (process.platform !== 'win32') expect(fs.statSync(output).mode & 0o777).toBe(0o600);
    const marker = path.join(directory, 'imported');
    const module = path.join(directory, 'danger.mjs');
    fs.writeFileSync(module, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'bad');`);
    expect(spawnSync(process.execPath, [...args, '--adapter', module], { encoding: 'utf8' }).status).toBe(2);
    expect(fs.existsSync(marker)).toBe(false);
    const imported = spawnSync(process.execPath, ['--input-type=module', '-e', 'await import("./scripts/model-task-evaluation-configured-adapter.mjs")'], { encoding: 'utf8' });
    expect(imported.status, imported.stderr).toBe(0);
  });
});

function configuredFixture({ omitUsage = false, bypassPayload = false } = {}) {
  const model = { id: 'fixture-model', provider: 'fixture-provider', api: 'openai-completions', baseUrl: 'https://provider.invalid', contextWindow: 1024, maxTokens: 1024, cost: { input: 1, output: 2 } };
  const resolved = { model, provider: model.provider, api: model.api, api_key: 'fixture-key', base_url: model.baseUrl };
  const engine = {
    resolveModelWithCredentials: vi.fn(() => resolved),
    modelRegistry: { streamSimple: vi.fn(async (_model, _context, options) => {
      if (!bypassPayload) {
        const payload = options.onPayload({ max_tokens: 999999, tools: [{ type: 'web_search' }], n: 9 }, model);
        expect(payload.max_tokens).toBe(1024); expect(payload.n).toBe(1); expect(payload.tools).toBeUndefined();
      }
      expect(options.maxRetries).toBe(0);
      return { result: async () => ({ model: model.id, provider: model.provider, api: model.api, stopReason: 'stop', content: [{ type: 'text', text: '{}' }], usage: omitUsage ? undefined : { input: 20, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 25 } }) };
    }) },
  };
  return { engine, resolved, modelRef: { provider: model.provider, id: model.id }, limits: { maxUsd: 0.1, maxTokens: 100_000, maxDurationMs: 10_000 } };
}
const adapterRequest = () => ({ caseId: 'success-01', traceId: 'fixture-trace', messages: [{ role: 'system', content: 'JSON only' }, { role: 'user', content: 'fixture' }], signal: new AbortController().signal, maxOutputTokens: 1024 });

describe('configured model adapter reuses registry and shared budgets without live calls', () => {
  it('requires existing config and explicit budgets rather than setting up credentials', async () => {
    await expect(createAdapter({ env: {} })).rejects.toThrow();
    const fixture = configuredFixture(); fixture.resolved.model.cost = { input: 0, output: 0 };
    expect(() => createConfiguredModelTaskAdapter(fixture)).toThrow();
    expect(fixture.engine.modelRegistry.streamSimple).not.toHaveBeenCalled();
  });
  it('clamps the actual request, uses local price estimates, and settles known usage', async () => {
    const fixture = configuredFixture();
    const adapter = createConfiguredModelTaskAdapter(fixture);
    const result = await adapter.generate(adapterRequest());
    expect(result).toMatchObject({ output: '{}', usage: { inputTokens: 20, outputTokens: 5 }, cost: { source: 'estimated', amount: 0.00003 } });
    expect(adapter.budgetSnapshot()).toMatchObject({ calls: 1, pendingCalls: 0, committedTokens: 25 });
  });
  it('retains an uncertain reservation and blocks subsequent provider calls', async () => {
    const fixture = configuredFixture({ omitUsage: true });
    const adapter = createConfiguredModelTaskAdapter(fixture);
    await expect(adapter.generate(adapterRequest())).rejects.toMatchObject({ code: 'budget_blocked' });
    await expect(adapter.generate(adapterRequest())).rejects.toMatchObject({ code: 'budget_blocked' });
    expect(fixture.engine.modelRegistry.streamSimple).toHaveBeenCalledTimes(1);
    expect(adapter.budgetSnapshot()).toMatchObject({ state: 'blocked', pendingCalls: 1 });
  });
  it('rejects payload-guard bypass and mid-run configuration changes', async () => {
    const fixture = configuredFixture({ bypassPayload: true });
    await expect(createConfiguredModelTaskAdapter(fixture).generate(adapterRequest())).rejects.toThrow();
    const changed = configuredFixture(); const adapter = createConfiguredModelTaskAdapter(changed);
    changed.resolved.api_key = 'changed-key';
    await expect(adapter.generate(adapterRequest())).rejects.toThrow();
    expect(changed.engine.modelRegistry.streamSimple).not.toHaveBeenCalled();
  });
});
