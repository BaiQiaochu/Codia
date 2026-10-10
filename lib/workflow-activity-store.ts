// @ts-nocheck
/**
  *
 * ActivityHub 是内存广播层，进程重启即清空，导致右侧卡（WorkflowCard / AgentActivityCard- * 重启消失。这-store -ActivityHub 标记为可持久的活动（workflow / workflow_agent / subagent- * -activity-hub.js -PERSISTABLE_KINDS）落盘（codiaHome/workflow-activity.json），作为
  *
 * 归属：每-entry 自带 sessionPath，按 path 存取（listBySession / removeBySession），
  * */
import fs from "node:fs";
import path from "node:path";
import { atomicWriteSync } from "../shared/safe-fs.ts";

export const WORKFLOW_ACTIVITY_STORE_VERSION = 1;

export class WorkflowActivityStore {
  constructor(persistPath) {
    this._persistPath = persistPath || null;
    /** @type {Map<string, object>} */
    this._entries = new Map();
    if (this._persistPath) this._load();
  }

  upsert(entry) {
    if (!entry || typeof entry.id !== "string" || !entry.id) return null;
    const next = { ...entry };
    this._entries.set(next.id, next);
    this._save();
    return { ...next };
  }

  get(id) {
    const e = this._entries.get(id);
    return e ? { ...e } : null;
  }

  list() {
    return [...this._entries.values()].map((e) => ({ ...e }));
  }

  listBySession(sessionPath) {
    if (!sessionPath) return [];
    const out = [];
    for (const e of this._entries.values()) {
      if (e.sessionPath === sessionPath) out.push({ ...e });
    }
    return out;
  }

 /** 会话逢场（删除 / 归档 / 冷清理）时回收该 session 的活动，返回删除条数-*/
  removeBySession(sessionPath) {
    if (!sessionPath) return 0;
    let removed = 0;
    for (const [id, e] of this._entries) {
      if (e.sessionPath === sessionPath) {
        this._entries.delete(id);
        removed++;
      }
    }
    if (removed) this._save();
    return removed;
  }

  /**
  *
 * （服务端 Date.now()，测试可注入），返回删除条数。与 session 72h 冷清理对齐- */
  prune(maxAgeMs, nowMs) {
    if (!Number.isFinite(maxAgeMs) || !Number.isFinite(nowMs)) return 0;
    const cutoff = nowMs - maxAgeMs;
    let removed = 0;
    for (const [id, e] of this._entries) {
      const ts = Number.isFinite(e.finishedAt)
        ? e.finishedAt
        : (Number.isFinite(e.startedAt) ? e.startedAt : null);
      if (ts != null && ts < cutoff) {
        this._entries.delete(id);
        removed++;
      }
    }
    if (removed) this._save();
    return removed;
  }

  get size() {
    return this._entries.size;
  }

  _save() {
    if (!this._persistPath) return;
    const data = {
      schemaVersion: WORKFLOW_ACTIVITY_STORE_VERSION,
      entries: Object.fromEntries(this._entries.entries()),
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
      // Damaged persistence should not crash startup; start empty and let the next save replace it.
      return;
    }
    const entries = raw?.entries && typeof raw.entries === "object" ? raw.entries : {};
    for (const [id, value] of Object.entries(entries)) {
      if (!id || !value || typeof value !== "object") continue;
      this._entries.set(id, { ...value, id });
    }
  }
}
