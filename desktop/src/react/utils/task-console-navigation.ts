import { useStore } from '../stores';
export const TASK_CONSOLE_RUN_EVENT = 'codia-task-console-run';
let pendingRunId: string | null = null;
export function takePendingTaskConsoleRun(): string | null {
  const id = pendingRunId; pendingRunId = null; return id;
}
/** Read-only navigation. Keep the request in memory until the lazy panel mounts. */
export function openTaskConsoleRun(runId: string): boolean {
  if (typeof window === 'undefined' || !/^(workflow|activity|company):[^\r\n]{1,300}$/.test(runId)) return false;
  pendingRunId = runId;
  useStore.getState().setCurrentTab('chat');
  useStore.getState().setActivePanel('task-console');
  window.dispatchEvent(new CustomEvent(TASK_CONSOLE_RUN_EVENT));
  return true;
}
