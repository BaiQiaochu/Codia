import type { ExecutionRunSnapshot } from '../../../../shared/execution-run';

type Listener = (path: string, run: ExecutionRunSnapshot) => void;
const listeners = new Set<Listener>();
export function publishExecutionRun(path: string, run: ExecutionRunSnapshot) {
  if (!path || run?.schemaVersion !== 1) return;
  for (const listener of listeners) listener(path, run);
}
export function subscribeExecutionRun(listener: Listener) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function newerExecutionRun(previous: ExecutionRunSnapshot | null, next: ExecutionRunSnapshot | null) {
  if (!next) return previous;
  if (previous && (previous.runId === next.runId ? previous.revision > next.revision : previous.startedAt > next.startedAt)) return previous;
  return next;
}
