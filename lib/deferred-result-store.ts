// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { atomicWriteSync } from "../shared/safe-fs.ts";

const CLEANUP_MAX_AGE = 7 * 24 * 60 * 60 * 1000;

function textOrNull(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeSessionRef(input, resolveSessionIdForPath = null) {
  if (typeof input === "string") {
    const sessionPath = textOrNull(input);
    const sessionId = textOrNull(resolveSessionIdForPath?.(sessionPath));
    const sessionRef = sessionId
      ? { sessionId, ...(sessionPath ? { sessionPath, legacySessionPath: sessionPath } : {}) }
      : null;
    return { sessionId, sessionPath, sessionRef };
  }

  const rawRef = input?.sessionRef && typeof input.sessionRef === "object"
    ? input.sessionRef
    : null;
  const sessionPath =
    textOrNull(input?.sessionPath)
    || textOrNull(input?.path)
    || textOrNull(rawRef?.sessionPath)
    || textOrNull(rawRef?.path);
  const sessionId =
    textOrNull(input?.sessionId)
    || textOrNull(rawRef?.sessionId)
    || textOrNull(resolveSessionIdForPath?.(sessionPath));
  const legacySessionPath =
    textOrNull(input?.legacySessionPath)
    || textOrNull(rawRef?.legacySessionPath)
    || (sessionId && sessionPath ? sessionPath : null);
  const sessionRef = sessionId
    ? {
      sessionId,
      ...(sessionPath ? { sessionPath } : {}),
      ...(legacySessionPath ? { legacySessionPath } : {}),
    }
    : null;
  return { sessionId, sessionPath, sessionRef };
}

function matchesSession(task, input, resolveSessionIdForPath = null) {
  const target = normalizeSessionRef(input, resolveSessionIdForPath);
  if (target.sessionId) {
    return task.sessionId === target.sessionId || task.sessionRef?.sessionId === target.sessionId;
  }
  return !!target.sessionPath && task.sessionPath === target.sessionPath;
}

export class DeferredResultStore {
  constructor(bus = null, persistPath = null, options = {}) {
    this._bus = bus || null;
    this._getSessionIdForPath = typeof options?.getSessionIdForPath === "function"
      ? options.getSessionIdForPath
      : null;
    this._persistPath = persistPath || null;
    this._tasks = new Map();
    this._resultCbs = [];
    this._failCbs = [];
    if (this._persistPath) this._load();

    this.cleanup();
    this._cleanupTimer = setInterval(() => this.cleanup(), 24 * 60 * 60 * 1000);
    this._cleanupTimer.unref();
  }

  dispose() {
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
    }
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    this._flushToDisk();
  }

  defer(taskId, sessionPath, meta = {}) {
    if (this._tasks.has(taskId)) return;
    const sessionRef = normalizeSessionRef(sessionPath, this._getSessionIdForPath);
    this._tasks.set(taskId, {
      status: "pending",
      sessionId: sessionRef.sessionId,
      sessionPath: sessionRef.sessionPath,
      sessionRef: sessionRef.sessionRef,
      meta,
      deferredAt: Date.now(),
      result: null,
      reason: null,
      delivered: false,
    });
    this._save();
  }

  resolve(taskId, result) {
    const task = this._tasks.get(taskId);
    if (!task || task.status !== "pending") return;
    task.status = "resolved";
    task.result = result;
    this._save();

    for (const cb of this._resultCbs) {
      try { cb(taskId, task.sessionPath, result, task.meta); } catch {}
    }
    this._bus?.emit({
      type: "deferred_result",
      taskId,
      status: "success",
      result,
      meta: task.meta,
      ...(task.sessionId ? { sessionId: task.sessionId, sessionRef: task.sessionRef } : {}),
    }, task.sessionPath);
  }

  fail(taskId, reason) {
    const task = this._tasks.get(taskId);
    if (!task || task.status !== "pending") return;
    task.status = "failed";
    task.reason = reason;
    this._save();

    for (const cb of this._failCbs) {
      try { cb(taskId, task.sessionPath, reason, task.meta); } catch {}
    }
    this._bus?.emit({
      type: "deferred_result",
      taskId,
      status: "failed",
      reason,
      meta: task.meta,
      ...(task.sessionId ? { sessionId: task.sessionId, sessionRef: task.sessionRef } : {}),
    }, task.sessionPath);
  }

  retry(taskId, sessionPath, meta = {}) {
    const existing = this._tasks.get(taskId);
    const sessionRef = normalizeSessionRef(sessionPath, this._getSessionIdForPath);
    const next = {
      status: "pending",
      sessionId: sessionRef.sessionId,
      sessionPath: sessionRef.sessionPath,
      sessionRef: sessionRef.sessionRef,
      meta,
      deferredAt: Date.now(),
      result: null,
      reason: null,
      delivered: false,
    };
    if (existing) {
      Object.assign(existing, next);
      delete existing.deliverySuppressed;
      delete existing.suppressedAt;
      delete existing.suppressionReason;
    } else {
      this._tasks.set(taskId, next);
    }
    this._save();
  }

  abort(taskId, reason) {
    const task = this._tasks.get(taskId);
    if (!task || task.status !== "pending") return;
    task.status = "aborted";
    task.reason = reason || "user aborted";
    this._save();

    for (const cb of this._failCbs) {
      try { cb(taskId, task.sessionPath, task.reason, task.meta); } catch {}
    }
    this._bus?.emit({
      type: "deferred_result",
      taskId,
      status: "aborted",
      reason: task.reason,
      meta: task.meta,
      ...(task.sessionId ? { sessionId: task.sessionId, sessionRef: task.sessionRef } : {}),
    }, task.sessionPath);
  }

  markDelivered(taskId) {
    const task = this._tasks.get(taskId);
    if (task) {
      task.delivered = true;
      delete task.deliverySuppressed;
      delete task.suppressedAt;
      delete task.suppressionReason;
      this._save();
    }
  }

  suppressDelivery(taskId, reason = "delivery suppressed") {
    const task = this._tasks.get(taskId);
    if (!task) return false;
    if (task.status === "pending") {
      task.status = "aborted";
      task.reason = reason;
    }
    task.delivered = true;
    task.deliverySuppressed = true;
    task.suppressedAt = Date.now();
    task.suppressionReason = reason;
    this._save();
    return true;
  }

  query(taskId) {
    const task = this._tasks.get(taskId);
    return task ? { ...task } : null;
  }

  listPending(sessionPath) {
    const result = [];
    for (const [taskId, task] of this._tasks) {
      if (matchesSession(task, sessionPath, this._getSessionIdForPath) && task.status === "pending") {
        result.push({ taskId, meta: task.meta, deferredAt: task.deferredAt });
      }
    }
    return result;
  }

  listBySession(sessionPath) {
    const result = [];
    for (const [taskId, task] of this._tasks) {
      if (matchesSession(task, sessionPath, this._getSessionIdForPath)) {
        result.push({ taskId, ...task });
      }
    }
    return result;
  }

  listUndelivered(sessionPath = null) {
    const result = [];
    for (const [taskId, task] of this._tasks) {
      if (
        (!sessionPath || matchesSession(task, sessionPath, this._getSessionIdForPath))
        && !task.delivered
        && (task.status === "resolved" || task.status === "failed" || task.status === "aborted")
      ) {
        result.push({ taskId, ...task });
      }
    }
    return result;
  }

  listAttention(limit = 20) {
    const result = [];
    for (const [taskId, task] of this._tasks) {
      const completed = task.status === "resolved" || task.status === "failed" || task.status === "aborted";
      if (task.status === "pending" || task.status === "failed" || task.status === "aborted" || (completed && !task.delivered)) {
        result.push({ taskId, ...task });
      }
    }
    return result
      .sort((a, b) => (b.deferredAt || 0) - (a.deferredAt || 0))
      .slice(0, limit);
  }

  summary() {
    const counts = {
      total: this._tasks.size,
      pending: 0,
      resolved: 0,
      failed: 0,
      aborted: 0,
      delivered: 0,
      undelivered: 0,
    };

    for (const task of this._tasks.values()) {
      if (task.status === "pending") counts.pending += 1;
      else if (task.status === "resolved") counts.resolved += 1;
      else if (task.status === "failed") counts.failed += 1;
      else if (task.status === "aborted") counts.aborted += 1;

      if (task.delivered) {
        counts.delivered += 1;
      } else if (task.status === "resolved" || task.status === "failed" || task.status === "aborted") {
        counts.undelivered += 1;
      }
    }

    return counts;
  }

  onResult(callback) {
    this._resultCbs.push(callback);
    return () => {
      const idx = this._resultCbs.indexOf(callback);
      if (idx !== -1) this._resultCbs.splice(idx, 1);
    };
  }

  onFail(callback) {
    this._failCbs.push(callback);
    return () => {
      const idx = this._failCbs.indexOf(callback);
      if (idx !== -1) this._failCbs.splice(idx, 1);
    };
  }

  clearBySession(sessionPath) {
    for (const [taskId, task] of this._tasks) {
      if (matchesSession(task, sessionPath, this._getSessionIdForPath) && task.status === "pending") {
        this._tasks.delete(taskId);
      }
    }
    this._save();
  }

  suppressBySession(sessionPath, reason = "parent session unavailable") {
    let aborted = 0;
    let suppressed = 0;
    let unchanged = 0;
    for (const task of this._tasks.values()) {
      if (!matchesSession(task, sessionPath, this._getSessionIdForPath)) continue;
      if (task.status === "pending") {
        task.status = "aborted";
        task.reason = reason;
        task.delivered = true;
        task.deliverySuppressed = true;
        task.suppressedAt = Date.now();
        task.suppressionReason = reason;
        aborted++;
        continue;
      }
      if (
        !task.delivered
        && (task.status === "resolved" || task.status === "failed" || task.status === "aborted")
      ) {
        task.delivered = true;
        task.deliverySuppressed = true;
        task.suppressedAt = Date.now();
        task.suppressionReason = reason;
        suppressed++;
        continue;
      }
      unchanged++;
    }
    if (aborted || suppressed) this._save();
    return { aborted, suppressed, unchanged };
  }

  cleanup() {
    const now = Date.now();
    let changed = false;
    for (const [taskId, task] of this._tasks) {
      if (task.delivered && (now - task.deferredAt > CLEANUP_MAX_AGE)) {
        this._tasks.delete(taskId);
        changed = true;
      }
    }
    if (changed) this._save();
  }

  get size() { return this._tasks.size; }

  _save() {
    if (!this._persistPath) return;
    this._dirty = true;
    if (!this._saveTimer) {
      this._saveTimer = setTimeout(() => this._flushToDisk(), 1000);
      this._saveTimer.unref();
    }
  }

  _flushToDisk() {
    this._saveTimer = null;
    if (!this._dirty) return;
    this._dirty = false;
    try {
      const obj = {};
      for (const [k, v] of this._tasks) obj[k] = v;
      fs.mkdirSync(path.dirname(this._persistPath), { recursive: true });
      atomicWriteSync(this._persistPath, JSON.stringify(obj, null, 2) + "\n");
    } catch { /* best effort */ }
  }

  _load() {
    if (!this._persistPath) return;
    try {
      if (!fs.existsSync(this._persistPath)) return;
      const raw = JSON.parse(fs.readFileSync(this._persistPath, "utf-8"));
      for (const [k, v] of Object.entries(raw)) {
        const sessionRef = normalizeSessionRef(v, this._getSessionIdForPath);
        this._tasks.set(k, {
          delivered: false,
          ...(v as any),
          sessionId: (v as any)?.sessionId || sessionRef.sessionId,
          sessionPath: (v as any)?.sessionPath || sessionRef.sessionPath,
          sessionRef: (v as any)?.sessionRef || sessionRef.sessionRef,
        });
      }
    } catch { /* best effort */ }
  }
}
