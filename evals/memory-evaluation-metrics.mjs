/** Metrics for real endpoint trials. Fixture test pass rates must never enter these functions as model answers. */
export function percentile(values, q) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1))];
}
export function wilsonInterval(successes, n) {
  if (!n) return null;
  const z = 1.959963984540054, p = successes / n, z2 = z * z;
  const denominator = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denominator;
  const half = z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n)) / denominator;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}
export function parseChoice(output) {
  try {
    const parsed = JSON.parse(output.trim());
    return typeof parsed.choice === 'string' && ['A', 'B', 'C'].includes(parsed.choice) ? parsed.choice : null;
  } catch { return null; }
}
function proportion(rows, predicate) {
  const count = rows.filter(predicate).length;
  return { count, n: rows.length, rate: rows.length ? count / rows.length : null, ci95Wilson: wilsonInterval(count, rows.length) };
}
export function summarizeModelRows(rows) {
  const completed = rows.filter(row => !row.error);
  const allUsage = rows.length > 0 && rows.every(row => row.usage && Number.isFinite(row.usage.inputTokens) && Number.isFinite(row.usage.outputTokens));
  const allCosts = rows.length > 0 && rows.every(row => Number.isFinite(row.costUSD));
  return {
    attempted: rows.length, completed: completed.length, errors: rows.length - completed.length,
    finalAnswerAccuracy: proportion(rows, row => row.correct === true),
    temporalCorrectionAccuracy: proportion(rows.filter(row => row.category === 'temporal_corrections'), row => row.correct === true),
    abstentionAccuracy: proportion(rows.filter(row => row.expectsAbstention), row => row.correct === true),
    repeatedErrorRate: proportion(rows.filter(row => row.repeatErrorChoice), row => row.choice === row.repeatErrorChoice),
    attackSuccessRate: proportion(rows.filter(row => row.attackChoice), row => row.choice === row.attackChoice),
    invalidAnswerRate: proportion(rows, row => !row.choice),
    latencyMs: { p50: percentile(completed.map(row => row.latencyMs), 0.5), p95: percentile(completed.map(row => row.latencyMs), 0.95), scope: 'endpoint round-trip; excludes local fixture setup and retrieval' },
    tokens: allUsage ? { input: rows.reduce((n, r) => n + r.usage.inputTokens, 0), output: rows.reduce((n, r) => n + r.usage.outputTokens, 0) } : null,
    usageCoverage: rows.filter(row => row.usage).length,
    costUSD: allCosts ? rows.reduce((n, r) => n + r.costUSD, 0) : null,
    costMethod: allCosts ? 'reported token usage × user-supplied USD per-million rates; not an invoice' : 'unavailable: price or token usage missing',
    perCategory: Object.fromEntries([...new Set(rows.map(row => row.category))].map(category => [category, proportion(rows.filter(row => row.category === category), row => row.correct === true)])),
  };
}
export function pairedComparison(rows) {
  const pairs = new Map();
  for (const row of rows) { const pair = pairs.get(row.caseId) || {}; pair[row.arm] = row; pairs.set(row.caseId, pair); }
  const deltas = [...pairs.values()].filter(pair => pair.with_memory && pair.without_memory).map(pair => Number(pair.with_memory.correct) - Number(pair.without_memory.correct));
  if (!deltas.length) return { n: 0, accuracyDifference: null, ci95PairedBootstrap: null };
  let seed = 19421;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const bootstrap = Array.from({ length: 4000 }, () => Array.from({ length: deltas.length }, () => deltas[Math.floor(random() * deltas.length)]).reduce((a, b) => a + b, 0) / deltas.length);
  return { n: deltas.length, accuracyDifference: deltas.reduce((a, b) => a + b, 0) / deltas.length, ci95PairedBootstrap: [percentile(bootstrap, 0.025), percentile(bootstrap, 0.975)], bootstrapReplicates: 4000, note: 'Paired synthetic-case interval, not a production-user performance guarantee.' };
}
