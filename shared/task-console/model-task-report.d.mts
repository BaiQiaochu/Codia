export interface ModelTaskCost { amount: number | null; currency: 'USD'; source: 'provider-reported' | 'estimated' | 'unknown' }
export interface ModelTaskCaseResult {
  id: string; category: 'success' | 'failure' | 'safety' | 'recovery'; traceId: string;
  status: 'passed' | 'failed' | 'unverified'; attempted: boolean;
  score: number; maximumScore: number; durationMs: number | null; cost: ModelTaskCost;
  reasonCode: string; providerTraceHash: string | null;
  usage: { inputTokens: number | null; outputTokens: number | null };
  criteria: Array<{ id: string; passed: boolean; points: number; maximumPoints: number }>;
}
export interface ModelTaskSummary {
  totalCases: number; attemptedCases: number; passedCases: number; failedCases: number; unverifiedCases: number;
  score: number; maximumScore: number; qualityRate: number | null; successRate: number | null;
  totalDurationMs: number | null; averageDurationMs: number | null; successfulTaskAverageDurationMs: number | null;
  knownTotalCostUsd: number; knownCostCases: number; unknownCostCases: number; estimatedCostCases: number; providerReportedCostCases: number;
  knownSuccessfulCostCases: number; unknownSuccessfulCostCases: number;
  knownSuccessfulTaskAverageCostUsd: number | null; successfulTaskAverageCostUsd: number | null; costPerSuccessfulTaskUsd: number | null;
}
export interface ModelTaskBudgetSummary {
  state: 'active' | 'blocked' | 'unknown'; calls: number | null; committedTokens: number | null; committedUsd: number | null;
  reservedTokens: number | null; reservedUsd: number | null; pendingCalls: number | null;
  maxTokens: number | null; maxUsd: number | null; maxDurationMs: number | null; providerInvoiceHardCap: false;
}
export interface ModelTaskReport {
  schemaVersion: 1; kind: 'model-task-evaluation'; executionMode: 'mock' | 'live' | 'disabled'; traceId: string; generatedAt: string;
  revision: string | null; workingTree: 'clean' | 'modified' | 'unknown';
  dataset: { id: string; version: string; fingerprint: string };
  versions: { provider: string; model: string; prompt: string; template: string; strategy: string };
  realModelValidation: { status: 'pending' | 'measured'; note: string }; passed: boolean;
  cases: ModelTaskCaseResult[]; summary: ModelTaskSummary; budget: ModelTaskBudgetSummary | null;
}
export interface ModelTaskComparison {
  comparable: boolean; reasons: string[]; baselineTraceId: string; candidateTraceId: string;
  qualityRateDelta: number | null; successRateDelta: number | null; averageDurationMsDelta: number | null;
  successfulTaskAverageDurationMsDelta: number | null; successfulTaskAverageCostUsdDelta: number | null; costPerSuccessfulTaskUsdDelta: number | null;
  cases: Array<{ id: string; previous: string; current: string; regression: boolean; improved: boolean }>;
}
export function cleanCost(cost: unknown): ModelTaskCost;
export function cleanVersions(versions?: unknown): ModelTaskReport['versions'];
export function summarizeModelTaskCases(cases: ModelTaskCaseResult[], totalDurationMs?: number | null): ModelTaskSummary;
export function parseModelTaskReport(raw: unknown): ModelTaskReport;
export function compareModelTaskReports(baseline: unknown, candidate: unknown): ModelTaskComparison;
