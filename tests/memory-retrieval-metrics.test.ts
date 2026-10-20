import fs from 'node:fs';
import { FactStore } from '../lib/memory/fact-store.ts';
import { MemoryQueryService } from '../lib/memory/query-service.ts';
import { describe, expect, it } from 'vitest';
import { executeMemoryCase, loadMemoryCases } from '../evals/memory-case-runtime.mjs';
import { summarizeRetrieval } from '../evals/memory-retrieval-metrics.mjs';

describe('retrieval measurements', () => {
  it('keeps identical queries isolated between assistant stores', () => {
    const first = new FactStore(':memory:'); const second = new FactStore(':memory:');
    try {
      first.add({ fact: 'workspace is private-alpha', tags: ['workspace'], observedAt: '2026-01-01T00:00:00Z' });
      second.add({ fact: 'workspace is private-beta', tags: ['workspace'], observedAt: '2026-01-01T00:00:00Z' });
      const query = { query: 'workspace', now: '2026-02-01T00:00:00Z' };
      expect(new MemoryQueryService(first).query(query).text).not.toContain('private-beta');
      expect(new MemoryQueryService(second).query(query).text).not.toContain('private-alpha');
    } finally { first.close(); second.close(); }
  });
  it('does not inflate Precision@K when fewer than K results are returned', () => {
    const fixture = structuredClone(loadMemoryCases()[0]);
    fixture.query.limit = 8;
    const result = executeMemoryCase(fixture);
    expect(result.precisionAtK).toBe(fixture.expect.included.length / 8);
  });
  it('includes labeled failures and separates infrastructure failures', () => {
    const metrics = summarizeRetrieval([
      { passed: true, retrievalRecall: 1, injectionRecall: 0.5, precisionAtK: 0.5 },
      { passed: false, retrievalRecall: 0, injectionRecall: 0, precisionAtK: 0 },
      { passed: false, infrastructureFailure: true },
    ]);
    expect(metrics).toMatchObject({
      candidateRecall: { n: 2, value: 0.5 }, injectionRecall: { n: 2, value: 0.25 },
      precisionAtK: { n: 2, value: 0.25 }, failureRate: 0.5, infrastructureFailures: 1,
    });
  });
  it('attaches actual retrieval metrics even if a fixture assertion fails', () => {
    const fixture = structuredClone(loadMemoryCases()[0]);
    fixture.query.tokenBudget = 0;
    try { executeMemoryCase(fixture); throw new Error('Expected assertion failure'); }
    catch (error) {
      expect(error.retrievalMetrics).toMatchObject({ retrievalRecall: 1, injectionRecall: 0, precisionAtK: 0 });
    }
  });
  const hard = JSON.parse(fs.readFileSync(new URL('../evals/memory-hard-cases.json', import.meta.url), 'utf8')).cases;
  it('keeps holdout project identities distinct and later than tune', () => {
    const tune = hard.filter(c => c.split === 'tune');
    const holdout = hard.filter(c => c.split === 'holdout');
    expect(holdout.every(c => !tune.some(t => t.projectId === c.projectId) && tune.every(t => t.asOf < c.asOf))).toBe(true);
  });
  for (const fixture of hard) it(fixture.name, () => {
    const result = executeMemoryCase(fixture);
    expect(result.injectionRecall).toBe(1);
    expect(result.precisionAtK).toBe(1);
  });
});
