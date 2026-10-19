// @ts-nocheck
import { usageCostRates, usageReservationBinding } from "./usage-pricing.ts";
import { randomUUID } from "node:crypto";
import { UsageBudgetStore } from "./usage-budget-store.ts";
import { redactLogText } from "../log-redactor.ts";
import { normalizeLlmUsage } from "./usage-observer.ts";
import {
  attributionSessionPath,
  isUnknownUsageContext as isUnknownUsageContextValue,
  normalizeUsageContext,
} from "./usage-context.ts";

// Host-only evidence, deliberately not a JSON field a provider payload can set.
export const FINAL_PROVIDER_RESPONSE = Symbol("codia.finalProviderResponse");
const DEFAULT_MAX_ENTRIES = 5_000;

export function createUsageLedger({
  maxEntries = DEFAULT_MAX_ENTRIES,
  eventBus = null,
  logger = null,
  now = () => Date.now(),
  requestIdFactory = null,
  dbPath = null,
} = {}) {
  const entries = [];
  const pending = new Map();
  const storage = new UsageBudgetStore(dbPath || ":memory:", now);
  const statisticsStartedAt = storage.report().statisticsStartedAt;
  let droppedEntries = 0;
  let sequence = 0;

  const nextRequestId = () => {
    if (typeof requestIdFactory === "function") return String(requestIdFactory());
    sequence += 1;
    return `llm_${now().toString(36)}_${sequence.toString(36)}_${randomUUID()}`;
  };

  const append = (entry) => {
    const normalizedEntry = normalizeEntry(entry, now);
    if (entryHasUnknownUsageContext(normalizedEntry)) {
      warn(logger, `unknown usage context for LLM request ${normalizedEntry.requestId}`);
    }
    storage.settle(normalizedEntry);
    entries.push(normalizedEntry);
    while (entries.length > maxEntries) { entries.shift(); droppedEntries++; }
    emit(eventBus, normalizedEntry);
    return normalizedEntry;
  };

  return {
    start(meta = {}) {
      const requestId = meta.requestId ? String(meta.requestId) : nextRequestId();
      const startedMs = now();
      const usageContext = accountingContext(meta.usageContext);
      const pendingEntry = {
        requestId,
        startedMs,
        startedAt: toIso(startedMs),
        source: usageContext.source,
        attribution: usageContext.attribution,
        model: normalizeModel(meta.model),
        costRates: usageCostRates(meta.model, meta.costRates),
        reservationBinding: usageReservationBinding(meta.model, meta.maxOutputTokens),
        pricing: meta.model?.pricing ? { source: redactLogText(String(meta.model.pricing.source || "")), confirmedAt: meta.model.pricing.confirmedAt, confirmedFree: meta.model.pricing.confirmedFree } : null,
      };
      if (entryHasUnknownUsageContext(pendingEntry)) {
        warn(logger, `unknown usage context for LLM request ${requestId}`);
      }
      storage.reserve({ ...pendingEntry, model: { ...meta.model, ...pendingEntry.model }, maxOutputTokens: meta.maxOutputTokens }, { observationOnly: meta.observationOnly === true });
      pending.set(requestId, pendingEntry);
      return { requestId, startedAt: pendingEntry.startedAt };
    },

    finish(requestId, result = {}) {
      const pendingEntry = pending.get(requestId) || storage.pending(requestId);
      if (!pendingEntry) return null;
      pending.delete(requestId);
      const endedMs = now();
      const usage = normalizeUsage(result.usage, {
        costRates: pendingEntry.costRates,
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
        costBasis: costBasis(usage, pendingEntry.costRates, result.usage),
        pricing: pendingEntry.pricing,
        rawUsageShape: rawUsageShape(result.usage),
        error: null,
      });
    },

    recordError(requestId, error, status = "error", result = {}) {
      const pendingEntry = pending.get(requestId) || storage.pending(requestId);
      if (!pendingEntry) return null;
      pending.delete(requestId);
      const endedMs = now();
      const usage = normalizeUsage(result.usage, {
        costRates: pendingEntry.costRates,
        cacheSupport: result.cacheSupport,
      });
      const finalResponse = result[FINAL_PROVIDER_RESPONSE] === true;
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
        // Stream/transport errors default to partial, even with positive counters.
        // A host may attest a complete final response before a local validation error.
        usage: finalResponse ? usage : null,
        reportedPartialUsage: finalResponse ? null : usage,
        costBasis: finalResponse ? costBasis(usage, pendingEntry.costRates, result.usage) : "unknown",
        pricing: pendingEntry.pricing,
        rawUsageShape: rawUsageShape(result.usage),
        error: normalizeError(error),
      });
    },

    record(meta = {}) {
      const request = this.start({ ...meta, observationOnly: true });
      return this.finish(request.requestId, {
        usage: meta.usage,
        model: meta.model,
        costRates: meta.costRates,
        cacheSupport: meta.cacheSupport,
      });
    },

    list(filter = {}) {
      const limit = normalizeLimit(filter.limit);
      const available = dbPath ? storage.entries() : entries;
      const filtered = available.filter(entry => matchesFilter(entry, filter));
      const limited = limit ? filtered.slice(Math.max(0, filtered.length - limit)) : filtered;
      return {
        entries: limited.map(clone),
        nextCursor: null,
        completeness: { persistent: !!dbPath, statisticsStartedAt, storedEntries: available.length, matchingEntries: filtered.length, returnedEntries: limited.length,
          truncated: limited.length < filtered.length || (!dbPath && droppedEntries > 0), droppedEntries: dbPath ? 0 : droppedEntries,
          firstReturnedAt: limited[0]?.startedAt || null, lastReturnedAt: limited.at(-1)?.endedAt || null },
      };
    },

    assertReservationMatches(requestId, model, maxOutputTokens) {
      const entry = pending.get(requestId) || storage.pending(requestId);
      if (!entry || entry.reservationBinding !== usageReservationBinding(model, maxOutputTokens)) throw new Error('Model or price reservation changed; recreate the session snapshot before retrying');
    },
    hasPending(requestId) { return pending.has(requestId) || !!storage.pending(requestId); },
    getBudgetReport(agentId) { return storage.report(agentId); },
    getBudgetConfig() { return storage.getConfig(); },
    setBudgetConfig(config, expectedRevision) { return storage.setConfig(config, expectedRevision); },
    close() { storage.close(); },

    clear() {
      entries.length = 0;
      pending.clear();
      // Clear is an explicit caller operation, never automatic retention.
      storage.db.exec("DELETE FROM usage_entries; DELETE FROM usage_reservations; DELETE FROM usage_budget_pauses;");
    },
  };
}

function normalizeEntry(entry, now) {
  const usageContext = accountingContext({
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
    ...(entry.reportedPartialUsage ? { reportedPartialUsage: entry.reportedPartialUsage } : {}),
    costBasis: entry.costBasis || "unknown",
    pricing: entry.pricing ?? null,
    rawUsageShape: typeof entry.rawUsageShape === "string" ? entry.rawUsageShape : null,
    error: entry.error ?? null,
  };
}

function normalizeUsage(usage, options) {
  if (!usage) return null;
  // Rebuild normalized inputs from supported scalar fields. Never persist caller
  // extras (headers/metadata/etc), and apply the same consistency checks as raw SDK usage.
  const structured = usage.input && typeof usage.input === "object" && usage.output && usage.cache;
  const normalized = structured ? normalizeLlmUsage({
    prompt_tokens: usage.input.totalTokens,
    completion_tokens: usage.output.totalTokens,
    total_tokens: usage.totalTokens,
    cacheMissTokens: usage.input.uncachedTokens ?? usage.cache.missTokens,
    cacheWrite: usage.cache.writeTokens,
    prompt_tokens_details: { cached_tokens: usage.cache.readTokens },
    reasoningTokens: usage.output.reasoningTokens,
    costTotal: usage.costTotal,
  }, { ...options, cacheSupport: options.cacheSupport ?? usage.cache.support }) : normalizeLlmUsage(usage, options);
  // A zero SDK/default price without a confirmed rate is not evidence of free service.
  return normalized && !options.costRates && normalized.costTotal === 0 ? { ...normalized, costTotal: null } : normalized;
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
    message: redactLogText(typeof error.message === "string" ? error.message : String(error)),
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
  if (filter.runId && entry.attribution?.runId !== filter.runId) return false;
  if (filter.jobId && (entry.attribution?.jobId || entry.attribution?.taskId) !== filter.jobId) return false;
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

function costBasis(usage, rates, rawUsage) {
  if (typeof usage?.costTotal !== "number" || !Number.isFinite(usage.costTotal)) return "unknown";
  // Pi SDK costs are calculated from model rates, never a reconciled invoice.
  return rates || rawUsage?.cost ? "configured_estimate" : "provider_reported";
}

function accountingContext(input) {
  const ctx = normalizeUsageContext(input);
  const pick = value => Object.fromEntries(['kind','agentId','sessionPath','sessionId','runId','jobId','taskId','threadId','threadKind','conversationId','conversationType','childAgentId','childSessionPath'].filter(key => typeof value?.[key] === 'string' || value?.[key] === null).map(key => [key, value[key]]));
  return { source: { subsystem: ctx.source.subsystem, operation: ctx.source.operation, surface: ctx.source.surface, trigger: ctx.source.trigger,
    ...(ctx.source.actor ? {actor: pick(ctx.source.actor)} : {}), ...(ctx.source.parent ? {parent: pick(ctx.source.parent)} : {}) }, attribution: pick(ctx.attribution) };
}
