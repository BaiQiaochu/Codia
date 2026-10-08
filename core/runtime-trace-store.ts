// @ts-nocheck
import crypto from "crypto";
import path from "path";

const DEFAULT_MAX_TRACES = 100;
const MAX_STRING_LENGTH = 500;
const VALID_TRACE_STATUSES = new Set(["running", "completed", "failed", "aborted"]);
const VALID_TOOL_STATUSES = new Set(["running", "success", "tool_error", "thrown_error", "aborted", "timeout", "blocked"]);

export function createRuntimeTraceStore(options = {}) {
  const maxTraces = Number.isFinite(options.maxTraces) && options.maxTraces > 0
    ? Math.floor(options.maxTraces)
    : DEFAULT_MAX_TRACES;
  const now = typeof options.now === "function" ? options.now : () => new Date().toISOString();
  const traces = new Map();

  function startTrace(input = {}) {
    const traceId = nonEmptyString(input.traceId) || `trace_${crypto.randomUUID()}`;
    const trace = sanitizeTrace({
      traceId,
      sessionPath: input.sessionPath || null,
      agentId: input.agentId || null,
      kind: input.kind || "chat_turn",
      startedAt: input.startedAt || now(),
      endedAt: null,
      status: normalizeTraceStatus(input.status) || "running",
      phases: [],
      toolCalls: [],
    });
    traces.delete(traceId);
    traces.set(traceId, trace);
    trimTraces();
    return clone(trace);
  }

  function recordPhase(traceId, phase, input = {}) {
    const trace = traces.get(traceId);
    if (!trace) return null;
    const entry = sanitizeValue({
      phase: nonEmptyString(phase) || "runtime",
      timestamp: input.timestamp || now(),
      severity: normalizeSeverity(input.severity),
      summary: input.summary || null,
      details: input.details || null,
    });
    trace.phases.push(entry);
    return clone(entry);
  }

  function recordToolCall(input = {}) {
    const traceId = nonEmptyString(input.traceId);
    const trace = traceId ? traces.get(traceId) : null;
    if (!trace) return null;
    const toolTraceId = nonEmptyString(input.toolTraceId) || `tooltrace_${crypto.randomUUID()}`;
    const existing = trace.toolCalls.find((item) => item.toolTraceId === toolTraceId);
    const next = sanitizeToolCall({
      ...(existing || {}),
      ...input,
      traceId,
      toolTraceId,
      timestamp: input.timestamp || existing?.timestamp || now(),
    });
    if (existing) {
      Object.assign(existing, next);
      return clone(existing);
    }
    trace.toolCalls.push(next);
    return clone(next);
  }

  function endTrace(traceId, input = {}) {
    const trace = traces.get(traceId);
    if (!trace) return null;
    trace.endedAt = input.endedAt || now();
    trace.status = normalizeTraceStatus(input.status) || (input.error ? "failed" : "completed");
    if (input.error) {
      recordPhase(traceId, "turn.failed", {
        severity: "error",
        summary: input.error?.message || String(input.error),
      });
    }
    return clone(trace);
  }

  function snapshot() {
    return {
      traces: Array.from(traces.values()).reverse().map(clone),
    };
  }

  function clear() {
    traces.clear();
  }

  function trimTraces() {
    while (traces.size > maxTraces) {
      const oldest = traces.keys().next().value;
      traces.delete(oldest);
    }
  }

  return Object.freeze({
    startTrace,
    recordPhase,
    recordToolCall,
    endTrace,
    snapshot,
    clear,
  });
}

export function sanitizeTraceValue(value, key = "") {
  return sanitizeValue(value, key);
}

function sanitizeTrace(trace) {
  return sanitizeValue(trace);
}

function sanitizeToolCall(input) {
  const status = normalizeToolStatus(input.result?.status);
  return sanitizeValue({
    toolTraceId: input.toolTraceId,
    traceId: input.traceId,
    toolName: input.toolName || "unknown",
    source: input.source || "unknown",
    agentId: input.agentId || null,
    pluginId: input.pluginId || null,
    permission: input.permission || null,
    capability: input.capability || null,
    sandbox: input.sandbox || null,
    input: input.input || null,
    result: input.result ? { ...input.result, status: status || input.result.status } : null,
    timestamp: input.timestamp,
  });
}

function sanitizeValue(value, key = "") {
  if (typeof value === "string") return sanitizeString(value, key);
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, key));
  if (!value || typeof value !== "object") return value;
  const output = {};
  for (const [entryKey, entryValue] of Object.entries(value)) {
    if (entryValue === undefined) continue;
    output[entryKey] = sanitizeValue(entryValue, entryKey);
  }
  return output;
}

function sanitizeString(value, key = "") {
  if (isSensitiveKey(key)) return "[REDACTED]";
  let next = String(value)
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer [REDACTED]")
    .replace(/sk-[A-Za-z0-9._-]+/g, "[REDACTED]")
    .replace(/api[_-]?key\s*[:=]\s*[A-Za-z0-9._-]+/gi, "api_key=[REDACTED]");
  if (isPathKey(key) && looksLikePath(next)) next = basename(next);
  return next.slice(0, MAX_STRING_LENGTH);
}

function normalizeSeverity(value) {
  return value === "info" || value === "warn" || value === "error" ? value : "info";
}

function normalizeTraceStatus(value) {
  return VALID_TRACE_STATUSES.has(value) ? value : null;
}

function normalizeToolStatus(value) {
  return VALID_TOOL_STATUSES.has(value) ? value : null;
}

function isSensitiveKey(key = "") {
  return /(api[_-]?key|authorization|bearer|token|password|secret|credential)/i.test(key);
}

function isPathKey(key = "") {
  return /(path|file|dir)$/i.test(key) || /(path|file|dir)/i.test(key);
}

function basename(value) {
  return path.basename(String(value).replace(/\\/g, "/")) || String(value);
}

function looksLikePath(value) {
  const text = String(value);
  return /^[A-Za-z]:[\\/]/.test(text) || text.includes("\\") || /\/[^/]+\.[A-Za-z0-9]{1,12}$/.test(text);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
