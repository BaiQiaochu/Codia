import { debugLog, createModuleLogger } from "../debug-log.ts";

const log = createModuleLogger("cron");

export const DEFAULT_CRON_EXECUTION_TIMEOUT_MS = 20 * 60 * 1000;

type CronJob = {
  id: string;
  label?: string;
  enabled?: boolean;
  nextRunAt?: string | null;
  [key: string]: unknown;
};

type CronRunDetails = Record<string, unknown>;

type CronStoreLike = {
  listJobs(): CronJob[];
  logRun(jobId: string, run: CronRunDetails): void;
  markRun(jobId: string, result: { success: boolean }): void;
};

type CronExecutionResult = CronRunDetails | null | undefined | void;

type CronError = Error & {
  skipped?: boolean;
};

type CronSchedulerOptions = {
  cronStore: CronStoreLike;
  executeJob: (job: CronJob) => Promise<CronExecutionResult> | CronExecutionResult;
  abortJob?: (jobId: string) => void;
  onJobDone?: (job: CronJob, result: CronRunDetails) => void;
  executionTimeoutMs?: number;
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
}: CronSchedulerOptions) {
  const CHECK_INTERVAL = 60_000;
  const effectiveExecutionTimeoutMs = normalizeExecutionTimeoutMs(executionTimeoutMs);
  let intervalTimer: ReturnType<typeof setInterval> | null = null;
  let _checking = false;
  let _checkPromise: Promise<void> | null = null;

  async function checkJobs() {
    if (_checking) return;
    _checking = true;
    const p = _doCheck();
    _checkPromise = p;
    await p;
  }

  async function runWithTimeout(job: CronJob): Promise<CronExecutionResult> {
    let executionTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve(executeJob(job)),
        new Promise<never>((_, reject) => {
          executionTimer = setTimeout(() => {
            abortJob?.(job.id);
            reject(new Error(`execution timeout (${formatTimeoutMs(effectiveExecutionTimeoutMs)})`));
          }, effectiveExecutionTimeoutMs);
        }),
      ]);
    } finally {
      if (executionTimer !== undefined) clearTimeout(executionTimer);
    }
  }

  async function executeTrackedJob(job: CronJob, { throwOnError = false } = {}) {
    log.log(`run job: ${job.label} (${job.id})`);
    debugLog()?.log("cron", `run ${job.id} (${job.label})`);
    const startedAt = new Date().toISOString();

    try {
      const executionResult = await runWithTimeout(job);
      const finishedAt = new Date().toISOString();
      const details = objectDetails(executionResult);

      cronStore.logRun(job.id, { status: "success", startedAt, finishedAt, ...details });
      cronStore.markRun(job.id, { success: true });
      debugLog()?.log("cron", `job success ${job.id}`);
      onJobDone?.(job, { status: "success", ...details });
      return { status: "success", ...details };
    } catch (err) {
      const finishedAt = new Date().toISOString();
      const cronError = err as CronError;
      const message = cronError?.message || String(err);

      if (cronError?.skipped) {
        cronStore.logRun(job.id, { status: "skipped", startedAt, finishedAt });
        debugLog()?.log("cron", `job skipped ${job.id}: ${message}`);
        onJobDone?.(job, { status: "skipped" });
        return { status: "skipped", error: message };
      }

      cronStore.logRun(job.id, { status: "error", startedAt, finishedAt, error: message });
      cronStore.markRun(job.id, { success: false });
      log.error(`job failed ${job.id}: ${message}`);
      debugLog()?.error("cron", `job failed ${job.id}: ${message}`);
      onJobDone?.(job, { status: "error", error: message });
      if (throwOnError) throw err;
      return { status: "error", error: message };
    }
  }

  async function _doCheck() {
    try {
      const now = Date.now();
      const jobs = cronStore.listJobs();

      for (const job of jobs) {
        if (!job.enabled) continue;
        if (!job.nextRunAt) continue;

        const nextRunTime = new Date(job.nextRunAt).getTime();
        if (now < nextRunTime) continue;

        await executeTrackedJob(job);
      }
    } catch (err) {
      log.error(`checkJobs error: ${err?.message || err}`);
      debugLog()?.error("cron", `checkJobs error: ${err?.message || err}`);
    } finally {
      _checking = false;
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
    if (_checkPromise) {
      await _checkPromise.catch(() => {});
      _checkPromise = null;
    }
  }

  async function runNow(job: CronJob) {
    return executeTrackedJob(job, { throwOnError: true });
  }

  return { start, stop, checkJobs, runNow };
}
