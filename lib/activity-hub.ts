const VALID_KINDS = new Set(["subagent", "workflow", "workflow_agent", "workflow_step", "heartbeat", "cron"]);
const VALID_STATUSES = new Set(["running", "done", "failed", "aborted"]);
const VALID_LIFECYCLE_STATUSES = new Set(["queued", "running", "succeeded", "failed", "cancelled", "recovery_required"]);
const PERSISTABLE_KINDS = new Set(["workflow", "workflow_agent", "workflow_step", "subagent"]);

function normalizeLifecycleStatus(value: any, existing: any = null) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (VALID_LIFECYCLE_STATUSES.has(raw)) return raw;
  if (raw === "done") return "succeeded";
  if (raw === "aborted") return "cancelled";
  if (VALID_LIFECYCLE_STATUSES.has(existing)) return existing;
  if (existing === "done") return "succeeded";
  if (existing === "aborted") return "cancelled";
  return "running";
}

function legacyStatusFromLifecycle(status: any) {
  if (status === "succeeded") return "done";
  if (status === "cancelled") return "aborted";
  if (status === "failed" || status === "recovery_required") return "failed";
  return "running";
}

function pickStr(v: any, fallback: any) {
  return typeof v === "string" && v ? v : fallback;
}

function pickNum(v: any, fallback: any) {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function normalizeSessionId(value: any) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeSessionPath(value: any) {
  return typeof value === "string" && value.trim() ? value : null;
}

function normalizeSessionRef(value: any, resolveSessionIdForPath: any = null) {
  if (value && typeof value === "object") {
    const sessionPath = normalizeSessionPath(value.sessionPath);
    const sessionId = normalizeSessionId(value.sessionId) || resolveSessionIdForPath?.(sessionPath) || null;
    return { sessionId, sessionPath };
  }
  const sessionPath = normalizeSessionPath(value);
  const sessionId = resolveSessionIdForPath?.(sessionPath) || null;
  return { sessionId, sessionPath };
}

function sameSession(entry: any, sessionRef: any) {
  if (sessionRef.sessionId) return entry.sessionId === sessionRef.sessionId;
  return !!sessionRef.sessionPath && entry.sessionPath === sessionRef.sessionPath;
}

function normalizeEntry(entry: any, existing: any, resolveSessionIdForPath: any = null) {
  const sessionPath = pickStr(entry.sessionPath, existing?.sessionPath ?? null);
  const sessionId = normalizeSessionId(entry.sessionId)
    || normalizeSessionId(existing?.sessionId)
    || resolveSessionIdForPath?.(sessionPath)
    || null;
  const lifecycleStatus = normalizeLifecycleStatus(
    entry.lifecycleStatus ?? entry.status,
    existing?.lifecycleStatus ?? existing?.status,
  );
  const legacyStatus = legacyStatusFromLifecycle(lifecycleStatus);

  return {
    id: entry.id,
    kind: VALID_KINDS.has(entry.kind) ? entry.kind : (existing?.kind || "subagent"),
    status: VALID_STATUSES.has(entry.status) ? entry.status : legacyStatus,
    lifecycleStatus,
    sessionId,
    sessionPath,
    agentId: pickStr(entry.agentId, existing?.agentId ?? null),
    agentName: pickStr(entry.agentName, existing?.agentName ?? null),
    summary: pickStr(entry.summary, existing?.summary ?? null),
    childSessionId: pickStr(entry.childSessionId, existing?.childSessionId ?? null),
    childSessionPath: pickStr(entry.childSessionPath, existing?.childSessionPath ?? null),
    threadId: pickStr(entry.threadId, existing?.threadId ?? null),
    threadKind: pickStr(entry.threadKind, existing?.threadKind ?? null),
    label: pickStr(entry.label, pickStr(entry.reuseInstance, existing?.label ?? null)),
    access: pickStr(entry.access, existing?.access ?? null),
    parentTaskId: pickStr(entry.parentTaskId, existing?.parentTaskId ?? null),
    phaseLabel: pickStr(entry.phaseLabel, existing?.phaseLabel ?? null),
    tokens: pickNum(entry.tokens, existing?.tokens ?? null),
    ...(entry.runBudget || existing?.runBudget ? { runBudget: structuredClone(entry.runBudget || existing.runBudget) } : {}),
    stepKind: pickStr(entry.stepKind, existing?.stepKind ?? null),
    startedAt: pickNum(existing?.startedAt, pickNum(entry.startedAt, null)),
    finishedAt: pickNum(entry.finishedAt, existing?.finishedAt ?? null),
  };
}

export class ActivityHub {
  declare _bus: any;
  declare _getSessionIdForPath: any;
  declare _store: any;
  declare _entries: Map<string, any>;
  declare _cbs: any[];

  constructor(bus = null, store = null, options: any = {}) {
    this._bus = bus;
    this._getSessionIdForPath = typeof options?.getSessionIdForPath === "function"
      ? options.getSessionIdForPath
      : null;
    this._store = store || null;
    this._entries = new Map();
    this._cbs = [];
    if (this._store) this._rehydrateFromStore();
  }

  upsert(entry) {
    if (!entry || typeof entry.id !== "string" || !entry.id) return null;
    const existing = this._entries.get(entry.id) || null;
    const next = normalizeEntry(entry, existing, (sessionPath) => this._resolveSessionIdForPath(sessionPath));
    this._entries.set(next.id, next);
    if (this._store && PERSISTABLE_KINDS.has(next.kind)) this._store.upsert(next);
    this._emit(next);
    return { ...next };
  }

  _rehydrateFromStore() {
    for (const raw of this._store.list()) {
      const orphaned = raw.status === "running";
      const seed = orphaned
        ? { ...raw, status: "failed", lifecycleStatus: "recovery_required", finishedAt: raw.finishedAt ?? null,
          ...(raw.runBudget ? { runBudget: { ...raw.runBudget, state: "blocked", blockedReason: "Process interrupted; usage after the last saved checkpoint is unknown.", usageAfterCheckpointUnknown: true } } : {}) }
        : raw;
      const next = normalizeEntry(seed, null, (sessionPath) => this._resolveSessionIdForPath(sessionPath));
      this._entries.set(next.id, next);
      if (orphaned) this._store.upsert(next);
    }
  }

  rebroadcastSession(sessionPath) {
    const sessionRef = normalizeSessionRef(sessionPath, (path) => this._resolveSessionIdForPath(path));
    if (!sessionRef.sessionId && !sessionRef.sessionPath) return;
    for (const e of this._entries.values()) {
      if (sameSession(e, sessionRef)) this._emit({ ...e });
    }
  }

  get(id) {
    const e = this._entries.get(id);
    return e ? { ...e } : null;
  }

  list() {
    return [...this._entries.values()].map((e) => ({ ...e }));
  }

  listBySession(sessionPath) {
    const sessionRef = normalizeSessionRef(sessionPath, (path) => this._resolveSessionIdForPath(path));
    if (!sessionRef.sessionId && !sessionRef.sessionPath) return [];
    const out = [];
    for (const e of this._entries.values()) {
      if (sameSession(e, sessionRef)) out.push({ ...e });
    }
    return out;
  }

  clearBySession(sessionPath) {
    const sessionRef = normalizeSessionRef(sessionPath, (path) => this._resolveSessionIdForPath(path));
    if (!sessionRef.sessionId && !sessionRef.sessionPath) return;
    for (const [id, e] of this._entries) {
      if (sameSession(e, sessionRef)) this._entries.delete(id);
    }
    this._store?.removeBySession?.(sessionRef.sessionId ? sessionRef : sessionRef.sessionPath);
  }

  remove(id) {
    return this._entries.delete(id);
  }

  onChange(cb) {
    if (typeof cb !== "function") return () => {};
    this._cbs.push(cb);
    return () => {
      const i = this._cbs.indexOf(cb);
      if (i !== -1) this._cbs.splice(i, 1);
    };
  }

  _emit(entry) {
    const snapshot = { ...entry };
    for (const cb of this._cbs) {
      try { cb(snapshot); } catch { /* best effort */ }
    }
    this._bus?.emit?.({ type: "agent_activity", entry: snapshot }, entry.sessionPath ?? null);
  }

  _resolveSessionIdForPath(sessionPath) {
    if (!sessionPath || typeof this._getSessionIdForPath !== "function") return null;
    try {
      return normalizeSessionId(this._getSessionIdForPath(sessionPath));
    } catch {
      return null;
    }
  }
}
