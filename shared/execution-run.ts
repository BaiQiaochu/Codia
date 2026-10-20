/** Additive wire contract; stream replay never starts or resumes a run. */
export type ExecutionRunStatus = 'running' | 'waiting' | 'pausing' | 'paused' | 'needs_attention' | 'completed' | 'failed' | 'cancelled';
export type ExecutionRunLimits = { modelCalls: number; toolCalls: number; activeMs: number };
export const DEFAULT_EXECUTION_RUN_LIMITS: Readonly<ExecutionRunLimits> = Object.freeze({
  modelCalls: 128, toolCalls: 512, activeMs: 60 * 60_000,
});
export type ExecutionRunSnapshot = {
  schemaVersion: 1;
  ownerPid?: number;
  activeTimeUncertain?: boolean;
  runId: string;
  revision: number;
  status: ExecutionRunStatus;
  reason: string | null;
  limits: ExecutionRunLimits;
  used: ExecutionRunLimits;
  grants: number;
  startedAt: number;
  updatedAt: number;
  pendingTools: Array<{ id: string; name: string; write: boolean }>;
  pendingTasks: string[];
};
export const isExecutionPaused = (run: ExecutionRunSnapshot | null | undefined) =>
  !!run && ['pausing', 'paused', 'needs_attention'].includes(run.status);
