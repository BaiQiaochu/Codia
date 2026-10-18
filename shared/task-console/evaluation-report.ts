import { redactLogText } from '../log-redactor';
import { parseModelTaskReport, compareModelTaskReports, type ModelTaskReport } from './model-task-report.mjs';
export { parseModelTaskReport, compareModelTaskReports } from './model-task-report.mjs';
export type { ModelTaskReport } from './model-task-report.mjs';
export interface EvaluationCase { id: string; category: string; status: 'passed' | 'failed' | 'unverified'; score: number; maximumScore: number; durationMs: number | null }
export interface DeterministicEvaluationReport { schemaVersion: 1; traceId: string; generatedAt: string; kind: 'deterministic-regression'; revision: string | null; workingTree: 'clean' | 'modified' | 'unknown'; cases: EvaluationCase[] }
export type EvaluationReport = DeterministicEvaluationReport | ModelTaskReport;
export function parseEvaluationReport(value: unknown): EvaluationReport {
  const raw = value as Record<string, unknown>;
  if (raw?.kind === 'model-task-evaluation') return parseModelTaskReport(value);
  if (!raw || raw.schemaVersion !== 1 || raw.kind !== 'deterministic-regression' || !Array.isArray(raw.cases) || !raw.cases.length || raw.cases.length > 1000) throw new Error('不是受支持的确定性评测报告');
  const cases: EvaluationCase[] = raw.cases.map((value: unknown) => {
    const c = value as Record<string, unknown>;
    if (!c || typeof c.id !== 'string' || (!/^[a-zA-Z0-9_-]{1,100}$/.test(c.id) || redactLogText(c.id) !== c.id) || !['passed', 'failed', 'unverified'].includes(String(c.status)) || typeof c.score !== 'number' || typeof c.maximumScore !== 'number' || !Number.isFinite(c.score) || !Number.isFinite(c.maximumScore) || c.maximumScore <= 0 || c.score < 0 || c.score > c.maximumScore) throw new Error('评测用例字段无效');
    return { id: c.id, category: ['scheduler', 'approval', 'recovery', 'redaction', 'budget', 'structured-output', 'concurrency'].includes(String(c.category)) ? String(c.category) : 'unknown', status: c.status as EvaluationCase['status'], score: c.score, maximumScore: c.maximumScore, durationMs: typeof c.durationMs === 'number' && Number.isFinite(c.durationMs) ? Math.max(0, c.durationMs) : null };
  });
  if (new Set(cases.map(c => c.id)).size !== cases.length) throw new Error('评测用例 ID 重复');
  return { schemaVersion: 1, traceId: typeof raw.traceId === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(raw.traceId) && redactLogText(raw.traceId) === raw.traceId ? raw.traceId : 'unknown', generatedAt: typeof raw.generatedAt === 'string' && Number.isFinite(Date.parse(raw.generatedAt)) ? new Date(raw.generatedAt).toISOString() : '', kind: 'deterministic-regression', workingTree: raw.workingTree === 'clean' || raw.workingTree === 'modified' ? raw.workingTree : 'unknown', revision: typeof raw.revision === 'string' && /^[a-f0-9]{7,64}$/.test(raw.revision) ? raw.revision : null, cases };
}
export interface EvaluationComparisonCase { id: string; previous: string; current: string; regression: boolean; improved: boolean }
export function compareEvaluationReports(before: EvaluationReport, after: EvaluationReport): EvaluationComparisonCase[] {
  if (before.kind !== after.kind) throw new Error('不能比较不同类型的评测报告');
  if (before.kind === 'model-task-evaluation' && after.kind === 'model-task-evaluation') {
    const comparison = compareModelTaskReports(before, after);
    if (!comparison.comparable) throw new Error('模型任务报告不可比较：执行模式、数据集、评分契约或完成度不一致');
    return comparison.cases;
  }
  if (before.kind !== 'deterministic-regression' || after.kind !== 'deterministic-regression') throw new Error('不能比较不同类型的评测报告');
  const previous = new Map<string, EvaluationCase>(before.cases.map(c => [c.id, c] as const));
  const next = new Map<string, EvaluationCase>(after.cases.map(c => [c.id, c] as const));
  return [...new Set([...previous.keys(), ...next.keys()])].map(id => ({ id, previous: previous.get(id)?.status || 'missing', current: next.get(id)?.status || 'missing', regression: previous.get(id)?.status === 'passed' && next.get(id)?.status !== 'passed', improved: previous.has(id) && previous.get(id)?.status !== 'passed' && next.get(id)?.status === 'passed' }));
}
