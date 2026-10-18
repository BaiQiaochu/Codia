export type WorkflowExecutionLimits = {
  maxSteps: number;
  maxDurationMs: number;
  startedAt: number;
  dispatchedSteps: number;
};

export function createWorkflowExecutionLimits(args: any = {}, now = Date.now()): WorkflowExecutionLimits {
  const maxSteps = args?.maxSteps ?? 1000;
  const maxDurationMs = args?.maxDurationMs ?? 10 * 60 * 1000;
  if (!Number.isInteger(maxSteps) || maxSteps <= 0 || maxSteps > 1000) {
    throw new Error('workflow maxSteps must be an integer between 1 and 1000');
  }
  if (!Number.isInteger(maxDurationMs) || maxDurationMs <= 0 || maxDurationMs > 10 * 60 * 1000) {
    throw new Error('workflow maxDurationMs must be an integer between 1 and 600000');
  }
  if (args?.budgetTokens != null && (!Number.isInteger(args.budgetTokens) || args.budgetTokens <= 0)) {
    throw new Error('workflow budgetTokens must be a positive integer');
  }
  return { maxSteps, maxDurationMs, startedAt: now, dispatchedSteps: 0 };
}

export function assertWorkflowWithinDuration(limits: WorkflowExecutionLimits, now = Date.now()) {
  if (now - limits.startedAt >= limits.maxDurationMs) {
    throw new Error(`workflow duration budget exhausted (${limits.maxDurationMs}ms)`);
  }
}

export function consumeWorkflowStep(limits: WorkflowExecutionLimits) {
  assertWorkflowWithinDuration(limits);
  if (limits.dispatchedSteps >= limits.maxSteps) {
    throw new Error(`workflow step budget exhausted (${limits.maxSteps} steps)`);
  }
  limits.dispatchedSteps++;
}
