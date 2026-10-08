export type RuntimeTimelineEventType =
  | 'queued'
  | 'model_route'
  | 'thinking'
  | 'generating'
  | 'tool_call'
  | 'media_generation'
  | 'completed'
  | 'failed';

export type RuntimeTimelineEventStatus = 'pending' | 'running' | 'success' | 'error';
export type RuntimeTimelineMediaKind = 'image' | 'audio' | 'music' | 'video';

export interface RuntimeTimelineEvent {
  id: string;
  turnTraceId: string;
  sessionPath: string;
  type: RuntimeTimelineEventType;
  label: string;
  status: RuntimeTimelineEventStatus;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  model?: { provider?: string; id?: string; name?: string };
  tool?: { name?: string; category?: string };
  media?: { kind?: RuntimeTimelineMediaKind; provider?: string; model?: string };
  details?: Record<string, unknown>;
  diagnosticId?: string;
}

export interface RuntimeTimelineTrace {
  turnTraceId: string;
  sessionPath: string;
  messageId?: string;
  startedAt: string;
  endedAt?: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  events: RuntimeTimelineEvent[];
}

export type RuntimeDiagnosticSeverity = 'info' | 'warn' | 'error';
export type RuntimeDiagnosticCategory =
  | 'model'
  | 'tool'
  | 'media'
  | 'plugin'
  | 'pwa'
  | 'network'
  | 'runtime';

export interface RuntimeDiagnostic {
  id: string;
  traceId?: string;
  sessionPath?: string;
  agentId?: string;
  severity: RuntimeDiagnosticSeverity;
  category: RuntimeDiagnosticCategory;
  userMessage: string;
  technicalMessage?: string;
  suggestion?: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  model?: { provider?: string; id?: string; name?: string };
  tool?: { name?: string; category?: string };
  sanitizedDetails?: unknown;
  createdAt: string;
}

export interface RuntimeRecord {
  id: string;
  timestamp: string;
  severity: RuntimeDiagnosticSeverity;
  category: RuntimeDiagnosticCategory;
  title: string;
  detail?: string;
  traceId?: string;
  diagnosticId?: string;
  sessionPath?: string;
  agentId?: string;
  model?: { provider?: string; id?: string; name?: string };
  tool?: { name?: string; category?: string };
  media?: { kind?: RuntimeTimelineMediaKind; provider?: string; model?: string };
}

export interface RuntimeDiagnosticExport {
  schemaVersion: 1;
  app: 'Codia';
  exportedAt: string;
  diagnostic: RuntimeDiagnostic;
  timeline: RuntimeTimelineEvent[];
  environment?: Record<string, unknown>;
}

export interface RuntimeTimelineSlice {
  runtimeTimelineByTrace: Record<string, RuntimeTimelineTrace>;
  runtimeTimelineTraceIdsBySession: Record<string, string[]>;
  runtimeDiagnosticsById: Record<string, RuntimeDiagnostic>;
  runtimeDiagnosticIds: string[];
  runtimeRecords: RuntimeRecord[];
  upsertRuntimeTimelineEvent: (event: RuntimeTimelineEvent) => void;
  bindRuntimeTimelineMessage: (turnTraceId: string, messageId: string) => void;
  clearRuntimeTimelineForSession: (sessionPath: string) => void;
  recordRuntimeDiagnostic: (diagnostic: Partial<RuntimeDiagnostic> & {
    severity: RuntimeDiagnosticSeverity;
    category: RuntimeDiagnosticCategory;
    userMessage: string;
  }) => string;
  recordRuntimeRecord: (record: Partial<RuntimeRecord> & {
    severity: RuntimeDiagnosticSeverity;
    category: RuntimeDiagnosticCategory;
    title: string;
  }) => void;
  buildRuntimeDiagnosticExport: (diagnosticId: string, environment?: Record<string, unknown>) => RuntimeDiagnosticExport | null;
}

const MAX_TRACES_PER_SESSION = 80;
const MAX_RUNTIME_DIAGNOSTICS = 100;
const MAX_RUNTIME_RECORDS = 100;
let generatedDiagnosticCounter = 0;
let generatedRecordCounter = 0;

function compareEventTime(a: RuntimeTimelineEvent, b: RuntimeTimelineEvent): number {
  return Date.parse(a.startedAt) - Date.parse(b.startedAt);
}

function resolveTraceStatus(
  current: RuntimeTimelineTrace | undefined,
  event: RuntimeTimelineEvent,
): RuntimeTimelineTrace['status'] {
  if (event.type === 'failed' || event.status === 'error') return 'failed';
  if (event.type === 'completed') return current?.status === 'failed' ? 'failed' : 'completed';
  return current?.status === 'failed' || current?.status === 'completed' ? current.status : 'running';
}

function nowIso(): string {
  return new Date(Date.now()).toISOString();
}

function basename(value: string): string {
  const match = value.match(/[^\\/]+$/);
  return match?.[0] || value;
}

function isSensitiveKey(key?: string): boolean {
  return !!key && /(api[_-]?key|authorization|bearer|token|password|secret|credential)/i.test(key);
}

function looksLikePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.includes('\\') || /\/[^/]+\.[A-Za-z0-9]{1,8}$/.test(value);
}

function sanitizeString(value: string, key?: string): string {
  if (isSensitiveKey(key)) return '[REDACTED]';
  let next = value
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer [REDACTED]')
    .replace(/sk-[A-Za-z0-9._-]+/g, '[REDACTED]');
  if (key && /(path|file|dir)/i.test(key) && looksLikePath(next)) next = basename(next);
  return next;
}

function sanitizeValue(value: unknown, key?: string): unknown {
  if (typeof value === 'string') return sanitizeString(value, key);
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item));
  if (!value || typeof value !== 'object') return value;
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [entryKey, entryValue] of Object.entries(source)) {
    out[entryKey] = sanitizeValue(entryValue, entryKey);
  }
  return out;
}

function sanitizeDiagnostic(input: RuntimeDiagnostic): RuntimeDiagnostic {
  return {
    ...input,
    userMessage: sanitizeString(input.userMessage),
    technicalMessage: input.technicalMessage ? sanitizeString(input.technicalMessage) : undefined,
    suggestion: input.suggestion ? sanitizeString(input.suggestion) : undefined,
    sanitizedDetails: sanitizeValue(input.sanitizedDetails),
  };
}

function sanitizeTimelineEvent(event: RuntimeTimelineEvent): RuntimeTimelineEvent {
  return {
    ...event,
    details: event.details ? sanitizeValue(event.details) as Record<string, unknown> : undefined,
  };
}

export const createRuntimeTimelineSlice = (
  set: (partial: Partial<RuntimeTimelineSlice> | ((s: RuntimeTimelineSlice) => Partial<RuntimeTimelineSlice>)) => void,
  get?: () => RuntimeTimelineSlice,
): RuntimeTimelineSlice => ({
  runtimeTimelineByTrace: {},
  runtimeTimelineTraceIdsBySession: {},
  runtimeDiagnosticsById: {},
  runtimeDiagnosticIds: [],
  runtimeRecords: [],

  upsertRuntimeTimelineEvent: (event) => set((s) => {
    const existing = s.runtimeTimelineByTrace[event.turnTraceId];
    const events = existing ? [...existing.events] : [];
    const existingIndex = events.findIndex(item => item.id === event.id);
    if (existingIndex >= 0) {
      events[existingIndex] = { ...events[existingIndex], ...event, startedAt: events[existingIndex].startedAt };
    } else {
      events.push(event);
    }
    events.sort(compareEventTime);

    const trace: RuntimeTimelineTrace = {
      turnTraceId: event.turnTraceId,
      sessionPath: event.sessionPath,
      messageId: existing?.messageId,
      startedAt: existing?.startedAt || event.startedAt,
      endedAt: event.type === 'completed' || event.type === 'failed' ? (event.endedAt || event.startedAt) : existing?.endedAt,
      status: resolveTraceStatus(existing, event),
      events,
    };

    const traceIds = s.runtimeTimelineTraceIdsBySession[event.sessionPath] || [];
    const nextTraceIds = traceIds.includes(event.turnTraceId)
      ? traceIds
      : [...traceIds, event.turnTraceId].slice(-MAX_TRACES_PER_SESSION);
    const nextByTrace = { ...s.runtimeTimelineByTrace, [event.turnTraceId]: trace };
    const evicted = traceIds.length >= MAX_TRACES_PER_SESSION && !traceIds.includes(event.turnTraceId)
      ? traceIds[0]
      : null;
    if (evicted) delete nextByTrace[evicted];

    return {
      runtimeTimelineByTrace: nextByTrace,
      runtimeTimelineTraceIdsBySession: {
        ...s.runtimeTimelineTraceIdsBySession,
        [event.sessionPath]: nextTraceIds,
      },
    };
  }),

  bindRuntimeTimelineMessage: (turnTraceId, messageId) => set((s) => {
    const trace = s.runtimeTimelineByTrace[turnTraceId];
    if (!trace || trace.messageId === messageId) return {};
    return {
      runtimeTimelineByTrace: {
        ...s.runtimeTimelineByTrace,
        [turnTraceId]: { ...trace, messageId },
      },
    };
  }),

  clearRuntimeTimelineForSession: (sessionPath) => set((s) => {
    const traceIds = s.runtimeTimelineTraceIdsBySession[sessionPath] || [];
    if (traceIds.length === 0) return {};
    const nextByTrace = { ...s.runtimeTimelineByTrace };
    for (const traceId of traceIds) delete nextByTrace[traceId];
    const nextBySession = { ...s.runtimeTimelineTraceIdsBySession };
    delete nextBySession[sessionPath];
    return {
      runtimeTimelineByTrace: nextByTrace,
      runtimeTimelineTraceIdsBySession: nextBySession,
    };
  }),

  recordRuntimeDiagnostic: (input) => {
    generatedDiagnosticCounter += 1;
    const id = input.id || `diag-${Date.now()}-${generatedDiagnosticCounter}`;
    const createdAt = input.createdAt || nowIso();
    const diagnostic = sanitizeDiagnostic({
      id,
      traceId: input.traceId,
      sessionPath: input.sessionPath,
      agentId: input.agentId,
      severity: input.severity,
      category: input.category,
      userMessage: input.userMessage,
      technicalMessage: input.technicalMessage,
      suggestion: input.suggestion,
      startedAt: input.startedAt,
      endedAt: input.endedAt,
      durationMs: input.durationMs,
      model: input.model,
      tool: input.tool,
      sanitizedDetails: input.sanitizedDetails,
      createdAt,
    });

    set((s) => {
      const nextIds = [id, ...s.runtimeDiagnosticIds.filter((existing) => existing !== id)]
        .slice(0, MAX_RUNTIME_DIAGNOSTICS);
      const nextById = { ...s.runtimeDiagnosticsById, [id]: diagnostic };
      for (const existing of Object.keys(nextById)) {
        if (!nextIds.includes(existing)) delete nextById[existing];
      }
      return {
        runtimeDiagnosticsById: nextById,
        runtimeDiagnosticIds: nextIds,
      };
    });

    return id;
  },

  recordRuntimeRecord: (input) => {
    generatedRecordCounter += 1;
    const record: RuntimeRecord = {
      id: input.id || `runtime-record-${Date.now()}-${generatedRecordCounter}`,
      timestamp: input.timestamp || nowIso(),
      severity: input.severity,
      category: input.category,
      title: sanitizeString(input.title),
      detail: input.detail ? sanitizeString(input.detail) : undefined,
      traceId: input.traceId,
      diagnosticId: input.diagnosticId,
      sessionPath: input.sessionPath,
      agentId: input.agentId,
      model: input.model,
      tool: input.tool,
      media: input.media,
    };
    set((s) => ({
      runtimeRecords: [record, ...s.runtimeRecords.filter((item) => item.id !== record.id)]
        .slice(0, MAX_RUNTIME_RECORDS),
    }));
  },

  buildRuntimeDiagnosticExport: (diagnosticId, environment = {}) => {
    const state = get?.();
    if (!state) return null;
    const diagnostic = state.runtimeDiagnosticsById[diagnosticId];
    if (!diagnostic) return null;
    const timeline = diagnostic.traceId
      ? (state.runtimeTimelineByTrace[diagnostic.traceId]?.events || []).map(sanitizeTimelineEvent)
      : [];
    return {
      schemaVersion: 1,
      app: 'Codia',
      exportedAt: nowIso(),
      diagnostic: sanitizeDiagnostic(diagnostic),
      timeline,
      environment: sanitizeValue(environment) as Record<string, unknown>,
    };
  },
});

export function selectRuntimeTimelineTrace(
  state: RuntimeTimelineSlice,
  turnTraceId?: string | null,
): RuntimeTimelineTrace | null {
  if (!turnTraceId) return null;
  return state.runtimeTimelineByTrace[turnTraceId] || null;
}

export function selectRuntimeTimelineForSession(
  state: RuntimeTimelineSlice,
  sessionPath: string,
): RuntimeTimelineTrace[] {
  return (state.runtimeTimelineTraceIdsBySession[sessionPath] || [])
    .map(traceId => state.runtimeTimelineByTrace[traceId])
    .filter((trace): trace is RuntimeTimelineTrace => Boolean(trace));
}

