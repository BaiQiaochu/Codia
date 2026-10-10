// @ts-nocheck
const DEFAULT_APP_NAME = "CODIA";
const DEFAULT_MAX_DIAGNOSTICS = 100;
const DEFAULT_MAX_RECORDS = 200;

let generatedDiagnosticCounter = 0;
let generatedRecordCounter = 0;

export function createRuntimeDiagnosticsService(options = {}) {
  const appName = options.appName || DEFAULT_APP_NAME;
  const maxDiagnostics = Number.isFinite(options.maxDiagnostics) ? options.maxDiagnostics : DEFAULT_MAX_DIAGNOSTICS;
  const maxRecords = Number.isFinite(options.maxRecords) ? options.maxRecords : DEFAULT_MAX_RECORDS;
  const traceStore = options.traceStore || null;
  const diagnostics = new Map();
  const records = [];

  function recordDiagnostic(input = {}) {
    generatedDiagnosticCounter += 1;
    const id = input.id || `diag-${Date.now()}-${generatedDiagnosticCounter}`;
    const diagnostic = sanitizeDiagnostic({
      id,
      traceId: input.traceId,
      sessionPath: input.sessionPath,
      agentId: input.agentId,
      severity: normalizeSeverity(input.severity),
      category: normalizeCategory(input.category),
      userMessage: input.userMessage || "Runtime failure. Diagnostics were saved.",
      technicalMessage: input.technicalMessage || input.message || "",
      suggestion: input.suggestion,
      startedAt: input.startedAt,
      endedAt: input.endedAt,
      durationMs: Number.isFinite(input.durationMs) ? input.durationMs : undefined,
      model: input.model,
      errorClassification: input.errorClassification,
      tool: input.tool,
      sanitizedDetails: input.sanitizedDetails ?? input.details,
      createdAt: input.createdAt || new Date().toISOString(),
    });

    diagnostics.delete(id);
    diagnostics.set(id, diagnostic);
    while (diagnostics.size > maxDiagnostics) {
      const oldest = diagnostics.keys().next().value;
      diagnostics.delete(oldest);
    }
    return id;
  }

  function recordRuntimeRecord(input = {}) {
    generatedRecordCounter += 1;
    const record = sanitizeRecord({
      id: input.id || `runtime-record-${Date.now()}-${generatedRecordCounter}`,
      timestamp: input.timestamp || new Date().toISOString(),
      severity: normalizeSeverity(input.severity),
      category: normalizeCategory(input.category),
      title: input.title || "Runtime event",
      detail: input.detail,
      traceId: input.traceId,
      diagnosticId: input.diagnosticId,
      sessionPath: input.sessionPath,
      agentId: input.agentId,
      model: input.model,
      errorClassification: input.errorClassification,
      tool: input.tool,
      media: input.media,
    });
    const existing = records.findIndex((item) => item.id === record.id);
    if (existing >= 0) records.splice(existing, 1);
    records.unshift(record);
    records.splice(maxRecords);
    return record.id;
  }

  function snapshot() {
    let traces = [];
    try {
      traces = traceStore?.snapshot?.()?.traces || [];
    } catch {
      traces = [];
    }
    return {
      ok: true,
      app: appName,
      generatedAt: new Date().toISOString(),
      diagnostics: Array.from(diagnostics.values()).reverse(),
      records: [...records],
      traces,
    };
  }

  return {
    recordDiagnostic,
    recordRuntimeRecord,
    snapshot,
    list: snapshot,
  };
}

function normalizeSeverity(value) {
  return value === "info" || value === "warn" || value === "error" ? value : "error";
}

function normalizeCategory(value) {
  return [
    "model",
    "tool",
    "media",
    "plugin",
    "pwa",
    "network",
    "runtime",
  ].includes(value) ? value : "runtime";
}

function sanitizeDiagnostic(input) {
  return {
    ...input,
    userMessage: sanitizeString(input.userMessage),
    technicalMessage: input.technicalMessage ? sanitizeString(input.technicalMessage) : undefined,
    suggestion: input.suggestion ? sanitizeString(input.suggestion) : undefined,
    sanitizedDetails: sanitizeValue(input.sanitizedDetails),
  };
}

function sanitizeRecord(input) {
  return {
    ...input,
    title: sanitizeString(input.title),
    detail: input.detail ? sanitizeString(input.detail) : undefined,
  };
}

function isSensitiveKey(key = "") {
  return /(api[_-]?key|authorization|bearer|token|password|secret|credential)/i.test(key);
}

function basename(value) {
  const match = String(value).match(/[^\\/]+$/);
  return match?.[0] || value;
}

function looksLikePath(value) {
  return /^[A-Za-z]:[\\/]/.test(value) || value.includes("\\") || /\/[^/]+\.[A-Za-z0-9]{1,8}$/.test(value);
}

function sanitizeString(value, key = "") {
  if (isSensitiveKey(key)) return "[REDACTED]";
  let next = String(value)
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer [REDACTED]")
    .replace(/sk-[A-Za-z0-9._-]+/g, "[REDACTED]");
  if (/(path|file|dir)/i.test(key) && looksLikePath(next)) next = basename(next);
  return next;
}

function sanitizeValue(value, key = "") {
  if (typeof value === "string") return sanitizeString(value, key);
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item));
  if (!value || typeof value !== "object") return value;
  const output = {};
  for (const [entryKey, entryValue] of Object.entries(value)) {
    output[entryKey] = sanitizeValue(entryValue, entryKey);
  }
  return output;
}
