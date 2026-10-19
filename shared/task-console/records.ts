export type ConsoleTimeProvenance = 'recorded' | 'inferred' | 'unknown';
export interface ConsoleArtifact {
  id?: string; fileId?: string; resourceId?: string; path?: string; uri?: string; url?: string;
  sessionPath?: string; displayName?: string; version?: Record<string, unknown> | string | number | null;
}
export interface ConsoleRun {
  id: string; sourceId: string; source: 'activity' | 'workflow' | 'company'; title: string; status: string; rawStatus: string;
  owner: string; agentId: string | null; startedAt: number | null; finishedAt: number | null; sessionPath: string | null;
  timeProvenance: { startedAt: ConsoleTimeProvenance; finishedAt: ConsoleTimeProvenance };
  parentTaskId: string | null; summary: string; artifacts: string[]; artifactDetails: ConsoleArtifact[]; tokens: number | null;
  companyId?: string; dueAt?: string | null; deliveryRevision?: number;
  acceptance?: { criteria: string[]; results: { criterion: string; passed: boolean | null; evidence: string }[]; failure: string; humanReview?: Record<string, unknown> | null };
  environment: { cwd: string | null; provenance: 'recorded' | 'session_current' | 'unknown'; platform?: string; appVersion?: string; channel?: string; projectId?: string; dependencyVersions?: Record<string, string> };
  cost: { state: 'unknown'; reason: string };
  budget?: { state: string; committedTokens: number; reservedTokens: number; committedUsd: number; reservedUsd: number; calls: number; blockedReason?: string | null; note: string };
}
const str = (v: unknown): string => typeof v === 'string' ? v : '';
const num = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null;
const date = (v: unknown): number | null => num(v) ?? (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null);
const object = (v: unknown): Record<string, any> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {};
export function normalizeConsoleRun(raw: Record<string, unknown>, source: ConsoleRun['source'], owner = ''): ConsoleRun {
  const rawStatus = str(raw.lifecycleStatus || raw.status);
  const aliases: Record<string, string> = { done: 'succeeded', completed: 'succeeded', error: 'failed', aborted: 'cancelled', in_progress: 'running', assigned: 'queued', reported: 'awaiting_review', awaiting_approval: 'waiting_approval' };
  const artifacts = Array.isArray(raw.artifacts) ? raw.artifacts : Array.isArray(raw.artifactRefs) ? raw.artifactRefs : [];
  const artifactDetails: ConsoleArtifact[] = artifacts.map(a => typeof a === 'string' ? { path: a } : object(a));
  const startedAt = date(raw.startedAt); const finishedAt = date(raw.finishedAt);
  const provenance = object(raw.timeProvenance);
  const environment = object(raw.environment); const executionContext = object(raw.executionContext);
  const cwd = str(environment.cwd || executionContext.cwd || raw.cwd) || null;
  return {
    id: `${source}:${str(raw.id)}`, sourceId: str(raw.id), source, title: str(raw.label || raw.summary || raw.id),
    rawStatus, status: aliases[rawStatus] || rawStatus || 'unknown', owner: str(raw.agentName || raw.agentId) || owner || '未知', agentId: str(raw.agentId) || null,
    startedAt, finishedAt, timeProvenance: {
      startedAt: startedAt === null ? 'unknown' : provenance.startedAt === 'inferred' ? 'inferred' : 'recorded',
      finishedAt: finishedAt === null ? 'unknown' : provenance.finishedAt === 'inferred' ? 'inferred' : 'recorded',
    },
    environment: { cwd, provenance: cwd ? environment.provenance === 'session_current' ? 'session_current' : 'recorded' : 'unknown',
      ...Object.fromEntries(['platform', 'appVersion', 'channel', 'projectId'].filter(key => typeof environment[key] === 'string').map(key => [key, environment[key]])),
      ...(environment.dependencyVersions && typeof environment.dependencyVersions === 'object' ? { dependencyVersions: Object.fromEntries(Object.entries(environment.dependencyVersions).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) } : {}),
    },
    sessionPath: str(source === 'workflow' ? raw.childSessionPath || raw.sessionPath : raw.sessionPath) || null,
    parentTaskId: str(raw.parentTaskId) || null, summary: str(raw.error || raw.summary),
    artifactDetails, artifacts: artifactDetails.map(a => str(a.path || a.uri || a.url || a.fileId || a.resourceId || a.id)).filter(Boolean),
    ...(source === 'company' ? { companyId: str(raw.companyId), dueAt: str(raw.dueAt) || null, deliveryRevision: num(raw.deliveryRevision) ?? 0,
      acceptance: { criteria: Array.isArray(raw.acceptanceCriteria) ? raw.acceptanceCriteria.filter(c => typeof c === 'string') : [],
        results: Array.isArray(raw.acceptanceResults) ? raw.acceptanceResults.map(c => ({ criterion: str(c?.criterion), passed: typeof c?.passed === 'boolean' ? c.passed : null, evidence: str(c?.evidence) })) : [],
        failure: str(raw.acceptanceFailure), humanReview: raw.humanReview && typeof raw.humanReview === 'object' ? raw.humanReview as Record<string, unknown> : null } } : {}),
    ...(raw.runBudget && typeof raw.runBudget === 'object' ? { budget: raw.runBudget as ConsoleRun['budget'] } : {}),
    tokens: num(raw.tokens), cost: { state: 'unknown', reason: '尚无可核对的逐运行价格归因；未知不代表免费。' },
  };
}
