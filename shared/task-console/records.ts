export interface ConsoleRun {
  id: string; sourceId: string; source: 'activity' | 'workflow' | 'company'; title: string; status: string;
  owner: string; startedAt: number | null; finishedAt: number | null; sessionPath: string | null;
  parentTaskId: string | null; summary: string; artifacts: string[]; tokens: number | null;
  cost: { state: 'unknown'; reason: string };
  budget?: { state: string; committedTokens: number; reservedTokens: number; committedUsd: number; reservedUsd: number; calls: number; blockedReason?: string | null; note: string };
}
const str = (v: unknown): string => typeof v === 'string' ? v : '';
const num = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null;
export function normalizeConsoleRun(raw: Record<string, unknown>, source: ConsoleRun['source'], owner = ''): ConsoleRun {
  const status = str(raw.lifecycleStatus || raw.status);
  const aliases: Record<string, string> = { done: 'succeeded', error: 'failed', aborted: 'cancelled' };
  const artifacts = Array.isArray(raw.artifacts) ? raw.artifacts : Array.isArray(raw.artifactRefs) ? raw.artifactRefs : [];
  return {
    id: `${source}:${str(raw.id)}`, sourceId: str(raw.id), source, title: str(raw.label || raw.summary || raw.id),
    status: aliases[status] || status || 'unknown', owner: str(raw.agentName || raw.agentId) || owner || '未知',
    startedAt: num(raw.startedAt), finishedAt: num(raw.finishedAt), sessionPath: str(source === 'workflow' ? raw.childSessionPath || raw.sessionPath : raw.sessionPath) || null,
    parentTaskId: str(raw.parentTaskId) || null, summary: str(raw.error || raw.summary),
    artifacts: artifacts.map(a => typeof a === 'string' ? a : str(a?.path || a?.uri || a?.url || a?.id)).filter(Boolean),
    ...(raw.runBudget && typeof raw.runBudget === 'object' ? { budget: raw.runBudget as ConsoleRun['budget'] } : {}),
    tokens: num(raw.tokens), cost: { state: 'unknown', reason: '尚无可核对的逐运行价格归因；未知不代表免费。' },
  };
}
