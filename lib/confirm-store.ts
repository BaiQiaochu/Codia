// @ts-nocheck
/**
  *
  * */

import crypto from "crypto";
import fs from "node:fs";
import path from "node:path";
import { atomicWriteSync } from "../shared/safe-fs.ts";
import { redactLogValue } from "./log-redactor.ts";
import { executionContext, findExecutionRun } from "./execution/run-controller.ts";

const DEFAULT_TIMEOUT = 5 * 60 * 1000; // 5 分钟

export class ConfirmStore {
  constructor({ persistPath = null } = {}) {
    this._persistPath = persistPath;
    this._history = new Map();
    if (persistPath && fs.existsSync(persistPath)) {
      try {
        const saved = JSON.parse(fs.readFileSync(persistPath, 'utf8'));
        for (const entry of saved.entries || []) {
          if (typeof entry.id !== 'string') continue;
          this._history.set(entry.id, { ...entry, status: entry.status === 'pending' ? 'interrupted' : entry.status });
        }
      } catch { /* Corrupt audit data must never restore an executable approval. */ }
    }
    /** @type {Map<string, { resolve, timer, sessionPath, kind, payload }>} */
    this._pending = new Map();
    /** @type {((confirmId: string, action: string) => void) | null} */
    this.onResolved = null;
  }

  /**
  *
   *
 * @param {string} kind - 确认类型-settings' | 'cron'- * @param {object} payload - 确认内容（传给前端渲染卡片）
  *
    *
   */
  create(kind, payload, sessionPath, timeoutMs = DEFAULT_TIMEOUT) {
    const confirmId = crypto.randomUUID();
    let resolve;
    const promise = new Promise(r => { resolve = r; });

    const timer = setTimeout(() => {
      if (this._pending.has(confirmId)) {
        this._pending.delete(confirmId);
        this._recordStatus(confirmId, "timeout");
        resolve({ action: "timeout" });
        this.onResolved?.(confirmId, "timeout");
      }
    }, timeoutMs);

    const expiresAt = Date.now() + timeoutMs;
    this._pending.set(confirmId, { resolve, timer, sessionPath, kind, payload, expiresAt });
    this._history.set(confirmId, { id: confirmId, kind, sessionPath, payload: redactLogValue(payload), status: 'pending', createdAt: Date.now(), expiresAt });
    try { this._save(); } catch (error) {
      clearTimeout(timer);
      this._pending.delete(confirmId);
      this._history.delete(confirmId);
      throw error;
    }
    const releaseWait = (executionContext.getStore() || findExecutionRun(sessionPath))?.waitForApproval(confirmId);
    if (releaseWait) promise.then(releaseWait, releaseWait);
    return { confirmId, promise };
  }

  /**
  *
   *
   * @param {string} confirmId
   * @param {string} action - 'confirmed' | 'rejected'
  * */
  resolve(confirmId, action, value) {
    const entry = this._pending.get(confirmId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this._pending.delete(confirmId);
    if (Date.now() >= entry.expiresAt) action = 'timeout';
    const persisted = this._recordStatus(confirmId, action);
    entry.resolve({ action: persisted ? action : 'aborted', value: persisted ? value : undefined });
    return persisted;
  }

  get(confirmId) {
    const entry = this._pending.get(confirmId);
    if (!entry) return null;
    return {
      sessionPath: entry.sessionPath || null,
      kind: entry.kind,
      payload: entry.payload || null,
    };
  }

  /** Public read-only metadata; never expose timers, callbacks or approval payload secrets. */
  listPending() {
    return [...this._pending.entries()].map(([id, entry]) => ({
      id, kind: entry.kind, sessionPath: entry.sessionPath || null,
    }));
  }

  /**
  *
   * @param {string} sessionPath
   */
  abortBySession(sessionPath) {
    for (const [id, entry] of this._pending) {
      if (entry.sessionPath === sessionPath) {
        clearTimeout(entry.timer);
        this._pending.delete(id);
        this._recordStatus(id, "aborted");
        entry.resolve({ action: "aborted" });
        this.onResolved?.(id, "aborted");
      }
    }
  }

  /** Interrupted approvals are evidence only. Resume requires a new live request. */
  listInterrupted() {
    return [...this._history.values()].filter(entry => entry.status === 'interrupted').map(entry => structuredClone(entry));
  }

  _recordStatus(id, status) {
    const record = this._history.get(id);
    if (record) this._history.set(id, { ...record, status, resolvedAt: Date.now() });
    try { this._save(); return true; } catch { return false; }
  }

  _save() {
    if (!this._persistPath) return;
    const entries = [...this._history.values()].slice(-500);
    this._history = new Map(entries.map(entry => [entry.id, entry]));
    fs.mkdirSync(path.dirname(this._persistPath), { recursive: true });
    atomicWriteSync(this._persistPath, JSON.stringify({ version: 1, entries }, null, 2));
  }

 /** */
  get size() { return this._pending.size; }
}
