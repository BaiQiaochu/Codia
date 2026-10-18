import { describe, it, expect } from 'vitest';
import { parseEvaluationReport, compareEvaluationReports } from '../shared/task-console/evaluation-report.ts';
const report = (status = 'passed') => ({ schemaVersion: 1, kind: 'deterministic-regression', traceId: 'trace-1', generatedAt: '2026-10-16T00:00:00Z', cases: [{ id: 'safe-01', category: 'approval', status, score: status === 'passed' ? 1 : 0, maximumScore: 1, durationMs: 4, prompt: 'private-prompt' }], apiKey: 'private-key' });
describe('evaluation workbench report boundary', () => {
  it('keeps only summary fields, never raw prompts or credentials', () => {
    const safe = parseEvaluationReport(report());
    expect(JSON.stringify(safe)).not.toContain('private');
    expect(safe.cases[0].status).toBe('passed');
  });
  it('detects regressions and rejects malformed scores or duplicate IDs', () => {
    expect(compareEvaluationReports(parseEvaluationReport(report()), parseEvaluationReport(report('failed')))[0].regression).toBe(true);
    expect(() => parseEvaluationReport({ ...report(), cases: [{ ...report().cases[0], score: 99 }] })).toThrow();
    expect(() => parseEvaluationReport({ ...report(), cases: [report().cases[0], report().cases[0]] })).toThrow();
  });
});

it('rejects cross-kind comparisons at the shared boundary', () => {
  const model = parseEvaluationReport({ schemaVersion: 1, kind: 'model-task-evaluation', executionMode: 'mock', traceId: 'm1',
    dataset: { id: 'tasks', version: 'v1', fingerprint: 'a'.repeat(64) },
    cases: Array.from({ length: 30 }, (_, index) => ({ id: `case-${index}`, category: 'success', status: 'passed', attempted: true, score: 1, maximumScore: 1, durationMs: 1 })) });
  expect(() => compareEvaluationReports(parseEvaluationReport(report()), model)).toThrow(/不同类型/);
});
