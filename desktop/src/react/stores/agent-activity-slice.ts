export interface AgentActivityEntry {
  id: string;
  kind: 'subagent' | 'workflow' | 'workflow_agent' | 'workflow_step' | 'heartbeat' | 'cron';
  status: 'running' | 'done' | 'failed' | 'aborted';
  lifecycleStatus?: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  sessionPath: string | null;
  agentId: string | null;
  agentName: string | null;
  summary: string | null;
  childSessionPath: string | null;
  threadId?: string | null;
  threadKind?: string | null;
  access?: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  parentTaskId?: string | null;
  label?: string | null;
  phaseLabel?: string | null;
  tokens?: number | null;
  stepKind?: 'parallel' | 'pipeline' | 'log' | null;
  reuseInstance?: string | null;
}

export interface AgentActivitySlice {
  agentActivitiesBySession: Record<string, AgentActivityEntry[] | Record<string, AgentActivityEntry> | unknown>;
  upsertAgentActivity: (entry: AgentActivityEntry) => void;
  clearAgentActivities: (sessionPath: string) => void;
}

function isAgentActivityEntry(value: unknown): value is AgentActivityEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<AgentActivityEntry>;
  return typeof entry.id === 'string' && entry.id.length > 0;
}

const normalizedObjectBuckets = new WeakMap<object, AgentActivityEntry[]>();

export function normalizeAgentActivityList(value: unknown): AgentActivityEntry[] {
  if (Array.isArray(value)) {
    return value.every(isAgentActivityEntry) ? value : value.filter(isAgentActivityEntry);
  }
  if (value && typeof value === 'object') {
    const cached = normalizedObjectBuckets.get(value);
    if (cached) return cached;
    const normalized = Object.values(value as Record<string, unknown>).filter(isAgentActivityEntry);
    normalizedObjectBuckets.set(value, normalized);
    return normalized;
  }
  return EMPTY;
}

export const createAgentActivitySlice = (
  set: (partial: Partial<AgentActivitySlice> | ((s: AgentActivitySlice) => Partial<AgentActivitySlice>)) => void,
): AgentActivitySlice => ({
  agentActivitiesBySession: {},
  upsertAgentActivity: (entry) => {
    const sessionPath = entry?.sessionPath;
    if (!sessionPath || !entry?.id) return;
    set((s) => {
      const list = normalizeAgentActivityList(s.agentActivitiesBySession[sessionPath]);
      const exists = list.some((item) => item.id === entry.id);
      const next = exists
        ? list.map((item) => (item.id === entry.id ? { ...item, ...entry } : item))
        : [...list, entry];
      return {
        agentActivitiesBySession: {
          ...s.agentActivitiesBySession,
          [sessionPath]: next,
        },
      };
    });
  },
  clearAgentActivities: (sessionPath) => {
    set((s) => {
      if (!s.agentActivitiesBySession[sessionPath]) return {};
      const next = { ...s.agentActivitiesBySession };
      delete next[sessionPath];
      return { agentActivitiesBySession: next };
    });
  },
});

const EMPTY: AgentActivityEntry[] = [];

export const selectAgentActivities =
  (sessionPath: string | null) =>
  (s: AgentActivitySlice): AgentActivityEntry[] =>
    sessionPath ? normalizeAgentActivityList(s.agentActivitiesBySession[sessionPath]) : EMPTY;
