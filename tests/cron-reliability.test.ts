import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CronStore } from "../lib/desk/cron-store.ts";
import { createCronScheduler } from "../lib/desk/cron-scheduler.ts";

type StoredJob = { id: string; nextRunAt: string; enabled: boolean; lastScheduledStatus?: string; [key: string]: unknown };
// The legacy JS-style store has incomplete inferred return types.
type TestStore = Omit<CronStore, "addJob" | "getJob"> & {
  addJob(input: Parameters<CronStore["addJob"]>[0]): StoredJob;
  getJob(id: string): StoredJob;
  _jobsPath: string;
  _runsDir: string;
};
const dirs: string[] = [];
function store() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cron-reliable-"));
  dirs.push(dir);
  return new CronStore(path.join(dir, "jobs.json"), path.join(dir, "runs")) as unknown as TestStore;
}
afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("reliable cron scheduling", () => {
  it("persists and validates per-task zones and misfire policy", () => {
    const s = store();
    const job = s.addJob({ type: "cron", schedule: "0 9 * * *", prompt: "read", timezone: "Asia/Shanghai", misfirePolicy: "skip" });
    expect(s.listJobs()[0]).toMatchObject({ timezone: "Asia/Shanghai", misfirePolicy: "skip" });
    expect(() => s.updateJob(job.id, { timezone: "Invalid/Zone" })).toThrow(/timezone/);
    expect(() => s.updateJob(job.id, { misfirePolicy: "replay-all" })).toThrow(/misfirePolicy/);
    expect(s._calcNextRun("cron", "0 9 * * *", "2026-01-01T00:00:00Z", "Asia/Shanghai")).toBe("2026-01-01T01:00:00.000Z");
  });

  it("skips nonexistent DST minutes and treats repeated minutes as separate UTC periods", () => {
    const s = store();
    expect(s._calcNextRun("cron", "30 2 * * *", "2026-03-08T05:00:00Z", "America/New_York")).toBe("2026-03-09T06:30:00.000Z");
    expect(s._calcNextRun("cron", "30 1 * * *", "2026-11-01T04:00:00Z", "America/New_York")).toBe("2026-11-01T05:30:00.000Z");
    expect(s._calcNextRun("cron", "30 1 * * *", "2026-11-01T05:30:00Z", "America/New_York")).toBe("2026-11-01T06:30:00.000Z");
  });

  it("launches independent due jobs without waiting for a long job, and caps concurrency", async () => {
    const s = store();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-16T00:00:00Z"));
    const jobs = Array.from({ length: 3 }, () => s.addJob({ type: "every", schedule: 60_000, prompt: "read" }));
    vi.advanceTimersByTime(60_000);
    let release!: () => void;
    const execute = vi.fn((job) => job.id === jobs[0].id ? new Promise<void>(r => { release = r; }) : Promise.resolve());
    const scheduler = createCronScheduler({ cronStore: s, executeJob: execute, maxConcurrentJobs: 2 });
    const first = scheduler.checkJobs();
    await vi.advanceTimersByTimeAsync(0);
    expect(execute.mock.calls.map(([j]) => j.id)).toEqual([jobs[0].id, jobs[1].id]);
    await scheduler.checkJobs();
    expect(execute).toHaveBeenCalledTimes(3);
    release();
    await first;
    await scheduler.stop();
  });

  it("skips stale periods or catches up once, and persists claims across restart", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-16T00:00:00Z"));
    const s = store();
    const skip = s.addJob({ type: "every", schedule: 60_000, prompt: "read", misfirePolicy: "skip" });
    const catchup = s.addJob({ type: "every", schedule: 60_000, prompt: "read", misfirePolicy: "catch-up-once" });
    vi.advanceTimersByTime(600_000);
    const execute = vi.fn(async () => {});
    const scheduler = createCronScheduler({ cronStore: s, executeJob: execute });
    await scheduler.checkJobs();
    await scheduler.checkJobs();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(s.getRunHistory(skip.id)[0]).toMatchObject({ status: "skipped", reason: "misfire" });
    expect(s.getRunHistory(catchup.id)[0].dedupeKey).toContain(catchup.id);
    const restarted = new CronStore(s._jobsPath, s._runsDir) as unknown as TestStore;
    const next = createCronScheduler({ cronStore: restarted, executeJob: execute });
    await next.checkJobs();
    expect(execute).toHaveBeenCalledTimes(1);
    await scheduler.stop();
    await next.stop();
  });

  it("does not replay a claimed period after crash before completion", () => {
    vi.useFakeTimers();
    const s = store();
    const job = s.addJob({ type: "every", schedule: 60_000, prompt: "write" });
    vi.advanceTimersByTime(60_000);
    expect(s.claimRun(job.id, job.nextRunAt)).toBe(true);
    const restarted = new CronStore(s._jobsPath, s._runsDir) as unknown as TestStore;
    expect(restarted.claimRun(job.id, job.nextRunAt)).toBe(false);
    expect(restarted.getJob(job.id).lastScheduledStatus).toBe("claimed");
  });

  it("retains a timed-out executor slot until execution actually settles", async () => {
    vi.useFakeTimers();
    const s = store();
    const a = s.addJob({ type: "every", schedule: 60_000, prompt: "read" });
    const b = s.addJob({ type: "every", schedule: 60_000, prompt: "read" });
    let release!: () => void;
    const execute = vi.fn(() => new Promise<void>(r => { release = r; }));
    const scheduler = createCronScheduler({ cronStore: s, executeJob: execute, executionTimeoutMs: 10, maxConcurrentJobs: 1 });
    const run = scheduler.runNow(a);
    const failed = expect(run).rejects.toThrow(/timeout/);
    await vi.advanceTimersByTimeAsync(10);
    await failed;
    await expect(scheduler.runNow(b)).rejects.toThrow(/concurrency/);
    release();
    await vi.advanceTimersByTimeAsync(0);
    await scheduler.stop();
  });
  it("does not duplicate an in-flight period under reentrant scans or manual dispatch", async () => {
    vi.useFakeTimers();
    const s = store();
    const job = s.addJob({ type: "every", schedule: 60_000, prompt: "read" });
    vi.advanceTimersByTime(60_000);
    let release!: () => void;
    const execute = vi.fn(() => new Promise<void>(r => { release = r; }));
    const scheduler = createCronScheduler({ cronStore: s, executeJob: execute });
    const check = scheduler.checkJobs();
    await scheduler.checkJobs();
    await expect(scheduler.runNow(job)).rejects.toThrow(/concurrency/);
    expect(execute).toHaveBeenCalledTimes(1);
    release();
    await check;
    await scheduler.stop();
  });

  it("applies failure backoff to future periods without replaying failed side effects", async () => {
    vi.useFakeTimers();
    const s = store();
    const job = s.addJob({ type: "every", schedule: 60_000, prompt: "write" });
    const execute = vi.fn(async () => { throw new Error("unknown external outcome"); });
    const scheduler = createCronScheduler({ cronStore: s, executeJob: execute });
    vi.advanceTimersByTime(60_000);
    await scheduler.checkJobs();
    await scheduler.checkJobs();
    expect(execute).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    await scheduler.checkJobs();
    const updated = s.getJob(job.id);
    expect(Date.parse(updated.nextRunAt) - Date.now()).toBe(300_000);
    expect(updated.lastScheduledStatus).toBe("error");
    await scheduler.stop();
  });

  it("does not turn a successful execution into failure when completion notification throws", async () => {
    const s = store();
    const job = s.addJob({ type: "every", schedule: 60_000, prompt: "read" });
    const scheduler = createCronScheduler({ cronStore: s, executeJob: async () => {}, onJobDone: () => { throw new Error("notification offline"); } });
    expect(await scheduler.runNow(job)).toEqual({ status: "success" });
    expect(s.getRunHistory(job.id).map(run => run.status)).toEqual(["success"]);
    await scheduler.stop();
  });

});
