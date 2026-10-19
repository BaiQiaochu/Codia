import { debugLog, createModuleLogger } from "../debug-log.ts";

const log = createModuleLogger("cron");

export const DEFAULT_CRON_EXECUTION_TIMEOUT_MS = 20 * 60 * 1000;

type CronJob = {
  id: string;
  label?: string;
  enabled?: boolean;
  nextRunAt?: string | null;
  misfirePolicy?: "skip" | "catch-up-once";
  [key: string]: unknown;
};

type CronRunDetails = Record<string, unknown>;

type CronStoreLike = {
  listJobs(): CronJob[];
  logRun(jobId: string, run: CronRunDetails): void;
  markRun(jobId: string, result: { success: boolean; scheduledAt?: string; skipped?: boolean }): void;
  claimRun?(jobId: string, scheduledAt: string, options?: { skipped?: boolean; now?: string }): boolean;
};

type CronExecutionResult = CronRunDetails | null | undefined | void;

type CronError = Error & {
  skipped?: boolean;
  runDetails?: CronRunDetails;
};

type CronSchedulerOptions = {
  cronStore: CronStoreLike;
  executeJob: (job: CronJob) => Promise<CronExecutionResult> | CronExecutionResult;
  abortJob?: (jobId: string) => void;
  onJobDone?: (job: CronJob, result: CronRunDetails) => void;
  executionTimeoutMs?: number;
  maxConcurrentJobs?: number;
  misfireGraceMs?: number;
};

function normalizeExecutionTimeoutMs(value?: number): number {
  if (value === undefined) return DEFAULT_CRON_EXECUTION_TIMEOUT_MS;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("executionTimeoutMs must be a positive finite number");
  }
  return value;
}

function formatTimeoutMs(ms: number): string {
  if (ms % 60_000 === 0) return `${ms / 60_000}min`;
  if (ms % 1000 === 0) return `${ms / 1000}s`;
  return `${ms}ms`;
}

function objectDetails(value: CronExecutionResult): CronRunDetails {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function createCronScheduler({
  cronStore,
  executeJob,
  abortJob,
  onJobDone,
  executionTimeoutMs,
  maxConcurrentJobs = 4,
  misfireGraceMs = 60_000,
}: CronSchedulerOptions) {
  const CHECK_INTERVAL = 60_000;
  const effectiveExecutionTimeoutMs = normalizeExecutionTimeoutMs(executionTimeoutMs);
  let intervalTimer: ReturnType<typeof setInterval> | null = null;
  if (!Number.isInteger(maxConcurrentJobs) || maxConcurrentJobs < 1) throw new Error("maxConcurrentJobs must be a positive integer");
  if (!Number.isFinite(misfireGraceMs) || misfireGraceMs < 0) throw new Error("misfireGraceMs must be nonnegative");
  const running = new Set<string>();
  const pending = new Set<Promise<unknown>>();
  // Fallback for injected stores without durable claims. Real CronStore persists claims.
  const claimedPeriods = new Map<string, string>();

  async function checkJobs() {
    const dispatched: Promise<unknown>[] = [];
    try {
      const now = Date.now();
      const jobs = [...cronStore.listJobs()].sort((a, b) => Date.parse(a.nextRunAt || "") - Date.parse(b.nextRunAt || ""));
      for (const job of jobs) {
        if (!job.enabled || !job.nextRunAt || running.has(job.id)) continue;
        const due = Date.parse(job.nextRunAt);
        if (!Number.isFinite(due) || due > now || claimedPeriods.get(job.id) === job.nextRunAt) continue;
        if (running.size >= maxConcurrentJobs) break;
        const skipped = job.misfirePolicy === "skip" && now - due > misfireGraceMs;
        if (cronStore.claimRun && !cronStore.claimRun(job.id, job.nextRunAt, { skipped, now: new Date(now).toISOString() })) continue;
        claimedPeriods.set(job.id, job.nextRunAt);
        if (skipped) {
          cronStore.logRun(job.id, { status: "skipped", reason: "misfire", scheduledAt: job.nextRunAt, finishedAt: new Date(now).toISOString() });
          continue;
        }
        // Launch every available slot before awaiting any executor.
        dispatched.push(track(job, { scheduledAt: job.nextRunAt }));
      }
    } catch (err) {
      log.error(`checkJobs error: ${err instanceof Error ? err.message : err}`);
    }
    await Promise.allSettled(dispatched);
  }

  function track(job: CronJob, options: { throwOnError?: boolean; scheduledAt?: string; requestId?: string } = {}) {
    running.add(job.id);
    const promise = executeTrackedJob(job, options);
    pending.add(promise);
    void promise.then(() => pending.delete(promise), () => pending.delete(promise));
    return promise;
  }

  async function runWithTimeout(job: CronJob): Promise<CronExecutionResult> {
    let executionTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        // Retain the slot until the actual executor settles, even after timeout.
        // An uncooperative executor must not silently exceed the concurrency ceiling.
        Promise.resolve().then(() => executeJob(job)).finally(() => running.delete(job.id)),
        new Promise<never>((_, reject) => {
          executionTimer = setTimeout(() => {
            try { abortJob?.(job.id); } catch { /* Abort failures must not suppress timeout. */ }
            reject(new Error(`execution timeout (${formatTimeoutMs(effectiveExecutionTimeoutMs)})`));
          }, effectiveExecutionTimeoutMs);
        }),
      ]);
    } finally {
      if (executionTimer !== undefined) clearTimeout(executionTimer);
    }
  }

  function notifyDone(job: CronJob, result: CronRunDetails) {
    try { onJobDone?.(job, result); }
    catch (err) { log.error(`completion notification failed: ${err instanceof Error ? err.message : err}`); }
  }

  async function executeTrackedJob(job: CronJob, { throwOnError = false, scheduledAt, requestId }: { throwOnError?: boolean; scheduledAt?: string; requestId?: string } = {}) {
    log.log(`run job: ${job.label} (${job.id})`);
    debugLog()?.log("cron", `run ${job.id} (${job.label})`);
    const startedAt = new Date().toISOString();
    const periodDetails = scheduledAt ? { scheduledAt, dedupeKey: `${job.id}:${scheduledAt}`, trigger: "scheduled" } : { ...(requestId ? { requestId } : {}), trigger: "manual" };

    try {
      const executionResult = await runWithTimeout(job);
      const finishedAt = new Date().toISOString();
      const details = objectDetails(executionResult);

      cronStore.logRun(job.id, { ...details, ...periodDetails, status: "success", startedAt, finishedAt });
      cronStore.markRun(job.id, { success: true, ...(scheduledAt ? { scheduledAt } : {}) });
      debugLog()?.log("cron", `job success ${job.id}`);
      notifyDone(job, { ...details, status: "success" });
      return { ...details, status: "success" };
    } catch (err) {
      const finishedAt = new Date().toISOString();
      const cronError = err as CronError;
      const message = cronError?.message || String(err);

      if (cronError?.skipped) {
        cronStore.logRun(job.id, { ...periodDetails, status: "skipped", startedAt, finishedAt, error: message });
        debugLog()?.log("cron", `job skipped ${job.id}: ${message}`);
        if (scheduledAt && cronStore.claimRun) cronStore.markRun(job.id, { success: false, skipped: true, scheduledAt });
        notifyDone(job, { status: "skipped" });
        return { status: "skipped", error: message };
      }

      cronStore.logRun(job.id, { ...cronError?.runDetails, ...periodDetails, status: "error", startedAt, finishedAt, error: message });
      cronStore.markRun(job.id, { success: false, ...(scheduledAt ? { scheduledAt } : {}) });
      log.error(`job failed ${job.id}: ${message}`);
      debugLog()?.error("cron", `job failed ${job.id}: ${message}`);
      notifyDone(job, { status: "error", error: message });
      if (throwOnError) throw err;
      return { status: "error", error: message };
    }
  }

  function start() {
    if (intervalTimer) return;
    intervalTimer = setInterval(() => checkJobs(), CHECK_INTERVAL);
    log.log("scheduler started (interval 60s)");
  }

  async function stop() {
    if (intervalTimer) {
      clearInterval(intervalTimer);
      intervalTimer = null;
    }
    await Promise.allSettled([...pending]);
  }

  async function runNow(job: CronJob, { requestId }: { requestId?: string } = {}) {
    if (running.has(job.id) || running.size >= maxConcurrentJobs) {
      throw Object.assign(new Error("cron concurrency limit reached"), { skipped: true });
    }
    return track(job, { throwOnError: true, requestId });
  }

  return { start, stop, checkJobs, runNow, isRunning: (jobId: string) => running.has(jobId) };
}
