import { codiaFetch, CodiaFetchError } from './api';

export type MemoryStatus = 'candidate' | 'active' | 'conflict' | 'superseded' | 'expired' | 'deleted';
export interface MemorySourceRef {
  kind: string;
  sessionId?: string;
  messageId?: string;
  runId?: string;
  revision?: string | number;
  author?: string;
  evidenceHash?: string;
}
export interface MemoryItem {
  id: number;
  fact: string;
  tags?: string[];
  time?: string | null;
  created_at?: string;
  updated_at: string;
  source?: string | null;
  session_id?: string | null;
  status: MemoryStatus;
  revision?: number;
  sourceRefs?: MemorySourceRef[];
  scope?: 'global' | 'project';
  projectId?: string | null;
  expiresAt?: string | null;
  lastVerifiedAt?: string | null;
  reviewStatus?: string;
}
export interface ExperienceEnvironment {
  projectId?: string | null;
  channel?: string | null;
  platform?: string | null;
  appVersion?: string | null;
  dependencyVersions?: Record<string, string>;
}
export type ExperienceState = 'candidate' | 'validated' | 'enabled' | 'withdrawn';
export interface ExperienceEvidence {
  evidenceOrigin?: 'recorded_run' | 'external_manual';
  id: string;
  eventId: string;
  runId: string;
  experienceRevision: number;
  contentRevision?: number;
  outcome: 'success' | 'failure' | 'unknown';
  reviewerId: string;
  evidenceRef: string;
  summary: string;
  environment: ExperienceEnvironment;
  verifiedAt: string;
}
export interface ExperienceItem {
  id: string;
  revision: number;
  state: ExperienceState;
  contentRevision?: number;
  category: string;
  content: string;
  taskType: string;
  goal: string;
  preconditions: string[];
  actions: string[];
  verificationMethod: string;
  risks: string[];
  rollback: string;
  sourceRefs: { type: string; id: string; revision?: string | number; author?: string; excerpt?: string }[];
  parentMemoryIds: string[];
  applicability: ExperienceEnvironment & { scope: 'project' | 'global' };
  createdAt: string;
  updatedAt: string;
  lastVerifiedAt: string | null;
  withdrawalReason: string | null;
  stats: Record<'retrieved' | 'injected' | 'attempted' | 'verifiedSuccess' | 'verifiedFailure' | 'unknown', number>;
  evidence: ExperienceEvidence[];
}
export interface ExtractionJob {
  key: string;
  status: string;
  sessionId?: string;
  attempts?: number;
  error?: string | null;
  nextRetryAt?: string | null;
}
export class MemoryApiError extends Error {
  constructor(message: string, public status: number, public payload: Record<string, unknown>) {
    super(message);
    this.name = 'MemoryApiError';
  }
}
export async function memoryRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  try {
    const response = await codiaFetch(path, options);
    const body = await response.json() as Record<string, unknown>;
    if (!response.ok) throw new MemoryApiError(String(body.error || '请求失败'), response.status, body);
    return body as T;
  } catch (error) {
    if (error instanceof CodiaFetchError) throw new MemoryApiError(error.message, error.status, error.payload || {});
    throw error;
  }
}
export function memoryPath(agentId: string, suffix = '') {
  return `/api/memories${suffix}?agentId=${encodeURIComponent(agentId)}`;
}
export function memoryVersion(item: MemoryItem) {
  return item.revision === undefined ? { expectedUpdatedAt: item.updated_at } : { expectedRevision: item.revision };
}

export interface MemoryProject { id: string; label: string }
export interface MemoryFilters { q: string; projectId: string; source: string; status: string; from: string; to: string }
export interface MemoryPageMeta {
  total: number;
  pendingTotal: number;
  limit: number;
  offset: number;
  projects: MemoryProject[];
  sources: string[];
}
export interface MemoryListResponse extends Partial<MemoryPageMeta> {
  memories?: MemoryItem[];
  entries?: ExperienceItem[];
  jobs?: ExtractionJob[];
  enabled?: boolean;
}
export interface RecordedMemoryRun {
  runId: string;
  sessionId?: string | null;
  status: string;
  title?: string;
  summary?: string;
  artifacts?: { path?: string; uri?: string; url?: string; fileId?: string; displayName?: string }[];
  timeProvenance?: { startedAt: 'recorded' | 'inferred' | 'unknown'; finishedAt: 'recorded' | 'inferred' | 'unknown' };
  projectId?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  evidenceRef: string;
  environment: ExperienceEnvironment;
  exitCode?: number | null;
  environmentProvenance: 'recorded' | 'session_current' | 'unknown';
  environmentDiagnostics: string[];
  evidenceOrigin: 'recorded_run';
}
export interface MemoryRunPage extends Partial<MemoryPageMeta> { runs: RecordedMemoryRun[]; limitations?: string[] }
export interface MemoryBatchResult {
  id: number;
  ok: boolean;
  memory?: MemoryItem;
  error?: string;
  code?: string;
  current?: MemoryItem;
}
export function memoryListPath(agentId: string, suffix: string, query: Partial<MemoryFilters> & { limit?: number; offset?: number; reviewOnly?: boolean } = {}) {
  const params = new URLSearchParams({ agentId, limit: String(query.limit ?? 25), offset: String(query.offset ?? 0) });
  for (const [key, value] of Object.entries(query)) if (value !== '' && value !== undefined && value !== false) params.set(key, String(value));
  return `/api/memories${suffix}?${params}`;
}
