// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

export class WorkflowJournal {
  constructor(journalPath) {
    this._path = journalPath || null;
    this._entries = new Map();
    this._invalidatedAfter = Infinity;
    this._replayHits = 0;
    this._metadata = null;
    this._finished = false;
    this._budgetState = null;
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
    const payload = JSON.stringify(canonical({ p: prompt, o: sanitized }));
    return crypto.createHash("sha256").update(payload).digest("hex").slice(0, 16);
  }

  static load(journalPath) {
    const journal = new WorkflowJournal(journalPath);
    if (!journalPath || !fs.existsSync(journalPath)) return journal;
    // Never turn unreadable/truncated evidence of possible writes into a fresh run.
    const lines = fs.readFileSync(journalPath, "utf-8").split("\n").filter(Boolean);
    for (const line of lines) {
      let entry;
      try { entry = JSON.parse(line); } catch {
        throw new Error("Workflow journal is corrupt; inspect external results before recovery.");
      }
      if (entry.kind === "budget") {
        journal._budgetState = entry.state;
      } else if (entry.kind === "finished") {
        journal._finished = true;
      } else if (entry.kind === "metadata") {
        if (journal._metadata) throw new Error("Workflow journal contains duplicate run metadata.");
        journal._metadata = entry.metadata;
      } else if (typeof entry.nodeSeq === "number" && typeof entry.key === "string") {
        journal._entries.set(entry.nodeSeq, entry);
      } else {
        throw new Error("Workflow journal contains an invalid action record; recovery blocked.");
      }
    }
    return journal;
  }

  setMetadata(metadata) {
    if (this._metadata) throw new Error("Workflow run metadata is immutable.");
    const snapshot = JSON.parse(JSON.stringify(metadata));
    this._appendLine({ kind: "metadata", metadata: snapshot });
    this._metadata = snapshot;
  }

  assertCompatible(metadata) {
    if (!this._metadata) throw new Error("Workflow journal has no version snapshot; automatic recovery is unsafe.");
    if (this._path && fs.existsSync(`${this._path}.cancelled`)) throw new Error("Workflow recovery was cancelled.");
    if (this._path && fs.existsSync(`${this._path}.resume`)) throw new Error("Workflow checkpoint already resumed; use the latest recovery run instead.");
    if (this._metadata.definitionKey !== metadata.definitionKey) {
      throw new Error("Workflow definition, arguments or execution context changed; recovery blocked.");
    }
    if (!this._finished && this._metadata.ownerPid) {
      let ownerAlive = true;
      try { process.kill(this._metadata.ownerPid, 0); } catch (error) {
        ownerAlive = error.code !== "ESRCH";
      }
      if (ownerAlive) throw new Error("Workflow source run may still be active; wait for it to finish before recovery.");
    }
    for (const entry of this._entries.values()) {
      if (entry.access !== "read" && entry.status !== "ok") {
        throw new Error(`Workflow action ${entry.actionId || entry.nodeSeq} has an unknown external result; inspect it before recovery.`);
      }
    }
  }

  assertRecoveryBudgetSupported(requestedArgs) {
    if (this._metadata?.version === 2 && this._budgetState) {
      const state = this._budgetState;
      if (state.version !== 1 || (state.maxTokens != null && state.usageKnown !== true)
        || [...this._entries.values()].some(entry => entry.status === "running")
        || state.steps < this._entries.size
        || ![state.steps, state.elapsedMs, state.tokens].every(value => Number.isFinite(value) && value >= 0)
        || !Number.isSafeInteger(state.maxSteps) || state.maxSteps <= 0
        || !Number.isSafeInteger(state.maxDurationMs) || state.maxDurationMs <= 0) {
        throw new Error("Cumulative workflow budget accounting cannot be safely restored from an unfinished or incomplete ledger.");
      }
      if (state.steps >= state.maxSteps || state.elapsedMs >= state.maxDurationMs
        || (state.maxTokens != null && state.tokens >= state.maxTokens)
        || state.runBudget?.blockedReason || state.runBudget?.reservations?.length) {
        throw new Error("Cumulative workflow budget exhausted or provider usage uncertain; a new budget requires review.");
      }
      return;
    }
    if (this._metadata?.budgetContract) {
      throw new Error("This budgeted template requires a new reviewed budget after checking prior usage and effects; unbounded checkpoint replay is disabled.");
    }
    // Check persisted limits as well as the request. A new task ID, missing
    // ledger after restart, or changed arguments must never mint a fresh budget
    // for an existing run. Journals do not yet persist cumulative usage, steps,
    // and elapsed-time accounting, so bounded replay is deliberately refused.
    const hasExplicitLimits = (args) => ["budgetTokens", "maxSteps", "maxDurationMs"].some(key => args?.[key] != null);
    if (hasExplicitLimits(this._metadata?.definition?.args) || hasExplicitLimits(requestedArgs)) {
      throw new Error("Cumulative workflow budget accounting cannot be safely restored for budgetTokens, maxSteps or maxDurationMs. Check prior usage and external effects, then review a new run and budget; checkpoint recovery is disabled.");
    }
  }

  inspectRecovery() {
    let blockedReason = null;
    try {
      this.assertCompatible(this._metadata || {});
      this.assertRecoveryBudgetSupported();
    } catch (error) { blockedReason = error.message; }
    return {
      canPrepare: !blockedReason && Boolean(this._metadata?.definition?.script),
      blockedReason: blockedReason || (!this._metadata?.definition?.script ? "Original workflow definition is unavailable." : null),
      actions: [...this._entries.values()].map(({ nodeSeq, actionId, access, status, threadId }) => ({ nodeSeq, actionId, access: access || "write", status, threadId: threadId || null })),
    };
  }

  cancelRecovery() {
    if (!this._path) throw new Error("Recovery requires a persistent journal.");
    const fd = fs.openSync(`${this._path}.cancelled`, "a", 0o600);
    try { fs.writeFileSync(fd, JSON.stringify({ cancelledAt: Date.now() }) + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }

  finish() {
    this._appendLine({ kind: "finished", ts: Date.now() });
    this._finished = true;
  }

  claimRecovery(nextRunId) {
    if (!this._path) throw new Error("Recovery requires a persistent journal.");
    // One successor per checkpoint prevents concurrent or repeated stale resumes.
    let fd;
    try { fd = fs.openSync(`${this._path}.resume`, "wx", 0o600); } catch (error) {
      if (error.code === "EEXIST") throw new Error("Workflow checkpoint already resumed; use the latest recovery run instead.");
      throw error;
    }
    try { fs.writeFileSync(fd, JSON.stringify({ nextRunId })); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }

  inherit(previous) {
    // Retain even unvisited checkpoints across a failed recovery attempt.
    for (const entry of previous._entries.values()) {
      this._appendLine(entry);
      this._entries.set(entry.nodeSeq, structuredClone(entry));
    }
  }

  recordBudget(state) {
    const snapshot = structuredClone(state);
    this._appendLine({ kind: "budget", state: snapshot, ts: Date.now() });
    this._budgetState = snapshot;
  }

  get budgetState() { return this._budgetState ? structuredClone(this._budgetState) : null; }

  actionId(nodeSeq, key) {
    return this._entries.get(nodeSeq)?.actionId || `${this._metadata?.originRunId || this._metadata?.runId || "workflow"}:${nodeSeq}:${key}`;
  }

  getEntry(nodeSeq) {
    const entry = this._entries.get(nodeSeq);
    return entry ? structuredClone(entry) : null;
  }

  tryReplay(nodeSeq, key) {
    const entry = this._entries.get(nodeSeq);
    if (entry && entry.access !== "read" && entry.status !== "ok") {
      throw new Error(`Workflow action ${entry.actionId || nodeSeq} has an unknown external result; inspect it before recovery.`);
    }
    if (entry && entry.access !== "read" && (entry.key !== key || nodeSeq > this._invalidatedAfter)) {
      throw new Error(`Workflow write action ${entry.actionId || nodeSeq} cannot be replayed after the execution changed.`);
    }
    if (nodeSeq > this._invalidatedAfter) return null;
    if (!entry || entry.key !== key || entry.status !== "ok") {
      this._invalidatedAfter = nodeSeq - 1;
      return null;
    }
    this._replayHits++;
    return { hit: true, result: entry.result };
  }

  record(nodeSeq, key, result, status = "ok", details = {}) {
    const entry = { nodeSeq, key, result, status, ts: Date.now(), ...details,
      actionId: details.actionId || this.actionId(nodeSeq, key) };
    // Do not acknowledge a write when persistence failed.
    this._appendLine(entry);
    this._entries.set(nodeSeq, entry);
  }

  _appendLine(entry) {
    if (!this._path) return;
    fs.mkdirSync(path.dirname(this._path), { recursive: true });
    const fd = fs.openSync(this._path, "a", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(entry) + "\n");
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
  }

  get metadata() { return this._metadata ? structuredClone(this._metadata) : null; }
  get replayHits() { return this._replayHits; }
  get totalEntries() { return this._entries.size; }
  get hasEntries() { return this._entries.size > 0; }
}
