// @ts-nocheck
/**
  *
  * */

import crypto from "crypto";

const DEFAULT_TIMEOUT = 5 * 60 * 1000; // 5 分钟

export class ConfirmStore {
  constructor() {
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
        resolve({ action: "timeout" });
        this.onResolved?.(confirmId, "timeout");
      }
    }, timeoutMs);

    this._pending.set(confirmId, { resolve, timer, sessionPath, kind, payload });
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
    entry.resolve({ action, value });
    return true;
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

  /**
  *
   * @param {string} sessionPath
   */
  abortBySession(sessionPath) {
    for (const [id, entry] of this._pending) {
      if (entry.sessionPath === sessionPath) {
        clearTimeout(entry.timer);
        this._pending.delete(id);
        entry.resolve({ action: "aborted" });
        this.onResolved?.(id, "aborted");
      }
    }
  }

 /** */
  get size() { return this._pending.size; }
}
