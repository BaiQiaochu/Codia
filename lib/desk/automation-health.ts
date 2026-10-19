export interface AutomationRunRecord {
  status: string;
  requestId?: string;
  startedAt?: string;
  finishedAt?: string;
  timestamp?: string;
  scheduledAt?: string;
  reason?: string;
  error?: string;
  sessionPath?: string | null;
  activityId?: string;
  trigger?: string;
}
interface HealthJob {
  id: string;
  enabled?: boolean;
  type?: string;
  lastScheduledStatus?: string;
  lastScheduledAt?: string;
  nextRunAt?: string | null;
  consecutiveErrors?: number;
  [key: string]: unknown;
}
interface HealthStore {
  listJobs(): HealthJob[];
  getRunHistory(id: string, limit?: number): AutomationRunRecord[];
  getManualRun(id: string, requestId?: string): AutomationRunRecord | null;
  claimManualRun(id: string, requestId: string): { receipt: AutomationRunRecord; duplicate: boolean };
  finishManualRun(id: string, requestId: string, result: AutomationRunRecord): void;
}

export function readAutomationHealth(store: HealthStore, id: string, { running = false } = {}) {
  const job = store.listJobs().find(row => row.id === id);
  if (!job) throw new Error('cron job not found');
  const history = store.getRunHistory(id, 20);
  const manual = store.getManualRun(id);
  const rows = [...history];
  if (manual && !rows.some(row => row.requestId === manual.requestId)) rows.push(manual);
  const unresolvedSchedule = job.lastScheduledStatus === 'claimed'
    && !history.some(row => row.scheduledAt === job.lastScheduledAt);
  if (unresolvedSchedule) rows.push({ status: 'claimed', scheduledAt: job.lastScheduledAt, trigger: 'scheduled' });
  rows.sort((a, b) => Date.parse(a.finishedAt || a.timestamp || a.startedAt || '') - Date.parse(b.finishedAt || b.timestamp || b.startedAt || ''));
  // A durable orphaned claim remains unknown even if the previous run finished later than its period.
  const latest = unresolvedSchedule ? [...rows].reverse().find(row => row.status === 'claimed' && row.scheduledAt === job.lastScheduledAt) : rows.at(-1);
  const timedOut = latest?.status === 'error' && /timeout/i.test(latest.error || '');
  const status = running && !timedOut ? 'running'
    : latest?.status === 'claimed' ? 'unknown'
      : latest?.status === 'error' && /timeout/i.test(latest.error || '') ? 'timeout'
        : latest?.status === 'error' && job.type === 'at' && !job.enabled ? 'one_time_failed'
          : latest?.status === 'skipped' && latest.reason === 'misfire' ? 'missed'
            : latest?.status || (job.lastScheduledStatus === 'skipped' ? 'missed' : 'never');
  const requiresReview = ['unknown', 'error', 'timeout', 'one_time_failed'].includes(status);
  const reviewKey = latest ? latest.requestId || latest.scheduledAt || `${latest.timestamp || latest.finishedAt || latest.startedAt}:${latest.status}` : null;
  return {
    job, status, latest: latest || null, history: rows.reverse().slice(0, 20),
    requiresReview, reviewKey, running,
    consecutiveErrors: job.consecutiveErrors || 0,
    backoffUntil: job.enabled && (job.consecutiveErrors || 0) > 0 ? job.nextRunAt || null : null,
    disabledAfterAttempt: job.type === 'at' && !job.enabled && !!latest,
    historyLimit: 20,
  };
}

/** One server process, same scope as CronStore. Duplicate HTTP requests only read receipts. */
export function createAutomationRunService() {
  const running = new WeakMap<HealthStore, Map<string, Promise<void>>>();
  const pending = new Set<Promise<void>>();
  const activeFor = (store: HealthStore) => {
    let active = running.get(store);
    if (!active) { active = new Map(); running.set(store, active); }
    return active;
  };
  return {
    isRunning: (store: HealthStore, id: string) => activeFor(store).has(id),
    settled: () => Promise.all([...pending]),
    start(store: HealthStore, id: string, requestId: string, dispatch: () => Promise<AutomationRunRecord>, options: { reviewedRunKey?: string; running?: boolean } = {}) {
      const existing = store.getManualRun(id, requestId);
      if (existing) return { receipt: existing, duplicate: true };
      const active = activeFor(store);
      if (active.has(id) || options.running) throw new Error('cron job already running');
      const health = readAutomationHealth(store, id);
      if (health.requiresReview && options.reviewedRunKey !== health.reviewKey) throw new Error('review previous run and external effects before a new manual run');
      const claim = store.claimManualRun(id, requestId);
      if (claim.duplicate) return claim;
      const execution = Promise.resolve().then(dispatch).then(
        result => store.finishManualRun(id, requestId, result || { status: 'success' }),
        error => store.finishManualRun(id, requestId, { ...error?.runDetails, status: error?.skipped ? 'skipped' : 'error', error: error instanceof Error ? error.message : String(error) }),
      ).catch(error => {
        // Failed persistence leaves the durable claim unresolved. It must never become an implicit retry.
        console.error('[automation] unable to persist manual outcome:', error);
      }).finally(() => { active.delete(id); pending.delete(execution); });
      active.set(id, execution);
      pending.add(execution);
      return claim;
    },
  };
}
