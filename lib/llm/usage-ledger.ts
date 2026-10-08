// @ts-nocheck
import { normalizeLlmUsage } from "./usage-observer.ts";
import {
  attributionSessionPath,
  isUnknownUsageContext as isUnknownUsageContextValue,
  normalizeUsageContext,
} from "./usage-context.ts";

const DEFAULT_MAX_ENTRIES = 5_000;

export function createUsageLedger({
  maxEntries = DEFAULT_MAX_ENTRIES,
  eventBus = null,
  logger = null,
  now = () => Date.now(),
  requestIdFactory = null,
} = {}) {
  const entries = [];
  const pending = new Map();
  let sequence = 0;

  const nextRequestId = () => {
    if (typeof requestIdFactory === "function") return String(requestIdFactory());
    sequence += 1;
    return `llm_${now().toString(36)}_${sequence.toString(36)}`;
  };

  const append = (entry) => {
    const normalizedEntry = normalizeEntry(entry, now);
    if (entryHasUnknownUsageContext(normalizedEntry)) {
      warn(logger, `unknown usage context for LLM request ${normalizedEntry.requestId}`);
    }
    entries.push(normalizedEntry);
    while (entries.length > maxEntries) entries.shift();
    emit(eventBus, normalizedEntry);
    return normalizedEntry;
  };

  return {
    start(meta = {}) {
      const requestId = meta.requestId ? String(meta.requestId) : nextRequestId();
      const startedMs = now();
      const usageContext = normalizeUsageContext(meta.usageContext);
      const pendingEntry = {
        requestId,
        startedMs,
        startedAt: toIso(startedMs),
        source: usageContext.source,
        attribution: usageContext.attribution,
        model: normalizeModel(meta.model),
        costRates: meta.costRates ?? null,
      };
      if (entryHasUnknownUsageContext(pendingEntry)) {
        warn(logger, `unknown usage context for LLM request ${requestId}`);
      }
      pending.set(requestId, pendingEntry);
      return { requestId, startedAt: pendingEntry.startedAt };
    },

    finish(requestId, result = {}) {
      const pendingEntry = pending.get(requestId);
      if (!pendingEntry) return null;
      pending.delete(requestId);
      const endedMs = now();
      const usage = normalizeUsage(result.usage, {
        costRates: result.costRates ?? pendingEntry.costRates,
        cacheSupport: result.cacheSupport,
      });
      return append({
        schemaVersion: 1,
        requestId,
        startedAt: pendingEntry.startedAt,
        endedAt: toIso(endedMs),
        durationMs: Math.max(0, endedMs - pendingEntry.startedMs),
        status: usage ? "ok" : "usage_missing",
        source: pendingEntry.source,
        attribution: pendingEntry.attribution,
        model: normalizeModel(result.model ?? pendingEntry.model),
        usage,
        rawUsageShape: rawUsageShape(result.usage),
        error: null,
      });
    },

    recordError(requestId, error, status = "error", result = {}) {
      const pendingEntry = pending.get(requestId);
      if (!pendingEntry) return null;
      pending.delete(requestId);
      const endedMs = now();
      const usage = normalizeUsage(result.usage, {
        costRates: result.costRates ?? pendingEntry.costRates,
        cacheSupport: result.cacheSupport,
      });
      return append({
        schemaVersion: 1,
        requestId,
        startedAt: pendingEntry.startedAt,
        endedAt: toIso(endedMs),
        durationMs: Math.max(0, endedMs - pendingEntry.startedMs),
        status: status === "aborted" ? "aborted" : "error",
        source: pendingEntry.source,
        attribution: pendingEntry.attribution,
        model: pendingEntry.model,
        usage,
        rawUsageShape: rawUsageShape(result.usage),
        error: normalizeError(error),
      });
    },

    record(meta = {}) {
      const request = this.start(meta);
      return this.finish(request.requestId, {
        usage: meta.usage,
        model: meta.model,
        costRates: meta.costRates,
        cacheSupport: meta.cacheSupport,
      });
    },

    list(filter = {}) {
      const limit = normalizeLimit(filter.limit);
      const filtered = entries.filter(entry => matchesFilter(entry, filter));
      const limited = limit ? filtered.slice(Math.max(0, filtered.length - limit)) : filtered;
      return {
        entries: limited.map(clone),
        nextCursor: null,
      };
    },

    clear() {
      entries.length = 0;
      pending.clear();
    },
  };
}

function normalizeEntry(entry, now) {
  const usageContext = normalizeUsageContext({
    source: entry.source,
    attribution: entry.attribution,
  });
  const startedAt = typeof entry.startedAt === "string" ? entry.startedAt : toIso(now());
  const endedAt = entry.endedAt === null || typeof entry.endedAt === "string" ? entry.endedAt : toIso(now());
  return {
    schemaVersion: 1,
    requestId: String(entry.requestId || ""),
    startedAt,
    endedAt,
    durationMs: numberOrNull(entry.durationMs),
    status: normalizeStatus(entry.status),
    source: usageContext.source,
    attribution: usageContext.attribution,
    model: normalizeModel(entry.model),
    usage: entry.usage ?? null,
    rawUsageShape: typeof entry.rawUsageShape === "string" ? entry.rawUsageShape : null,
    error: entry.error ?? null,
  };
}

function normalizeUsage(usage, options) {
  if (!usage) return null;
  if (usage.input && usage.output && usage.cache && Object.prototype.hasOwnProperty.call(usage, "totalTokens")) {
    return usage;
  }
  return normalizeLlmUsage(usage, options);
}

function normalizeModel(model = {}) {
  return {
    provider: textOrNull(model?.provider),
    modelId: textOrNull(model?.modelId ?? model?.id),
    api: textOrNull(model?.api),
  };
}

function normalizeError(error) {
  if (!error) return { name: null, message: null };
  return {
    name: typeof error.name === "string" ? error.name : null,
    message: typeof error.message === "string" ? error.message : String(error),
  };
}

function normalizeStatus(status) {
  if (status === "ok" || status === "error" || status === "aborted" || status === "usage_missing") {
    return status;
  }
  return "usage_missing";
}

function rawUsageShape(usage) {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
  return Object.keys(usage).sort().join(",");
}

function matchesFilter(entry, filter) {
  if (filter.since && entry.endedAt && entry.endedAt < filter.since) return false;
  if (filter.until && entry.startedAt && entry.startedAt > filter.until) return false;
  if (filter.status && entry.status !== filter.status) return false;
  if (filter.attributionKind && entry.attribution?.kind !== filter.attributionKind) return false;
  if (filter.sessionPath && attributionSessionPath(entry.attribution) !== filter.sessionPath) return false;
  if (filter.agentId && entry.attribution?.agentId !== filter.agentId) return false;
  if (filter.subsystem && entry.source?.subsystem !== filter.subsystem) return false;
  if (filter.operation && entry.source?.operation !== filter.operation) return false;
  if (filter.modelId && entry.model?.modelId !== filter.modelId) return false;
  if (filter.provider && entry.model?.provider !== filter.provider) return false;
  return true;
}

function normalizeLimit(limit) {
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

function emit(eventBus, entry) {
  if (!eventBus || typeof eventBus.emit !== "function") return;
  try {
    eventBus.emit({ type: "llm_usage", entry }, attributionSessionPath(entry.attribution));
  } catch {
    // Usage observation must not break the model request path.
  }
}

function warn(logger, message) {
  try {
    logger?.warn?.(message);
  } catch {
    // Diagnostics should never affect request accounting.
  }
}

function entryHasUnknownUsageContext(entry) {
  return isUnknownUsageContextValue({
    source: entry.source,
    attribution: entry.attribution,
  });
}

function clone(value) {
  return typeof structuredClone === "function"
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

function toIso(ms) {
  return new Date(ms).toISOString();
}

function textOrNull(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
