/** Bounded model-task benchmark. No provider client, credentials, or network calls live here. */
import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { performance } from 'node:perf_hooks';
import redactor from '../shared/log-redactor.cjs';
import { cleanCost, cleanVersions, parseModelTaskReport, compareModelTaskReports } from '../shared/model-task-report.mjs';
export { parseModelTaskReport, compareModelTaskReports, summarizeModelTaskCases } from '../shared/model-task-report.mjs';

const CATEGORIES = ['success', 'failure', 'safety', 'recovery'];
const OPERATORS = ['equals', 'unordered-equals', 'approximately', 'absent'];
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/;
const MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const safeId = (value, fallback = 'unknown') => typeof value === 'string' && ID.test(value) && redactor.redactLogText(value) === value ? value : fallback;
const round = value => Math.round(value * 1e6) / 1e6;
const hash = value => createHash('sha256').update(value).digest('hex');
const unknownCost = () => ({ amount: null, currency: 'USD', source: 'unknown' });

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function validateModelTaskDataset(dataset) {
  if (!dataset || dataset.schemaVersion !== 1 || safeId(dataset.id) === 'unknown' || safeId(dataset.version) === 'unknown' || typeof dataset.systemPrompt !== 'string' || !dataset.systemPrompt.trim() || !Array.isArray(dataset.cases) || dataset.cases.length !== 30) throw new Error('Model-task dataset requires a version and exactly 30 cases.');
  const ids = new Set();
  for (const task of dataset.cases) {
    if (!task || safeId(task.id) === 'unknown' || ids.has(task.id) || !CATEGORIES.includes(task.category) || typeof task.prompt !== 'string' || !task.prompt.trim() || task.prompt.length > 30_000 || !task.referenceAnswer || typeof task.referenceAnswer !== 'object' || Array.isArray(task.referenceAnswer) || !Array.isArray(task.rubric) || !task.rubric.length || task.rubric.length > 50) throw new Error('Invalid or duplicate model-task case.');
    ids.add(task.id);
    const criteria = new Set();
    for (const rule of task.rubric) {
      if (!rule || safeId(rule.id) === 'unknown' || criteria.has(rule.id) || typeof rule.pointer !== 'string' || !/^(?:\/(?:[^~]|~[01])*)*$/.test(rule.pointer) || rule.pointer.length > 500 || !OPERATORS.includes(rule.operator) || !Number.isFinite(rule.points) || rule.points <= 0 || rule.points > 100 || rule.required !== true || (rule.operator !== 'absent' && !Object.hasOwn(rule, 'expected'))) throw new Error('Invalid scoring rubric.');
      if (rule.operator === 'unordered-equals' && !Array.isArray(rule.expected)) throw new Error('Unordered rubric expects an array.');
      if (rule.operator === 'approximately' && (!Number.isFinite(rule.expected) || !Number.isFinite(rule.tolerance) || rule.tolerance < 0 || rule.tolerance > 1)) throw new Error('Numeric rubric requires a bounded tolerance.');
      criteria.add(rule.id);
    }
    if (!task.rubric.some(rule => rule.required)) throw new Error('A task must have at least one required criterion.');
    if (scoreModelTask(task, task.referenceAnswer).status !== 'passed') throw new Error('Reference answer must satisfy its rubric.');
  }
  if (CATEGORIES.some(category => !dataset.cases.some(task => task.category === category))) throw new Error('Dataset must cover success, failure, safety, and recovery.');
  return dataset;
}

export function loadModelTaskDataset(file = new URL('../evals/model-task-cases.json', import.meta.url)) {
  const text = fs.readFileSync(file, 'utf8');
  if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('Dataset is too large.');
  return validateModelTaskDataset(JSON.parse(text));
}

export function modelTaskDatasetFingerprint(dataset) {
  return hash(canonicalJson({ schemaVersion: dataset.schemaVersion, id: dataset.id, version: dataset.version, systemPrompt: dataset.systemPrompt, cases: dataset.cases }));
}

function atPointer(value, pointer) {
  if (pointer === '') return { found: true, value };
  for (const segment of pointer.slice(1).split('/').map(part => part.replaceAll('~1', '/').replaceAll('~0', '~'))) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, segment)) return { found: false };
    value = value[segment];
  }
  return { found: true, value };
}

function evaluateRule(rule, response) {
  const actual = atPointer(response, rule.pointer);
  if (rule.operator === 'absent') return !actual.found;
  if (!actual.found) return false;
  if (rule.operator === 'equals') return isDeepStrictEqual(actual.value, rule.expected);
  if (rule.operator === 'approximately') return typeof actual.value === 'number' && Number.isFinite(actual.value) && Math.abs(actual.value - rule.expected) <= rule.tolerance;
  if (rule.operator === 'unordered-equals') return Array.isArray(actual.value) && isDeepStrictEqual(actual.value.map(canonicalJson).sort(), rule.expected.map(canonicalJson).sort());
  return false;
}

export function scoreModelTask(task, output) {
  const maximumScore = task.rubric.reduce((sum, rule) => sum + rule.points, 0);
  let response;
  try {
    const serialized = typeof output === 'string' ? output : JSON.stringify(output);
    if (typeof serialized !== 'string' || Buffer.byteLength(serialized) > MAX_OUTPUT_BYTES) throw new Error('Invalid output.');
    response = JSON.parse(serialized);
    if (!response || typeof response !== 'object' || Array.isArray(response)) throw new Error('Object expected.');
  } catch {
    return { status: 'failed', score: 0, maximumScore, reasonCode: 'invalid_output', criteria: task.rubric.map(rule => ({ id: rule.id, passed: false, points: 0, maximumPoints: rule.points })) };
  }
  // Exact output keys make extra fields (including secret echoes) a failure, even if all checked fields pass.
  const contractMatches = isDeepStrictEqual(Object.keys(response).sort(), Object.keys(task.referenceAnswer).sort());
  const criteria = task.rubric.map(rule => ({ id: rule.id, passed: evaluateRule(rule, response), points: 0, maximumPoints: rule.points }));
  for (const criterion of criteria) criterion.points = criterion.passed ? criterion.maximumPoints : 0;
  const passed = contractMatches && task.rubric.every((rule, index) => !rule.required || criteria[index].passed);
  return { status: passed ? 'passed' : 'failed', score: contractMatches ? criteria.reduce((sum, criterion) => sum + criterion.points, 0) : 0, maximumScore, reasonCode: passed ? 'passed' : 'rubric_failed', criteria };
}

/** Test fixture only: reference answers are deliberately not exposed to a real adapter. */
export function createReferenceModelAdapter(dataset) {
  validateModelTaskDataset(dataset);
  const answers = new Map(dataset.cases.map(task => [task.id, task.referenceAnswer]));
  return { mode: 'mock', async generate(request) { return { output: structuredClone(answers.get(request.caseId)) }; } };
}

async function callBounded(adapter, request, timeoutMs, signal) {
  if (signal?.aborted) return { reasonCode: 'cancelled' };
  const controller = new AbortController();
  let timer;
  let cancel;
  try {
    const interruption = new Promise(resolve => {
      timer = setTimeout(() => { controller.abort(); resolve({ reasonCode: 'timeout' }); }, timeoutMs);
      cancel = () => { controller.abort(); resolve({ reasonCode: 'cancelled' }); };
      signal?.addEventListener('abort', cancel, { once: true });
    });
    // A provider adapter must honor signal. We never retry an uncertain request.
    const work = Promise.resolve().then(() => adapter.generate({ ...request, signal: controller.signal })).then(result => ({ result }), error => ({ reasonCode: error?.code === 'budget_blocked' ? 'budget_blocked' : 'adapter_error', attempted: error?.attempted !== false }));
    return await Promise.race([work, interruption]);
  } finally {
    clearTimeout(timer);
    if (cancel) signal?.removeEventListener('abort', cancel);
  }
}

/** Sequential, bounded run; live adapters require explicit allowLive plus version metadata. */
export async function runModelTaskEvaluation({ dataset = loadModelTaskDataset(), adapter, allowLive = false, versions = {}, timeoutMs = DEFAULT_TIMEOUT_MS, signal, traceId = randomUUID(), revision = null, workingTree = 'unknown', baseline = null } = {}) {
  validateModelTaskDataset(dataset);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw new Error('Per-task timeout must be 1 to 300000 milliseconds.');
  const normalizedVersions = cleanVersions(versions);
  if (adapter && (!['mock', 'live'].includes(adapter.mode) || typeof adapter.generate !== 'function')) throw new Error('Adapter must declare mock/live mode and implement generate(request).');
  if (adapter?.mode === 'live' && !allowLive) throw new Error('Live provider execution requires explicit opt-in.');
  if (adapter?.mode === 'live' && Object.values(normalizedVersions).includes('unknown')) throw new Error('Live provider execution requires provider/model/prompt/template/strategy versions.');
  const mode = adapter?.mode || 'disabled';
  const started = performance.now();
  const runTraceId = safeId(traceId, randomUUID());
  const cases = [];
  let stopReason = mode === 'disabled' ? 'disabled' : null;
  for (const task of dataset.cases) {
    const taskTraceId = `${runTraceId.slice(0, 30)}-${String(cases.length + 1).padStart(2, '0')}`;
    const base = { id: task.id, category: task.category, traceId: taskTraceId, status: 'unverified', attempted: false, score: 0, maximumScore: task.rubric.reduce((sum, rule) => sum + rule.points, 0), durationMs: null, cost: unknownCost(), reasonCode: stopReason || 'cancelled', providerTraceHash: null, usage: { inputTokens: null, outputTokens: null }, criteria: [] };
    if (stopReason || signal?.aborted) { cases.push(base); continue; }
    const caseStarted = performance.now();
    const response = await callBounded(adapter, {
      caseId: task.id, traceId: taskTraceId, responseFormat: 'json', maxOutputTokens: 1024,
      messages: [{ role: 'system', content: dataset.systemPrompt }, { role: 'user', content: task.prompt }],
    }, timeoutMs, signal);
    base.attempted = response.attempted !== false;
    base.durationMs = round(performance.now() - caseStarted);
    if (response.reasonCode) {
      cases.push({ ...base, reasonCode: response.reasonCode, status: response.reasonCode === 'adapter_error' ? 'failed' : 'unverified' });
      // Stop the entire run after timeout/cancel: a non-cooperative adapter may still be in flight.
      if (response.reasonCode === 'timeout') stopReason = 'not_run_after_timeout';
      if (response.reasonCode === 'cancelled') stopReason = 'cancelled';
      if (response.reasonCode === 'budget_blocked') stopReason = 'budget_blocked';
      continue;
    }
    const result = response.result;
    const scored = scoreModelTask(task, result?.output);
    cases.push({ ...base, ...scored, cost: cleanCost(result?.cost), usage: result?.usage, providerTraceHash: typeof result?.traceId === 'string' ? hash(result.traceId) : null });
  }
  const report = parseModelTaskReport({ schemaVersion: 1, kind: 'model-task-evaluation', executionMode: mode, traceId: runTraceId, generatedAt: new Date().toISOString(), revision, workingTree, dataset: { id: dataset.id, version: dataset.version, fingerprint: modelTaskDatasetFingerprint(dataset) }, versions: normalizedVersions, budget: adapter?.budgetSnapshot?.(), cases, summary: { totalDurationMs: round(performance.now() - started) } });
  if (baseline) report.comparison = compareModelTaskReports(baseline, report);
  return report;
}
