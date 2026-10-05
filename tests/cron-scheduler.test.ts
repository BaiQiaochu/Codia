import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCronScheduler,
  DEFAULT_CRON_EXECUTION_TIMEOUT_MS,
} from "../lib/desk/cron-scheduler.js";

type TestJob = {
  id: string;
  label: string;
  enabled: boolean;
  nextRunAt: string | null;
};

type RunRecord = {
  id: string;
  run: Record<string, unknown>;
};

function createStore(job: TestJob) {
  const calls: { runs: RunRecord[]; marks: string[] } = {
    runs: [],
    marks: [],
  };

  return {
    calls,
    store: {
      listJobs() {
        return [job];
      },
      logRun(id: string, run: Record<string, unknown>) {
        calls.runs.push({ id, run });
      },
      markRun(id: string) {
        calls.marks.push(id);
      },
    },
  };
}

function dueJob(id: string, label = id): TestJob {
  return {
    id,
    label,
    enabled: true,
    nextRunAt: new Date(Date.now() - 1000).toISOString(),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("cron-scheduler", () => {
  it("uses a 20 minute execution timeout by default", () => {
    expect(DEFAULT_CRON_EXECUTION_TIMEOUT_MS).toBe(20 * 60 * 1000);
  });

  it("starts and stops without losing the interval timer binding", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");

    const { store } = createStore(dueJob("job_start"));
    const scheduler = createCronScheduler({
      cronStore: store,
      executeJob: async () => {},
    });

    scheduler.start();
    scheduler.start();
    await scheduler.stop();

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
  });

  it("records a successful run and emits the done event", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    const job = dueJob("job_1", "test job");
    const { store, calls } = createStore(job);
    const done: Array<{ id: string; result: Record<string, unknown> }> = [];
    const scheduler = createCronScheduler({
      cronStore: store,
      executeJob: async () => {},
      onJobDone: (j, result) => done.push({ id: j.id, result }),
    });

    await scheduler.checkJobs();

    expect(calls.runs).toHaveLength(1);
    expect(calls.runs[0].id).toBe("job_1");
    expect(calls.runs[0].run.status).toBe("success");
    expect(calls.marks).toEqual(["job_1"]);
    expect(done).toEqual([{ id: "job_1", result: { status: "success" } }]);
  });

  it("writes executor result details to run history and done events", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    const job = dueJob("job_direct", "notify job");
    const { store, calls } = createStore(job);
    const done: Array<{ id: string; result: Record<string, unknown> }> = [];
    const executionResult = {
      executorKind: "direct_action",
      action: "notify",
      delivery: { ok: true, deliveries: [{ channel: "desktop", status: "sent" }] },
    };
    const scheduler = createCronScheduler({
      cronStore: store,
      executeJob: async () => executionResult,
      onJobDone: (j, result) => done.push({ id: j.id, result }),
    });

    await scheduler.checkJobs();

    expect(calls.runs[0].run).toMatchObject({
      status: "success",
      executorKind: "direct_action",
      action: "notify",
      delivery: { ok: true, deliveries: [{ channel: "desktop", status: "sent" }] },
    });
    expect(done).toEqual([{ id: "job_direct", result: { status: "success", ...executionResult } }]);
  });

  it("records thrown errors and marks the job as failed", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    const job = dueJob("job_2", "failed job");
    const { store, calls } = createStore(job);
    const done: Array<{ id: string; result: Record<string, unknown> }> = [];
    const scheduler = createCronScheduler({
      cronStore: store,
      executeJob: async () => {
        throw new Error("boom");
      },
      onJobDone: (j, result) => done.push({ id: j.id, result }),
    });

    await scheduler.checkJobs();

    expect(calls.runs).toHaveLength(1);
    expect(calls.runs[0].id).toBe("job_2");
    expect(calls.runs[0].run.status).toBe("error");
    expect(calls.runs[0].run.error).toBe("boom");
    expect(calls.marks).toEqual(["job_2"]);
    expect(done).toEqual([{ id: "job_2", result: { status: "error", error: "boom" } }]);
  });

  it("records skipped jobs without advancing the next run", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    const job = dueJob("job_3", "skipped job");
    const { store, calls } = createStore(job);
    const done: Array<{ id: string; result: Record<string, unknown> }> = [];
    const scheduler = createCronScheduler({
      cronStore: store,
      executeJob: async () => {
        const err = new Error("agent is already running another cron job") as Error & { skipped?: boolean };
        err.skipped = true;
        throw err;
      },
      onJobDone: (j, result) => done.push({ id: j.id, result }),
    });

    await scheduler.checkJobs();

    expect(calls.runs).toHaveLength(1);
    expect(calls.runs[0].id).toBe("job_3");
    expect(calls.runs[0].run.status).toBe("skipped");
    expect(calls.marks).toEqual([]);
    expect(done).toEqual([{ id: "job_3", result: { status: "skipped" } }]);
  });

  it("aborts and records a timeout when execution exceeds the limit", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    const job = dueJob("job_timeout", "timeout job");
    const { store, calls } = createStore(job);
    const abortJob = vi.fn();
    const done: Array<{ id: string; result: Record<string, unknown> }> = [];
    const scheduler = createCronScheduler({
      cronStore: store,
      executeJob: () => new Promise(() => {}),
      abortJob,
      onJobDone: (j, result) => done.push({ id: j.id, result }),
      executionTimeoutMs: 100,
    });

    const check = scheduler.checkJobs();
    await vi.advanceTimersByTimeAsync(100);
    await check;

    expect(abortJob).toHaveBeenCalledWith("job_timeout");
    expect(calls.runs).toHaveLength(1);
    expect(calls.runs[0].run.status).toBe("error");
    expect(calls.runs[0].run.error).toBe("execution timeout (100ms)");
    expect(calls.marks).toEqual(["job_timeout"]);
    expect(done).toEqual([
      { id: "job_timeout", result: { status: "error", error: "execution timeout (100ms)" } },
    ]);
  });
});
