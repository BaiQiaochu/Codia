/** Company tasks are authoritative; successful HTTP dispatch is only queued. */
export type WorkflowExecutionState = 'queued' | 'partial_failure' | 'running' | 'awaiting_approval' | 'succeeded' | 'failed' | 'cancelled';
export interface WorkflowTaskEvidence {
  id: string;
  status?: string;
  report?: string;
  artifacts?: unknown[];
  source?: { nodeId?: string; runId?: string };
}
export function workflowTaskState(status?: string): WorkflowExecutionState {
  if (status === 'completed') return 'succeeded';
  if (status === 'failed') return 'failed';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'awaiting_approval' || status === 'blocked') return 'awaiting_approval';
  if (status === 'in_progress' || status === 'reported') return 'running';
  return 'queued';
}
export function workflowRunState(states: WorkflowExecutionState[]): WorkflowExecutionState {
  if (!states.length) return 'queued';
  if (states.every(state => state === 'succeeded')) return 'succeeded';
  if (states.includes('failed') && states.some(state => ['queued', 'running', 'awaiting_approval'].includes(state))) return 'partial_failure';
  if (states.some(state => state === 'awaiting_approval')) return 'awaiting_approval';
  if (states.some(state => state === 'running')) return 'running';
  if (states.some(state => state === 'queued')) return 'queued';
  if (states.some(state => state === 'failed')) return 'failed';
  return 'cancelled';
}
export const isWorkflowRunActive = (state: string) => ['queued', 'running', 'awaiting_approval', 'partial_failure'].includes(state);
