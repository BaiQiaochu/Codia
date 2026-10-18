// Browser-safe report boundary shared by the CLI and evaluation workbench.
import redactor from '../log-redactor.ts';
const CATEGORIES = ['success', 'failure', 'safety', 'recovery'];
const REASONS = ['passed', 'rubric_failed', 'invalid_output', 'adapter_error', 'timeout', 'cancelled', 'disabled', 'not_run_after_timeout', 'budget_blocked'];
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/;
const HASH = /^[a-f0-9]{64}$/;
const safeId = (value, fallback = 'unknown') => typeof value === 'string' && ID.test(value) && redactor.redactLogText(value) === value ? value : fallback;
const numberOrNull = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : null;
const round = value => Number(value.toPrecision(12));
const average = values => values.length ? round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
const unknownCost = () => ({ amount: null, currency: 'USD', source: 'unknown' });

export function cleanCost(cost) {
  if (!cost || cost.currency !== 'USD' || !['provider-reported', 'estimated'].includes(cost.source) || numberOrNull(cost.amount) === null) return unknownCost();
  return { amount: cost.amount, currency: 'USD', source: cost.source };
}

export function summarizeModelTaskCases(cases, totalDurationMs = null) {
  const attempted = cases.filter(task => task.attempted);
  const successful = cases.filter(task => task.status === 'passed');
  const known = attempted.filter(task => task.cost.amount !== null);
  const knownSuccessful = successful.filter(task => task.cost.amount !== null);
  const knownTotalCostUsd = round(known.reduce((sum, task) => sum + task.cost.amount, 0));
  const score = cases.reduce((sum, task) => sum + task.score, 0);
  const maximumScore = cases.reduce((sum, task) => sum + task.maximumScore, 0);
  return {
    totalCases: cases.length, attemptedCases: attempted.length,
    passedCases: successful.length, failedCases: cases.filter(task => task.status === 'failed').length, unverifiedCases: cases.filter(task => task.status === 'unverified').length,
    score, maximumScore, qualityRate: attempted.length ? round(score / maximumScore) : null, successRate: attempted.length ? round(successful.length / cases.length) : null,
    totalDurationMs: numberOrNull(totalDurationMs), averageDurationMs: average(attempted.map(task => task.durationMs).filter(value => value !== null)),
    successfulTaskAverageDurationMs: average(successful.map(task => task.durationMs).filter(value => value !== null)),
    knownTotalCostUsd, knownCostCases: known.length, unknownCostCases: attempted.length - known.length,
    estimatedCostCases: known.filter(task => task.cost.source === 'estimated').length, providerReportedCostCases: known.filter(task => task.cost.source === 'provider-reported').length,
    knownSuccessfulCostCases: knownSuccessful.length, unknownSuccessfulCostCases: successful.length - knownSuccessful.length,
    knownSuccessfulTaskAverageCostUsd: average(knownSuccessful.map(task => task.cost.amount)),
    successfulTaskAverageCostUsd: knownSuccessful.length === successful.length ? average(knownSuccessful.map(task => task.cost.amount)) : null,
    costPerSuccessfulTaskUsd: successful.length && known.length === attempted.length ? round(knownTotalCostUsd / successful.length) : null,
  };
}

export function cleanVersions(versions = {}) {
  return Object.fromEntries(['provider', 'model', 'prompt', 'template', 'strategy'].map(key => [key, safeId(versions[key])]));
}

/** Validate and allowlist imported reports. Never trust stored summary or comparison totals. */
export function parseModelTaskReport(raw) {
  if (!raw || raw.schemaVersion !== 1 || raw.kind !== 'model-task-evaluation' || !['mock', 'live', 'disabled'].includes(raw.executionMode) || !raw.dataset || safeId(raw.dataset.id) === 'unknown' || safeId(raw.dataset.version) === 'unknown' || !HASH.test(raw.dataset.fingerprint) || !Array.isArray(raw.cases) || raw.cases.length !== 30) throw new Error('Unsupported model-task report.');
  if (raw.executionMode === 'live' && Object.values(cleanVersions(raw.versions)).includes('unknown')) throw new Error('Live report versions are required.');
  const traceId = safeId(raw.traceId);
  const ids = new Set();
  const cases = raw.cases.map(task => {
    if (!task || safeId(task.id) === 'unknown' || ids.has(task.id) || !CATEGORIES.includes(task.category) || !['passed', 'failed', 'unverified'].includes(task.status) || numberOrNull(task.score) === null || numberOrNull(task.maximumScore) === null || task.maximumScore <= 0 || task.score > task.maximumScore || typeof task.attempted !== 'boolean' || (task.status !== 'unverified' && !task.attempted) || (task.status === 'unverified' && task.score !== 0) || (task.status === 'passed' && task.score !== task.maximumScore) || (raw.executionMode === 'disabled' && (task.attempted || task.status !== 'unverified'))) throw new Error('Invalid model-task result.');
    ids.add(task.id);
    return {
      id: task.id, category: task.category, traceId: safeId(task.traceId, traceId), status: task.status, attempted: task.attempted,
      score: task.score, maximumScore: task.maximumScore, durationMs: task.attempted ? numberOrNull(task.durationMs) : null, cost: task.attempted ? cleanCost(task.cost) : unknownCost(),
      reasonCode: REASONS.includes(task.reasonCode) ? task.reasonCode : 'adapter_error',
      // Provider traces are opaque hashes, never arbitrary response strings or URLs.
      providerTraceHash: typeof task.providerTraceHash === 'string' && HASH.test(task.providerTraceHash) ? task.providerTraceHash : null,
      usage: { inputTokens: Number.isSafeInteger(task.usage?.inputTokens) && task.usage.inputTokens >= 0 ? task.usage.inputTokens : null, outputTokens: Number.isSafeInteger(task.usage?.outputTokens) && task.usage.outputTokens >= 0 ? task.usage.outputTokens : null },
      criteria: Array.isArray(task.criteria) ? task.criteria.filter(criterion => criterion && safeId(criterion.id) !== 'unknown' && typeof criterion.passed === 'boolean' && numberOrNull(criterion.points) !== null && numberOrNull(criterion.maximumPoints) !== null && criterion.maximumPoints > 0 && criterion.points <= criterion.maximumPoints).slice(0, 50).map(criterion => ({ id: criterion.id, passed: criterion.passed, points: criterion.points, maximumPoints: criterion.maximumPoints })) : [],
    };
  });
  const summary = summarizeModelTaskCases(cases, raw.summary?.totalDurationMs);
  return {
    schemaVersion: 1, kind: 'model-task-evaluation', executionMode: raw.executionMode, traceId,
    generatedAt: typeof raw.generatedAt === 'string' && Number.isFinite(Date.parse(raw.generatedAt)) ? new Date(raw.generatedAt).toISOString() : '',
    revision: typeof raw.revision === 'string' && /^[a-f0-9]{7,64}$/.test(raw.revision) ? raw.revision : null,
    workingTree: ['clean', 'modified'].includes(raw.workingTree) ? raw.workingTree : 'unknown',
    dataset: { id: raw.dataset.id, version: raw.dataset.version, fingerprint: raw.dataset.fingerprint }, versions: cleanVersions(raw.versions),
    realModelValidation: { status: raw.executionMode === 'live' && cases.some(task => task.criteria.length > 0) ? 'measured' : 'pending', note: raw.executionMode === 'live' ? 'Injected live adapter results; bounded task answers only, not end-to-end tool validation.' : 'No real model was evaluated. Mock reference replay validates the harness only.' },
    passed: raw.executionMode !== 'disabled' && cases.every(task => task.status === 'passed'),
    budget: raw.budget && typeof raw.budget === 'object' ? { state: ['active', 'blocked'].includes(raw.budget.state) ? raw.budget.state : 'unknown', calls: numberOrNull(raw.budget.calls), committedTokens: numberOrNull(raw.budget.committedTokens), committedUsd: numberOrNull(raw.budget.committedUsd), reservedTokens: numberOrNull(raw.budget.reservedTokens), reservedUsd: numberOrNull(raw.budget.reservedUsd), pendingCalls: numberOrNull(raw.budget.pendingCalls), maxTokens: numberOrNull(raw.budget.limits?.maxTokens ?? raw.budget.maxTokens), maxUsd: numberOrNull(raw.budget.limits?.maxUsd ?? raw.budget.maxUsd), maxDurationMs: numberOrNull(raw.budget.limits?.maxDurationMs ?? raw.budget.maxDurationMs), providerInvoiceHardCap: false } : null,
    cases, summary,
  };
}

export function compareModelTaskReports(baseline, candidate) {
  const before = parseModelTaskReport(baseline);
  const after = parseModelTaskReport(candidate);
  const reasons = [];
  if (before.dataset.fingerprint !== after.dataset.fingerprint) reasons.push('dataset_changed');
  if (before.executionMode !== after.executionMode || before.executionMode === 'disabled') reasons.push('execution_mode_mismatch');
  if (before.cases.map(task => task.id).sort().join('\n') !== after.cases.map(task => task.id).sort().join('\n')) reasons.push('case_set_changed');
  if (before.summary.unverifiedCases || after.summary.unverifiedCases) reasons.push('incomplete_run');
  const previous = new Map(before.cases.map(task => [task.id, task]));
  if (after.cases.some(task => previous.has(task.id) && (previous.get(task.id).maximumScore !== task.maximumScore || previous.get(task.id).category !== task.category))) reasons.push('scoring_contract_changed');
  const comparable = reasons.length === 0;
  const delta = key => comparable && before.summary[key] !== null && after.summary[key] !== null ? round(after.summary[key] - before.summary[key]) : null;
  return {
    comparable, reasons, baselineTraceId: before.traceId, candidateTraceId: after.traceId,
    qualityRateDelta: delta('qualityRate'), successRateDelta: delta('successRate'), averageDurationMsDelta: delta('averageDurationMs'),
    successfulTaskAverageDurationMsDelta: delta('successfulTaskAverageDurationMs'), successfulTaskAverageCostUsdDelta: delta('successfulTaskAverageCostUsd'), costPerSuccessfulTaskUsdDelta: delta('costPerSuccessfulTaskUsd'),
    cases: after.cases.map(task => ({ id: task.id, previous: previous.get(task.id)?.status || 'missing', current: task.status, regression: comparable && previous.get(task.id)?.status === 'passed' && task.status !== 'passed', improved: comparable && previous.has(task.id) && previous.get(task.id)?.status !== 'passed' && task.status === 'passed' })),
  };
}

