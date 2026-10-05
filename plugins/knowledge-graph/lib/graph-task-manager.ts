// @ts-nocheck
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const BUILD_TASK_TYPE = "knowledge_graph_build";

const MAX_TASK_HISTORY = 40;
const TASK_STATE_VERSION = 1;
const LIVE_TASK_STATUSES = new Set(["queued", "pending", "running", "cancelling"]);
const KNOWN_TASK_STATUSES = new Set(["queued", "pending", "running", "cancelling", "completed", "failed", "cancelled"]);
const RESTART_CANCEL_MESSAGE = "应用重启后，此知识图谱构建任务已中断，请重新发起。";

function nowIso() {
  return new Date().toISOString();
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function makeTaskId() {
  return `kg-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
}

function makeSourceId(title, text) {
  return crypto
    .createHash("sha1")
    .update(`${title || ""}\n${String(text || "").slice(0, 4096)}`)
    .digest("hex")
    .slice(0, 12);
}

function makeTaskError(error) {
  return {
    message: error?.message || String(error),
  };
}

function normalizeSessionPath(value) {
  const trimmed = String(value || "").trim();
  return trimmed ? trimmed.replace(/\\/g, "/").toLowerCase() : "";
}

function isQueuedStatus(status) {
  return status === "queued";
}

function isCurrentStatus(status) {
  return status === "pending" || status === "running" || status === "cancelling";
}

function isLiveStatus(status) {
  return isQueuedStatus(status) || isCurrentStatus(status);
}

function isAbortError(error) {
  return error?.name === "AbortError" || error?.code === "ABORT_ERR";
}

function abortedError() {
  const error = new Error("知识图谱构建已取消");
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

function queueMessage(position) {
  if (position <= 0) return "等待开始构建知识图谱...";
  if (position === 1) return "排队中，位于当前知识图谱构建任务之后";
  return `排队中，前方还有 ${position} 个知识图谱构建任务`;
}

function createTextDocument({ title, text, sourceId }) {
  const trimmedText = String(text || "").trim();
  if (!trimmedText) return null;
  const trimmedTitle = String(title || "").trim();
  return {
    id: String(sourceId || "").trim() || makeSourceId(trimmedTitle, trimmedText),
    title: trimmedTitle || "文档 1",
    text: trimmedText,
  };
}

function normalizeTaskDocuments({ title, text, documents, sourceId }) {
  const normalized = [];

  if (Array.isArray(documents)) {
    for (let index = 0; index < documents.length; index += 1) {
      const item = documents[index];
        if (typeof item === "string") {
          const trimmed = item.trim();
          if (!trimmed) continue;
          normalized.push({
            id: `doc-${index + 1}`,
            title: `文档 ${index + 1}`,
            text: trimmed,
          });
          continue;
        }

      if (!item || typeof item !== "object") continue;
      const trimmedText = String(item.text ?? item.content ?? item.body ?? "").trim();
      if (!trimmedText) continue;
      normalized.push({
        id: String(item.id ?? item.sourceId ?? item.source_id ?? "").trim() || undefined,
        title: String(item.title ?? item.name ?? `文档 ${index + 1}`).trim(),
        text: trimmedText,
      });
    }
  }

  const inlineDocument = createTextDocument({ title, text, sourceId });
  if (inlineDocument) normalized.push(inlineDocument);

  return normalized;
}

function summarizeResult(result, store, fallbackTitle, sourceIds, archived) {
  const graphStats = store.getStats() || {};
  const extraction = result?.extraction || {};
  const stats = result?.stats || {};

  return {
    title: result?.title || fallbackTitle || store.getData()?.title || null,
    sourceId: sourceIds[0] || null,
    sourceIds,
    archived: archived || result?.archived || null,
    graph: store.getData(),
    extraction: {
      documents_processed: extraction.documents_processed || 0,
      sentences_processed: extraction.sentences_processed || 0,
      concepts_extracted: extraction.concepts_extracted || 0,
      relationships_discovered: extraction.relationships_discovered || 0,
    },
    stats: {
      documents_processed: stats.documents_processed || 0,
      nodes_created: stats.nodes_created || 0,
      nodes_updated: stats.nodes_updated || 0,
      edges_created: stats.edges_created || 0,
      edges_updated: stats.edges_updated || 0,
      node_count: graphStats.node_count || 0,
      edge_count: graphStats.edge_count || 0,
      source_count: graphStats.source_count || 0,
      last_built_at: graphStats.last_built_at || null,
    },
  };
}

function sanitizeTaskMeta(meta) {
  if (!meta || typeof meta !== "object") return {};
  return {
    title: String(meta.title || "").trim() || null,
    rebuild: Boolean(meta.rebuild),
    source_id: String(meta.source_id || meta.sourceId || "").trim() || null,
    document_count: Math.max(0, Number(meta.document_count ?? meta.documentCount ?? 0) || 0),
  };
}

function normalizeTaskProgress(value, status) {
  const numeric = Number(value);
  if (status === "completed") return 100;
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(100, numeric));
}

function normalizeTask(task) {
  if (!task || typeof task !== "object") return null;
  const id = String(task.id || "").trim();
  if (!id) return null;

  const status = KNOWN_TASK_STATUSES.has(task.status) ? task.status : "cancelled";
  const createdAt = String(task.created_at || task.createdAt || nowIso());
  const updatedAt = String(task.updated_at || task.updatedAt || createdAt || nowIso());
  const completedAt =
    status === "completed" || status === "failed" || status === "cancelled"
      ? String(task.completed_at || task.completedAt || updatedAt || nowIso())
      : null;
  const queuePositionRaw = task.queue_position ?? task.queuePosition;
  const queuePosition =
    queuePositionRaw == null ? null : Math.max(0, Number(queuePositionRaw) || 0);

  return {
    id,
    type: String(task.type || BUILD_TASK_TYPE).trim() || BUILD_TASK_TYPE,
    status,
    progress: normalizeTaskProgress(task.progress, status),
    message: String(task.message || "").trim() || null,
    created_at: createdAt,
    updated_at: updatedAt,
    completed_at: completedAt,
    queue_position: LIVE_TASK_STATUSES.has(status) ? queuePosition ?? 0 : null,
    parent_session_path: String(task.parent_session_path || task.parentSessionPath || "").trim() || null,
    meta: sanitizeTaskMeta(task.meta),
    result: clone(task.result) || null,
    error: clone(task.error) || null,
  };
}

export class GraphTaskManager {
  constructor(store, { bus, log, dataDir = "" } = {}) {
    this._store = store;
    this._bus = bus || null;
    this._log = log || console;
    this._dataDir = String(dataDir || "").trim();
    this._stateFilePath = this._dataDir ? path.join(this._dataDir, "graph-task-state.json") : "";
    this._tasks = [];
    this._taskMap = new Map();
    this._taskInputs = new Map();
    this._queuedTaskIds = [];
    this._currentTaskId = null;
    this._currentController = null;
    this._handlerRegistered = false;
    this._destroyed = false;

    this._loadState();
    this._ensureHandlerRegistered();
  }

  listTasks({ limit = 20, taskType = "" } = {}) {
    const normalizedLimit = Math.max(1, Math.min(100, Number(limit) || 20));
    const tasks = taskType
      ? this._tasks.filter((task) => task.type === taskType)
      : this._tasks;
    return tasks.slice(0, normalizedLimit).map(clone);
  }

  getTask(taskId) {
    const task = this._taskMap.get(String(taskId || ""));
    return task ? clone(task) : null;
  }

  getTaskState() {
    const currentTask = this._getCurrentTask();
    const queuedTaskIds = this._queuedTaskIds.filter((taskId) => this._taskMap.has(taskId));
    return {
      is_building: Boolean(currentTask),
      building_progress: currentTask
        ? Math.max(0, Math.min(100, Number(currentTask.progress) || 0))
        : 0,
      building_message: currentTask?.message || null,
      current_task_id: currentTask?.id || null,
      current_task_status: currentTask?.status || null,
      queued_task_count: queuedTaskIds.length,
      queued_task_ids: queuedTaskIds,
      active_task_count: (currentTask ? 1 : 0) + queuedTaskIds.length,
    };
  }

  submitBuildTask(input = {}) {
    const documents = normalizeTaskDocuments(input);
    if (!documents.length) {
      return {
        accepted: false,
        reason: "empty",
        task: null,
      };
    }

    this._ensureHandlerRegistered();

    const parentSessionPath = String(input.parentSessionPath || "").trim();
    const parentSessionKey = normalizeSessionPath(parentSessionPath);
    const replacedTaskIds = parentSessionKey
      ? this._cancelQueuedTasksForSession(parentSessionKey)
      : [];

    const task = {
      id: makeTaskId(),
      type: BUILD_TASK_TYPE,
      status: "queued",
      progress: 0,
      message: queueMessage(0),
      created_at: nowIso(),
      updated_at: nowIso(),
      completed_at: null,
      queue_position: 0,
      parent_session_path: parentSessionPath || null,
      meta: {
        title: String(input.title || "").trim() || null,
        rebuild: Boolean(input.rebuild),
        source_id: String(input.sourceId || "").trim() || null,
        document_count: documents.length,
      },
      result: null,
      error: null,
    };

    this._rememberTask(task);
    this._taskInputs.set(task.id, { ...input, documents });
    this._registerTaskInstance(task).catch(() => {});

    if (this._getCurrentTask() || this._queuedTaskIds.length > 0) {
      this._queuedTaskIds.push(task.id);
      this._updateQueuedTaskPositions();
      return {
        accepted: true,
        queued: true,
        reason: replacedTaskIds.length > 0 ? "queued_replaced" : "queued",
        replacedTaskIds,
        task: this.getTask(task.id),
      };
    }

    this._startTask(task.id);
    return {
      accepted: true,
      queued: false,
      reason: "started",
      replacedTaskIds,
      task: this.getTask(task.id),
    };
  }

  cancelTask(taskId, options = {}) {
    const task = this._taskMap.get(String(taskId || ""));
    if (!task) {
      return { ok: false, reason: "not_found", task: null };
    }

    if (task.status === "cancelled") {
      return { ok: true, reason: "already_cancelled", task: clone(task) };
    }

    if (task.status === "queued") {
      this._queuedTaskIds = this._queuedTaskIds.filter((id) => id !== task.id);
      this._taskInputs.delete(task.id);
      this._finishTask(task.id, {
        status: "cancelled",
        progress: 0,
        message:
          String(options.queuedMessage || options.message || "").trim()
          || "知识图谱构建在开始前已取消",
        queue_position: null,
        result: null,
        error: null,
      });
      this._updateQueuedTaskPositions();
      this._removeTaskInstance(task.id).catch(() => {});
      return {
        ok: true,
        reason: String(options.reason || "").trim() || "cancelled",
        task: this.getTask(task.id),
      };
    }

    if (!isCurrentStatus(task.status)) {
      return { ok: false, reason: "not_active", task: clone(task) };
    }

    if (task.status !== "cancelling") {
      this._updateTask(task.id, {
        status: "cancelling",
        message:
          String(options.activeMessage || options.message || "").trim()
          || "正在取消知识图谱构建...",
      });
    }

    if (this._currentTaskId === task.id && this._currentController) {
      this._currentController.abort();
    }

    return {
      ok: true,
      reason: String(options.reason || "").trim() || "cancelled",
      task: this.getTask(task.id),
    };
  }

  cancelAllTasks({ parentSessionPath = "" } = {}) {
    const sessionKey = normalizeSessionPath(parentSessionPath);
    const matchedTaskIds = this._listCancelableTaskIds(sessionKey);

    if (!matchedTaskIds.length) {
      return {
        ok: true,
        reason: "no_tasks",
        count: 0,
        taskIds: [],
        tasks: [],
      };
    }

    const tasks = matchedTaskIds
      .map((taskId) =>
        this.cancelTask(taskId, {
          reason: "cancelled",
          activeMessage: "正在取消知识图谱构建...",
          queuedMessage: sessionKey
            ? "已取消当前会话的知识图谱构建任务"
            : "知识图谱构建已取消",
        }).task,
      )
      .filter(Boolean);

    return {
      ok: true,
      reason: "cancelled",
      count: tasks.length,
      taskIds: tasks.map((task) => task.id),
      tasks,
    };
  }

  destroy() {
    this._destroyed = true;

    for (const taskId of [...this._queuedTaskIds]) {
      this.cancelTask(taskId);
    }

    if (this._currentController) {
      this._currentController.abort();
    }

    if (this._handlerRegistered && this._bus?.request) {
      this._bus.request("task:unregister-handler", { type: BUILD_TASK_TYPE }).catch(() => {});
    }

    this._persistState();
  }

  async _runTask(taskId, controller) {
    const task = this._taskMap.get(taskId);
    const input = this._taskInputs.get(taskId);
    if (!task || !input) return;

    const documents = Array.isArray(input.documents) ? input.documents : [];
    const total = documents.length;
    const archiveReason =
      String(input.archiveReason || "").trim() || (input.rebuild ? "rebuild" : "incremental");

    let lastResult = null;
    let archived = null;
    const mergedSourceIds = [];

    try {
      this._updateTask(taskId, {
        status: "running",
        progress: 5,
        queue_position: 0,
        message: total > 1 ? `正在构建知识图谱（1/${total}）...` : "正在构建知识图谱...",
      });

      for (let index = 0; index < documents.length; index += 1) {
        if (controller.signal.aborted || this._destroyed) throw abortedError();

        const document = documents[index];
        const rebuild = index === 0 ? Boolean(input.rebuild) : false;
        const title = String(input.title || "").trim() || document.title || "";

        lastResult = this._store.buildFromDocuments({
          documents: [document],
          title,
          rebuild,
          maxNodes: input.maxNodes,
          archiveOnRebuild: rebuild,
          archiveTitle: input.archiveTitle,
          archiveReason,
        });

        if (!archived && lastResult?.archived) archived = lastResult.archived;
        if (Array.isArray(lastResult?.sourceIds)) {
          mergedSourceIds.push(...lastResult.sourceIds);
        }

        if (controller.signal.aborted || this._destroyed) throw abortedError();

        const progress =
          index === documents.length - 1
            ? 96
            : Math.max(10, Math.min(96, 10 + Math.round(((index + 1) / documents.length) * 80)));

        this._updateTask(taskId, {
          status: "running",
          progress,
          queue_position: 0,
          message:
            documents.length > 1
              ? `正在构建知识图谱（${index + 1}/${documents.length}）...`
              : "正在构建知识图谱...",
        });

        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      this._store.flushSync();
      const result = summarizeResult(
        lastResult,
        this._store,
        String(input.title || "").trim(),
        unique(mergedSourceIds),
        archived,
      );

      this._finishTask(taskId, {
        status: "completed",
        progress: 100,
        message: "知识图谱构建完成",
        queue_position: null,
        result,
        error: null,
      });
    } catch (error) {
      if (isAbortError(error) || controller.signal.aborted || this._destroyed) {
        this._finishTask(taskId, {
          status: "cancelled",
          progress: 0,
          message: "知识图谱构建已取消",
          queue_position: null,
          result: null,
          error: null,
        });
      } else {
        this._log?.error?.(`knowledge graph build failed: ${error.message}`);
        this._finishTask(taskId, {
          status: "failed",
          progress: 0,
          message: "知识图谱构建失败",
          queue_position: null,
          result: null,
          error: makeTaskError(error),
        });
      }
    } finally {
      if (this._currentTaskId === taskId) {
        this._currentTaskId = null;
        this._currentController = null;
      }
      this._taskInputs.delete(taskId);
      await this._removeTaskInstance(taskId);
      this._startNextTask();
    }
  }

  _rememberTask(task) {
    this._tasks.unshift(task);
    this._taskMap.set(task.id, task);

    while (this._tasks.length > MAX_TASK_HISTORY) {
      const removableIndex = this._findOldestRemovableTaskIndex();
      if (removableIndex < 0) break;

      const [removed] = this._tasks.splice(removableIndex, 1);
      if (!removed) break;
      this._taskMap.delete(removed.id);
      this._taskInputs.delete(removed.id);
      this._queuedTaskIds = this._queuedTaskIds.filter((taskId) => taskId !== removed.id);
    }

    this._persistState();
  }

  _findOldestRemovableTaskIndex() {
    for (let index = this._tasks.length - 1; index >= 0; index -= 1) {
      if (!isLiveStatus(this._tasks[index]?.status)) {
        return index;
      }
    }
    return -1;
  }

  _getCurrentTask() {
    if (!this._currentTaskId) return null;
    const task = this._taskMap.get(this._currentTaskId);
    return task && isCurrentStatus(task.status) ? task : null;
  }

  _startTask(taskId) {
    if (this._destroyed || this._getCurrentTask()) return false;
    const task = this._taskMap.get(taskId);
    if (!task) return false;

    this._currentTaskId = task.id;
    this._currentController = new AbortController();

    this._updateTask(taskId, {
      status: "pending",
      progress: 0,
      queue_position: 0,
      message: "等待开始构建知识图谱...",
    });

    const controller = this._currentController;
    setTimeout(() => {
      this._runTask(task.id, controller).catch((error) => {
        this._log?.error?.(`knowledge graph task ${task.id} crashed: ${error.message}`);
      });
    }, 0);

    return true;
  }

  _startNextTask() {
    if (this._destroyed || this._getCurrentTask()) return;

    while (this._queuedTaskIds.length > 0) {
      const nextTaskId = this._queuedTaskIds.shift();
      const nextTask = this._taskMap.get(nextTaskId);
      if (!nextTask || nextTask.status !== "queued") continue;
      this._updateQueuedTaskPositions();
      this._startTask(nextTaskId);
      return;
    }
  }

  _cancelQueuedTasksForSession(parentSessionKey) {
    const matchedTaskIds = this._queuedTaskIds.filter((taskId) => {
      const task = this._taskMap.get(taskId);
      return task && normalizeSessionPath(task.parent_session_path) === parentSessionKey;
    });

    matchedTaskIds.forEach((taskId) => {
      this.cancelTask(taskId, {
        reason: "superseded",
        queuedMessage: "同一会话发起了新的知识图谱构建请求，当前排队任务已被替换",
      });
    });

    return matchedTaskIds;
  }

  _listCancelableTaskIds(sessionKey = "") {
    const matchedTaskIds = [];
    const currentTask = this._getCurrentTask();
    if (
      currentTask
      && (!sessionKey || normalizeSessionPath(currentTask.parent_session_path) === sessionKey)
    ) {
      matchedTaskIds.push(currentTask.id);
    }

    this._queuedTaskIds.forEach((taskId) => {
      const task = this._taskMap.get(taskId);
      if (!task || task.status !== "queued") return;
      if (sessionKey && normalizeSessionPath(task.parent_session_path) !== sessionKey) return;
      matchedTaskIds.push(taskId);
    });

    return matchedTaskIds;
  }

  _updateQueuedTaskPositions() {
    const basePosition = this._getCurrentTask() ? 1 : 0;
    this._queuedTaskIds = this._queuedTaskIds.filter((taskId) => {
      const task = this._taskMap.get(taskId);
      return task && task.status === "queued";
    });

    this._queuedTaskIds.forEach((taskId, index) => {
      const queuePosition = basePosition + index;
      this._updateTask(taskId, {
        status: "queued",
        progress: 0,
        queue_position: queuePosition,
        message: queueMessage(queuePosition),
      });
    });
  }

  _updateTask(taskId, patch) {
    const task = this._taskMap.get(taskId);
    if (!task) return null;

    const nextStatus = Object.prototype.hasOwnProperty.call(patch, "status")
      ? patch.status
      : task.status;

    Object.assign(task, patch, {
      updated_at: nowIso(),
    });

    if (isLiveStatus(nextStatus)) {
      task.completed_at = null;
    } else if (!task.completed_at) {
      task.completed_at = nowIso();
    }

    this._persistState();
    return task;
  }

  _finishTask(taskId, patch) {
    return this._updateTask(taskId, patch);
  }

  async _registerTaskInstance(task) {
    if (!this._bus?.request) return;
    try {
      await this._bus.request("task:register", {
        taskId: task.id,
        type: BUILD_TASK_TYPE,
        parentSessionPath: task.parent_session_path || "",
        meta: clone(task.meta || {}),
      });
    } catch {
      // Ignore when task registry is unavailable.
    }
  }

  async _removeTaskInstance(taskId) {
    if (!this._bus?.request) return;
    try {
      await this._bus.request("task:remove", { taskId });
    } catch {
      // Ignore when task registry is unavailable.
    }
  }

  _ensureHandlerRegistered() {
    if (this._handlerRegistered || !this._bus?.request) return;
    this._bus.request("task:register-handler", {
      type: BUILD_TASK_TYPE,
      abort: (taskId) => {
        this.cancelTask(taskId);
      },
    }).then(() => {
      this._handlerRegistered = true;
    }).catch(() => {
      // Server may register task handlers after plugin init. Retry on submission.
    });
  }

  _loadState() {
    if (!this._stateFilePath || !fs.existsSync(this._stateFilePath)) return;

    try {
      const raw = JSON.parse(fs.readFileSync(this._stateFilePath, "utf8"));
      const tasks = Array.isArray(raw?.tasks) ? raw.tasks : Array.isArray(raw) ? raw : [];
      const normalized = tasks
        .map(normalizeTask)
        .filter(Boolean)
        .slice(0, MAX_TASK_HISTORY);

      const recoveredAt = nowIso();
      let changed = false;

      this._tasks = normalized.map((task) => {
        if (!LIVE_TASK_STATUSES.has(task.status)) return task;
        changed = true;
        return {
          ...task,
          status: "cancelled",
          progress: 0,
          message: RESTART_CANCEL_MESSAGE,
          queue_position: null,
          completed_at: recoveredAt,
          updated_at: recoveredAt,
          result: null,
          error: null,
        };
      });
      this._taskMap = new Map(this._tasks.map((task) => [task.id, task]));
      this._queuedTaskIds = [];
      this._currentTaskId = null;
      this._currentController = null;

      if ((raw?.version ?? TASK_STATE_VERSION) !== TASK_STATE_VERSION) {
        changed = true;
      }

      if (changed) this._persistState();
    } catch (error) {
      this._log?.error?.(`knowledge graph task state load failed: ${error.message}`);
      this._tasks = [];
      this._taskMap = new Map();
      this._queuedTaskIds = [];
      this._currentTaskId = null;
      this._currentController = null;
    }
  }

  _persistState() {
    if (!this._stateFilePath) return;

    try {
      fs.mkdirSync(this._dataDir, { recursive: true });
      const payload = {
        version: TASK_STATE_VERSION,
        tasks: this._tasks.map((task) => ({
          id: task.id,
          type: task.type,
          status: task.status,
          progress: task.progress,
          message: task.message,
          created_at: task.created_at,
          updated_at: task.updated_at,
          completed_at: task.completed_at,
          queue_position: task.queue_position,
          parent_session_path: task.parent_session_path,
          meta: clone(task.meta || {}),
          result: clone(task.result),
          error: clone(task.error),
        })),
      };
      const tempPath = `${this._stateFilePath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), "utf8");
      fs.renameSync(tempPath, this._stateFilePath);
    } catch (error) {
      this._log?.error?.(`knowledge graph task state write failed: ${error.message}`);
    }
  }
}
