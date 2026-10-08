// @ts-nocheck
/**
  *
  *
  * */

import fs from "fs";
import path from "path";
import { atomicWriteSync } from "../../shared/safe-fs.ts";

const MAX_ENTRIES = 100;
export const DEFAULT_ACTIVITY_EXECUTION_TIMEOUT_MS = 20 * 60 * 1000;

function normalizeNow(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : Date.now();
}

function normalizeTimeoutMs(value) {
  if (value === undefined || value === null) return DEFAULT_ACTIVITY_EXECUTION_TIMEOUT_MS;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("executionTimeoutMs must be a positive finite number");
  }
  return value;
}

function formatTimeoutMs(ms) {
  if (ms % 60_000 === 0) return `${ms / 60_000} 分钟`;
  if (ms % 1000 === 0) return `${ms / 1000} 秒`;
  return `${ms}ms`;
}

function activityLabel(entry) {
  return entry?.label || entry?.summary || "后台任务";
}

function interruptedPatch(entry, now) {
  return {
    status: "error",
    finishedAt: now,
    error: "interrupted",
    summary: `${activityLabel(entry)} 已中断：应用已关闭或重启`,
  };
}

export function activityTimeoutPatch(entry, now, timeoutMs = DEFAULT_ACTIVITY_EXECUTION_TIMEOUT_MS) {
  return {
    status: "error",
    finishedAt: now,
    error: "timeout",
    summary: `${activityLabel(entry)} 已超时（超过 ${formatTimeoutMs(timeoutMs)}）`,
  };
}

export class ActivityStore {
  /**
 * @param {string} filePath - activities.json 路径
  * */
  constructor(filePath, activityDir, opts = {}) {
    this._filePath = filePath;
    this._activityDir = activityDir;
    this._executionTimeoutMs = normalizeTimeoutMs(opts.executionTimeoutMs);
    this._entries = [];
    this._load();
    if (opts.finalizeOrphanedRunning !== false) {
      this.finalizeRunningAsInterrupted({ now: opts.now });
    }
  }

  /** @private */
  _load() {
    try {
      const raw = fs.readFileSync(this._filePath, "utf-8");
      this._entries = JSON.parse(raw);
      if (!Array.isArray(this._entries)) this._entries = [];
    } catch {
      this._entries = [];
    }
  }

  /** @private */
  _save() {
    fs.mkdirSync(path.dirname(this._filePath), { recursive: true });
    atomicWriteSync(this._filePath, JSON.stringify(this._entries, null, 2) + "\n");
  }

  /**
   * Add an activity entry.
   * @param {object} entry
   * @returns {object} The added entry.
   */
  add(entry) {
    this._entries.unshift(entry);
    this._cleanup();
    this._save();
    return entry;
  }

 /** */
  list() {
    return this._entries;
  }

  /** */
  get(id) {
    return this._entries.find(e => e.id === id) || null;
  }

 /** */
  update(id, partial) {
    const entry = this._entries.find(e => e.id === id);
    if (!entry) return null;
    const { id: _, ...safePartial } = partial;
    Object.assign(entry, safePartial);
    this._save();
    return entry;
  }

  finalizeRunningAsInterrupted({ now } = {}) {
    const finishedAt = normalizeNow(now);
    const changed = [];
    for (const entry of this._entries) {
      if (entry?.status !== "running") continue;
      Object.assign(entry, interruptedPatch(entry, finishedAt));
      changed.push({ ...entry });
    }
    if (changed.length) this._save();
    return changed;
  }

  reconcileOverdueRunning({ now, executionTimeoutMs } = {}) {
    const finishedAt = normalizeNow(now);
    const timeoutMs = normalizeTimeoutMs(executionTimeoutMs ?? this._executionTimeoutMs);
    const changed = [];
    for (const entry of this._entries) {
      if (entry?.status !== "running") continue;
      if (typeof entry.startedAt !== "number" || !Number.isFinite(entry.startedAt)) continue;
      if (finishedAt - entry.startedAt < timeoutMs) continue;
      Object.assign(entry, activityTimeoutPatch(entry, finishedAt, timeoutMs));
      changed.push({ ...entry });
    }
    if (changed.length) this._save();
    return changed;
  }

 /** Remove an entry by id, used after promotion cleanup. */
  remove(id) {
    const idx = this._entries.findIndex(e => e.id === id);
    if (idx === -1) return false;
    this._entries.splice(idx, 1);
    this._save();
    return true;
  }

 /** */
  _cleanup() {
    while (this._entries.length > MAX_ENTRIES) {
      const old = this._entries.pop();
      //
      if (old?.sessionFile) {
        const sessionPath = path.join(this._activityDir, old.sessionFile);
        try { fs.unlinkSync(sessionPath); } catch {}
      }
    }
  }
}
