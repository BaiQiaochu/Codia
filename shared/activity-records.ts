export type ActivityTimeProvenance = 'recorded' | 'inferred' | 'unknown';
export interface ActivityArtifact {
  id?: string; fileId?: string; resourceId?: string; path?: string; uri?: string; url?: string;
  sessionPath?: string; displayName?: string; version?: Record<string, unknown> | string | number | null;
}
export interface ActivityRun {
  id: string; source: 'activity' | 'workflow' | 'company'; title: string; status: string;
  agentId: string | null; startedAt: number | null; finishedAt: number | null; sessionPath: string | null;
  timeProvenance: { startedAt: ActivityTimeProvenance; finishedAt: ActivityTimeProvenance };
  summary: string; artifactDetails: ActivityArtifact[];
  environment: { cwd: string | null; provenance: 'recorded' | 'session_current' | 'unknown'; platform?: string; appVersion?: string; channel?: string; projectId?: string; dependencyVersions?: Record<string, string> };
}
const str = (v: unknown): string => typeof v === 'string' ? v : '';
const num = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null;
const date = (v: unknown): number | null => num(v) ?? (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null);
const object = (v: unknown): Record<string, any> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {};
export function normalizeActivityRun(raw: Record<string, unknown>, source: ActivityRun['source'], owner = ''): ActivityRun {
  const rawStatus = str(raw.lifecycleStatus || raw.status);
  const aliases: Record<string, string> = { done: 'succeeded', completed: 'succeeded', error: 'failed', aborted: 'cancelled', in_progress: 'running', assigned: 'queued', reported: 'awaiting_review', awaiting_approval: 'waiting_approval' };
  const artifacts = Array.isArray(raw.artifacts) ? raw.artifacts : Array.isArray(raw.artifactRefs) ? raw.artifactRefs : [];
  const artifactDetails: ActivityArtifact[] = artifacts.map(a => typeof a === 'string' ? { path: a } : object(a));
  const startedAt = date(raw.startedAt); const finishedAt = date(raw.finishedAt);
  const provenance = object(raw.timeProvenance);
  const environment = object(raw.environment); const executionContext = object(raw.executionContext);
  const cwd = str(environment.cwd || executionContext.cwd || raw.cwd) || null;
  return {
    id: `${source}:${str(raw.id)}`, source, title: str(raw.label || raw.summary || raw.id) || owner,
    status: aliases[rawStatus] || rawStatus || 'unknown', agentId: str(raw.agentId) || null,
    startedAt, finishedAt, timeProvenance: {
      startedAt: startedAt === null ? 'unknown' : provenance.startedAt === 'inferred' ? 'inferred' : 'recorded',
      finishedAt: finishedAt === null ? 'unknown' : provenance.finishedAt === 'inferred' ? 'inferred' : 'recorded',
    },
    environment: { cwd, provenance: cwd ? environment.provenance === 'session_current' ? 'session_current' : 'recorded' : 'unknown',
      ...Object.fromEntries(['platform', 'appVersion', 'channel', 'projectId'].filter(key => typeof environment[key] === 'string').map(key => [key, environment[key]])),
      ...(environment.dependencyVersions && typeof environment.dependencyVersions === 'object' ? { dependencyVersions: Object.fromEntries(Object.entries(environment.dependencyVersions).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) } : {}),
    },
    sessionPath: str(source === 'workflow' ? raw.childSessionPath || raw.sessionPath : raw.sessionPath) || null,
    summary: str(raw.error || raw.summary), artifactDetails,
  };
}
