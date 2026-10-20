/**
 * Deferred Result Pi SDK Extension
 *
 * On session_start:
  *
 *
  * */

import { isUiOnlyDeferredResultTask } from "../deferred-result-notification.ts";
import { findExecutionRun } from "../execution/run-controller.ts";

function escapeXml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatResultNotification(taskId, result, meta) {
  const type = escapeXml(meta?.type || "background-task");
  const body =
    typeof result === "string"
      ? escapeXml(result)
      : escapeXml(JSON.stringify(result, null, 2));
  return `<codia-background-result task-id="${escapeXml(taskId)}" status="success" type="${type}">\n${body}\n</codia-background-result>`;
}

function formatFailNotification(taskId, reason, meta) {
  const type = escapeXml(meta?.type || "background-task");
  return `<codia-background-result task-id="${escapeXml(taskId)}" status="failed" type="${type}">\n${escapeXml(reason)}\n</codia-background-result>`;
}

function formatAbortNotification(taskId, reason, meta) {
  const type = escapeXml(meta?.type || "background-task");
  return `<codia-background-result task-id="${escapeXml(taskId)}" status="aborted" type="${type}">\n${escapeXml(reason || "task was stopped")}\n</codia-background-result>`;
}

function isExternallyDeliveredTask(task) {
  return task?.meta?.deliveryTarget?.kind === "bridge";
}

/**
  *
 * @returns {boolean} 是否送达成功
 */
function tryDeliver(pi, store, taskId, task) {
  const run = findExecutionRun(task?.sessionPath);
  if (run?.canContinueAutomatically() === false) return false;
  if (task.runId && run?.snapshot()?.runId !== task.runId) return false;
  if (isExternallyDeliveredTask(task)) return false;
  if (isUiOnlyDeferredResultTask(task)) return false;
  try {
    const content = task.status === "resolved"
      ? formatResultNotification(taskId, task.result, task.meta)
      : task.status === "aborted"
        ? formatAbortNotification(taskId, task.reason, task.meta)
        : formatFailNotification(taskId, task.reason, task.meta);
    pi.sendMessage(
      { customType: "codia-background-result", content, display: false },
      { deliverAs: "steer", triggerTurn: true },
    );
    store.markDelivered(taskId);
    return true;
  } catch (err) {
    console.error(`[deferred-result-ext] steer failed for ${taskId}:`, err.message || err, err.stack?.split('\n').slice(0, 3).join('\n'));
    return false;
  }
}

/**
 * @param {import("../deferred-result-store.ts").DeferredResultStore} deferredStore
 * @returns {(pi: object) => void}
 */
export function createDeferredResultExtension(deferredStore) {
  return function (pi) {
    let sessionPath = null;
    let unsubResult = null;
    let unsubFail = null;
    let retryTimer = null;
    let startTimer = null;

    pi.on("session_start", (event, ctx) => {
      sessionPath = ctx.sessionManager.getSessionFile();

 //
      startTimer = setTimeout(() => {
        const undelivered = deferredStore.listUndelivered(sessionPath);
        for (const task of undelivered) {
          if (isExternallyDeliveredTask(task)) continue;
          if (isUiOnlyDeferredResultTask(task)) continue;
          tryDeliver(pi, deferredStore, task.taskId, task);
        }

 //
        const pending = deferredStore.listPending(sessionPath);
        if (pending.length) {
          try {
            pi.sendMessage(
              {
                customType: "codia-deferred-task-reminder",
                content: `<codia-deferred-tasks>${pending.length} background tasks are still running; call check_pending_tasks for details.</codia-deferred-tasks>`,
                display: false,
              },
              { deliverAs: "steer", triggerTurn: false },
            );
          } catch { /* best effort */ }
        }
      }, 500);

 //
      unsubResult = deferredStore.onResult((taskId, sp, _result, _meta) => {
        if (sp !== sessionPath) return;
        const task = deferredStore.query(taskId);
        if (isExternallyDeliveredTask(task)) return;
        if (isUiOnlyDeferredResultTask(task)) return;
        if (task) tryDeliver(pi, deferredStore, taskId, task);
      });

      unsubFail = deferredStore.onFail((taskId, sp, _reason, _meta) => {
        if (sp !== sessionPath) return;
        const task = deferredStore.query(taskId);
        if (isExternallyDeliveredTask(task)) return;
        if (isUiOnlyDeferredResultTask(task)) return;
        if (task) tryDeliver(pi, deferredStore, taskId, task);
      });

 //
      retryTimer = setInterval(() => {
        if (!sessionPath) return;
        const undelivered = deferredStore.listUndelivered(sessionPath);
        for (const task of undelivered) {
          if (isExternallyDeliveredTask(task)) continue;
          if (isUiOnlyDeferredResultTask(task)) continue;
          tryDeliver(pi, deferredStore, task.taskId, task);
        }
      }, 30_000);
    });

    pi.on("session_shutdown", () => {
      if (startTimer) { clearTimeout(startTimer); startTimer = null; }
      unsubResult?.();
      unsubFail?.();
      unsubResult = null;
      unsubFail = null;
      if (retryTimer) { clearInterval(retryTimer); retryTimer = null; }
    });
  };
}
