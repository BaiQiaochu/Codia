// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export class WorkflowJournal {
  constructor(journalPath) {
    this._path = journalPath || null;
    this._entries = new Map();
    this._invalidatedAfter = Infinity;
    this._replayHits = 0;
  }

  static computeKey(prompt, opts) {
    const sanitized = {};
    if (opts && typeof opts === "object") {
      for (const [key, value] of Object.entries(opts)) {
        if (typeof value === "function") continue;
        if (key === "signal" || key === "onSessionReady") continue;
        sanitized[key] = value;
      }
    }
    const payload = JSON.stringify({ p: prompt, o: sanitized });
    return crypto.createHash("sha256").update(payload).digest("hex").slice(0, 16);
  }

  static load(journalPath) {
    const journal = new WorkflowJournal(journalPath);
    if (!journalPath) return journal;
    try {
      if (!fs.existsSync(journalPath)) return journal;
      const lines = fs.readFileSync(journalPath, "utf-8").split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (typeof entry.nodeSeq === "number") {
            journal._entries.set(entry.nodeSeq, entry);
          }
        } catch {
          // Ignore malformed lines so one corrupt append does not discard prior entries.
        }
      }
    } catch {
      // Corrupt or unreadable journal files simply force a fresh run.
    }
    return journal;
  }

  tryReplay(nodeSeq, key) {
    if (nodeSeq > this._invalidatedAfter) return null;
    const entry = this._entries.get(nodeSeq);
    if (!entry || entry.key !== key) {
      this._invalidatedAfter = nodeSeq - 1;
      return null;
    }
    if (entry.status !== "ok") {
      this._invalidatedAfter = nodeSeq - 1;
      return null;
    }
    this._replayHits++;
    return { hit: true, result: entry.result };
  }

  record(nodeSeq, key, result, status = "ok") {
    const entry = { nodeSeq, key, result, status, ts: Date.now() };
    this._entries.set(nodeSeq, entry);
    this._appendLine(entry);
  }

  _appendLine(entry) {
    if (!this._path) return;
    try {
      fs.mkdirSync(path.dirname(this._path), { recursive: true });
      fs.appendFileSync(this._path, JSON.stringify(entry) + "\n");
    } catch {
      // Best effort persistence.
    }
  }

  get replayHits() { return this._replayHits; }
  get totalEntries() { return this._entries.size; }
  get hasEntries() { return this._entries.size > 0; }
}
