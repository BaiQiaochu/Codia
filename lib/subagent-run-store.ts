// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { atomicWriteSync } from "../shared/safe-fs.ts";

export const SUBAGENT_RUN_STORE_VERSION = 1;

const VALID_STATUSES = new Set(["pending", "resolved", "failed", "aborted"]);

function nowIso() {
  return new Date().toISOString();
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function normalizeStatus(status, fallback = "pending") {
  return VALID_STATUSES.has(status) ? status : fallback;
}

function pickString(value) {
  return typeof value === "string" && value.trim() ? value : null;
}

function normalizeRun(taskId, record = {}, existing = null) {
  const timestamp = nowIso();
  const next = {
    ...(existing || {}),
    taskId,
    status: normalizeStatus(record.status, existing?.status || "pending"),
    parentSessionId: pickString(record.parentSessionId) || existing?.parentSessionId || null,
    parentSessionPath: pickString(record.parentSessionPath) || existing?.parentSessionPath || null,
    childSessionId: pickString(record.childSessionId) || existing?.childSessionId || null,
    childSessionPath: pickString(record.childSessionPath) || pickString(record.sessionPath) || existing?.childSessionPath || null,
    threadId: pickString(record.threadId) || existing?.threadId || null,
    threadKind: pickString(record.threadKind) || existing?.threadKind || null,
    summary: pickString(record.summary) || existing?.summary || null,
    reason: pickString(record.reason) || existing?.reason || null,
    requestedAgentId: pickString(record.requestedAgentId) || existing?.requestedAgentId || null,
    requestedAgentNameSnapshot: pickString(record.requestedAgentNameSnapshot) || existing?.requestedAgentNameSnapshot || null,
    executorAgentId: pickString(record.executorAgentId) || existing?.executorAgentId || null,
    executorAgentNameSnapshot: pickString(record.executorAgentNameSnapshot) || existing?.executorAgentNameSnapshot || null,
    executorMetaVersion: record.executorMetaVersion || existing?.executorMetaVersion || null,
    createdAt: existing?.createdAt || pickString(record.createdAt) || timestamp,
    updatedAt: timestamp,
  };

  if (record.completedAt || (next.status !== "pending" && !next.completedAt)) {
    next.completedAt = pickString(record.completedAt) || timestamp;
  }
  return next;
}

export class SubagentRunStore {
  constructor(persistPath = null, { getSessionIdForPath = null } = {}) {
    this._persistPath = persistPath || null;
    this._runs = new Map();
    this._getSessionIdForPath = typeof getSessionIdForPath === "function" ? getSessionIdForPath : () => null;
    if (this._persistPath) this._load();
  }

  register(taskId, record = {}) {
    if (!taskId) return null;
    const existing = this._runs.get(taskId) || null;
    const next = normalizeRun(taskId, {
      ...record,
      parentSessionId: this._parentSessionIdFromRecord(record, existing),
      status: existing?.status || "pending",
    }, existing);
    this._runs.set(taskId, next);
    this._save();
    return clone(next);
  }

  attachSession(taskId, childSessionPath, record = {}) {
    if (!taskId) return null;
    const existing = this._runs.get(taskId) || null;
    const next = normalizeRun(taskId, {
      ...record,
      parentSessionId: this._parentSessionIdFromRecord(record, existing),
      childSessionPath,
      status: existing?.status || "pending",
    }, existing);
    this._runs.set(taskId, next);
    this._save();
    return clone(next);
  }

  resolve(taskId, summary = null) {
    return this.upsert(taskId, {
      status: "resolved",
      summary: typeof summary === "string" ? summary : null,
    });
  }

  fail(taskId, reason = null) {
    const text = typeof reason === "string" ? reason : null;
    return this.upsert(taskId, {
      status: "failed",
      reason: text,
      summary: text,
    });
  }

  abort(taskId, reason = null) {
    const text = typeof reason === "string" ? reason : null;
    return this.upsert(taskId, {
      status: "aborted",
      reason: text,
      summary: text,
    });
  }

  upsert(taskId, record = {}) {
    if (!taskId) return null;
    const existing = this._runs.get(taskId) || null;
    const next = normalizeRun(taskId, {
      ...record,
      parentSessionId: this._parentSessionIdFromRecord(record, existing),
    }, existing);
    this._runs.set(taskId, next);
    this._save();
    return clone(next);
  }

  query(taskId) {
    return clone(this._runs.get(taskId) || null);
  }

  list() {
    return Array.from(this._runs.values()).map(clone);
  }

  abortByParentSession(parentSessionPath, reason = "parent session aborted") {
    const summary = {
      matched: 0,
      aborted: 0,
      skippedFinal: 0,
    };
    if (!parentSessionPath) return summary;
    const targetKey = this._parentSessionKeyForPath(parentSessionPath);
    for (const [taskId, run] of this._runs) {
      if (this._parentSessionKeyForRecord(run) !== targetKey) continue;
      summary.matched++;
      if (run.status !== "pending") {
        summary.skippedFinal++;
        continue;
      }
      const next = normalizeRun(taskId, {
        status: "aborted",
        reason,
        summary: reason,
      }, run);
      this._runs.set(taskId, next);
      summary.aborted++;
    }
    if (summary.aborted) this._save();
    return summary;
  }

  get size() {
    return this._runs.size;
  }

  _parentSessionIdFromRecord(record = {}, existing = null) {
    return pickString(record.parentSessionId)
      || this._sessionIdForPath(record.parentSessionPath)
      || existing?.parentSessionId
      || this._sessionIdForPath(existing?.parentSessionPath)
      || null;
  }

  _sessionIdForPath(sessionPath) {
    const sessionId = this._getSessionIdForPath?.(sessionPath);
    return pickString(sessionId);
  }

  _parentSessionKeyForPath(parentSessionPath) {
    return this._sessionIdForPath(parentSessionPath) || parentSessionPath;
  }

  _parentSessionKeyForRecord(run) {
    return pickString(run?.parentSessionId)
      || this._sessionIdForPath(run?.parentSessionPath)
      || run?.parentSessionPath
      || null;
  }

  _save() {
    if (!this._persistPath) return;
    const data = {
      schemaVersion: SUBAGENT_RUN_STORE_VERSION,
      runs: Object.fromEntries(this._runs.entries()),
    };
    fs.mkdirSync(path.dirname(this._persistPath), { recursive: true });
    atomicWriteSync(this._persistPath, JSON.stringify(data, null, 2) + "\n");
  }

  _load() {
    if (!this._persistPath || !fs.existsSync(this._persistPath)) return;
    const raw = JSON.parse(fs.readFileSync(this._persistPath, "utf-8"));
    const runs = raw?.runs && typeof raw.runs === "object" ? raw.runs : raw;
    for (const [taskId, value] of Object.entries(runs || {})) {
      if (!taskId || !value || typeof value !== "object") continue;
      this._runs.set(taskId, normalizeRun(taskId, value));
    }
  }
}
