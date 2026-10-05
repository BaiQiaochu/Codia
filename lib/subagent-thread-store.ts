// @ts-nocheck
/**
  *
 *
  *
 * - direct：普-subagent 创建出的可继续线程，由主 agent 决定何时关闭
 * - ephemeral / reusable：旧数据兼容 kind，加载时规范化为 direct
  * */

import fs from "node:fs";
import path from "node:path";
import { atomicWriteSync } from "../shared/safe-fs.ts";

export const SUBAGENT_THREAD_STORE_VERSION = 1;

const VALID_KINDS = new Set(["direct", "workflow_node"]);
const LEGACY_DIRECT_KINDS = new Set(["ephemeral", "reusable"]);
const VALID_THREAD_STATUSES = new Set(["open", "closed"]);
const VALID_RUN_STATUSES = new Set(["pending", "resolved", "failed", "aborted"]);
const VALID_ACCESS = new Set(["read", "write"]);

function nowIso() {
  return new Date().toISOString();
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function pickString(value) {
  return typeof value === "string" && value.trim() ? value : null;
}

function pickCount(value) {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function normalizeKind(kind, fallback = "direct") {
  if (VALID_KINDS.has(kind)) return kind;
  if (LEGACY_DIRECT_KINDS.has(kind)) return "direct";
  return fallback;
}

function normalizeThreadStatus(status, fallback = "open") {
  return VALID_THREAD_STATUSES.has(status) ? status : fallback;
}

function normalizeRunStatus(status, fallback = "pending") {
  return VALID_RUN_STATUSES.has(status) ? status : fallback;
}

function normalizeAccess(access, fallback = null) {
  if (VALID_ACCESS.has(access)) return access;
  return VALID_ACCESS.has(fallback) ? fallback : null;
}

function pickThreadLabel(record = {}, existing = null) {
  if (pickString(record.label)) return pickString(record.label);
  if (pickString(record.instance)) return pickString(record.instance);
  if (pickString(record.taskSuffix)) return pickString(record.taskSuffix);
  if (pickString(record.reuseKey)) {
    const parts = record.reuseKey.split("::").map((part) => part.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return existing?.label || null;
}

function normalizeThread(threadId, record = {}, existing = null) {
  const timestamp = nowIso();
  const kind = normalizeKind(record.kind, normalizeKind(existing?.kind || "direct"));
  const status = normalizeThreadStatus(record.status, existing?.status || "open");
  const hasClosedAt = Object.prototype.hasOwnProperty.call(record, "closedAt");
  return {
    ...(existing || {}),
    threadId,
    kind,
    status,
    lastRunStatus: normalizeRunStatus(record.lastRunStatus || record.runStatus, existing?.lastRunStatus || "pending"),
    parentSessionId: pickString(record.parentSessionId) || existing?.parentSessionId || null,
    parentSessionPath: pickString(record.parentSessionPath) || existing?.parentSessionPath || null,
    parentTaskId: pickString(record.parentTaskId) || existing?.parentTaskId || null,
    nodeId: pickString(record.nodeId) || existing?.nodeId || null,
    agentId: pickString(record.agentId) || existing?.agentId || null,
    agentName: pickString(record.agentName) || existing?.agentName || null,
    childSessionId: pickString(record.childSessionId) || existing?.childSessionId || null,
    childSessionPath: pickString(record.childSessionPath) || pickString(record.sessionPath) || existing?.childSessionPath || null,
    label: pickThreadLabel(record, existing),
    access: normalizeAccess(record.access, existing?.access || null),
    summary: pickString(record.summary) || existing?.summary || null,
    runCount: pickCount(record.runCount ?? existing?.runCount),
    createdAt: existing?.createdAt || pickString(record.createdAt) || timestamp,
    lastRunAt: pickString(record.lastRunAt) || existing?.lastRunAt || null,
    closedAt: hasClosedAt ? pickString(record.closedAt) : (existing?.closedAt || null),
    updatedAt: timestamp,
  };
}

export class SubagentThreadStore {
  constructor(persistPath = null, { getSessionIdForPath = null } = {}) {
    this._persistPath = persistPath || null;
    this._threads = new Map();
    this._chains = new Map();
    this._getSessionIdForPath = typeof getSessionIdForPath === "function" ? getSessionIdForPath : () => null;
    if (this._persistPath) this._load();
  }

  beginRun(threadId, record = {}) {
    if (!threadId) return null;
    const existing = this._threads.get(threadId) || null;
    const next = normalizeThread(threadId, {
      ...record,
      parentSessionId: this._parentSessionIdFromRecord(record, existing),
      status: "open",
      lastRunStatus: "pending",
      runCount: (existing?.runCount || 0) + 1,
      lastRunAt: nowIso(),
      closedAt: null,
    }, existing);
    this._threads.set(threadId, next);
    this._save();
    return clone(next);
  }

  attachSession(threadId, childSessionPath, record = {}) {
    if (!threadId) return null;
    const existing = this._threads.get(threadId) || null;
    const next = normalizeThread(threadId, {
      ...record,
      parentSessionId: this._parentSessionIdFromRecord(record, existing),
      childSessionPath,
      status: existing?.status || "open",
    }, existing);
    this._threads.set(threadId, next);
    this._save();
    return clone(next);
  }

  finishRun(threadId, record = {}) {
    if (!threadId) return null;
    const existing = this._threads.get(threadId) || null;
    if (!existing) return null;
    const close = record.close === true;
    const next = normalizeThread(threadId, {
      ...record,
      parentSessionId: this._parentSessionIdFromRecord(record, existing),
      status: close ? "closed" : "open",
      lastRunStatus: normalizeRunStatus(record.status || record.lastRunStatus, existing.lastRunStatus),
      closedAt: close ? nowIso() : null,
    }, existing);
    this._threads.set(threadId, next);
    this._save();
    return clone(next);
  }

  upsert(threadId, record = {}) {
    if (!threadId) return null;
    const existing = this._threads.get(threadId) || null;
    const next = normalizeThread(threadId, {
      ...record,
      parentSessionId: this._parentSessionIdFromRecord(record, existing),
    }, existing);
    this._threads.set(threadId, next);
    this._save();
    return clone(next);
  }

  get(threadId) {
    if (!threadId) return null;
    return clone(this._threads.get(threadId) || null);
  }

  list() {
    return Array.from(this._threads.values()).map(clone);
  }

  listOpenDirectBySession(parentSessionPath) {
    if (!parentSessionPath) return [];
    const targetKey = this._parentSessionKeyForPath(parentSessionPath);
    const out = [];
    for (const rec of this._threads.values()) {
      if (this._parentSessionKeyForRecord(rec) !== targetKey) continue;
      if (rec.kind !== "direct") continue;
      if (rec.status !== "open") continue;
      out.push(clone(rec));
    }
    return out.sort((a, b) => String(a.lastRunAt || a.updatedAt || "").localeCompare(String(b.lastRunAt || b.updatedAt || "")));
  }

  closeDirectThread(threadId, record = {}) {
    if (!threadId) return null;
    const existing = this._threads.get(threadId) || null;
    if (!existing || existing.kind !== "direct") return null;
    const next = normalizeThread(threadId, {
      ...record,
      status: "closed",
      closedAt: nowIso(),
      lastRunStatus: record.lastRunStatus || existing.lastRunStatus,
    }, existing);
    this._threads.set(threadId, next);
    this._save();
    return clone(next);
  }

  remove(threadId) {
    if (!threadId || !this._threads.has(threadId)) return false;
    this._threads.delete(threadId);
    this._save();
    return true;
  }

  removeBySession(parentSessionPath) {
    if (!parentSessionPath) return 0;
    const targetKey = this._parentSessionKeyForPath(parentSessionPath);
    let removed = 0;
    for (const [id, rec] of this._threads) {
      if (this._parentSessionKeyForRecord(rec) === targetKey) {
        this._threads.delete(id);
        removed += 1;
      }
    }
    if (removed) this._save();
    return removed;
  }

  removeByAgentId(agentId) {
    if (!agentId) return 0;
    let removed = 0;
    for (const [id, rec] of this._threads) {
      if (rec.agentId === agentId) {
        this._threads.delete(id);
        removed += 1;
      }
    }
    if (removed) this._save();
    return removed;
  }

  get size() {
    return this._threads.size;
  }

  isBusy(threadId) {
    return !!threadId && this._chains.has(threadId);
  }

  runSerialized(threadId, taskFn) {
    if (!threadId) return Promise.resolve().then(() => taskFn());
    const prev = this._chains.get(threadId) || Promise.resolve();
    const run = prev.then(() => taskFn());
    const tail = run.then(() => {}, () => {});
    this._chains.set(threadId, tail);
    tail.then(() => {
      if (this._chains.get(threadId) === tail) this._chains.delete(threadId);
    });
    return tail.then(() => run);
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

  _parentSessionKeyForRecord(record) {
    return pickString(record?.parentSessionId)
      || this._sessionIdForPath(record?.parentSessionPath)
      || record?.parentSessionPath
      || null;
  }

  _save() {
    if (!this._persistPath) return;
    const data = {
      schemaVersion: SUBAGENT_THREAD_STORE_VERSION,
      threads: Object.fromEntries(this._threads.entries()),
    };
    fs.mkdirSync(path.dirname(this._persistPath), { recursive: true });
    atomicWriteSync(this._persistPath, JSON.stringify(data, null, 2) + "\n");
  }

  _load() {
    if (!this._persistPath || !fs.existsSync(this._persistPath)) return;
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(this._persistPath, "utf-8"));
    } catch {
      return;
    }
    const threads = raw?.threads && typeof raw.threads === "object" ? raw.threads : {};
    let repaired = false;
    for (const [threadId, value] of Object.entries(threads)) {
      if (!threadId || !value || typeof value !== "object") continue;
      const next = normalizeThread(threadId, value);
      if (next.lastRunStatus === "pending") {
        repaired = true;
        next.lastRunStatus = "failed";
        if (next.kind === "direct") {
          next.status = "open";
          next.closedAt = null;
        } else {
          next.status = "closed";
          next.closedAt = next.closedAt || next.lastRunAt || next.updatedAt || nowIso();
        }
      }
      this._threads.set(threadId, next);
    }
    if (repaired) this._save();
  }
}
