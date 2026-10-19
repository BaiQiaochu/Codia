// @ts-nocheck
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCronScheduler } from '../lib/desk/cron-scheduler.ts';
import { CronStore } from '../lib/desk/cron-store.ts';
import { createAutomationRunService, readAutomationHealth } from '../lib/desk/automation-health.ts';

const dirs: string[] = [];
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automation-health-'));
  dirs.push(dir);
  const store = new CronStore(path.join(dir, 'jobs.json'), path.join(dir, 'runs'));
  const job = store.addJob({ type: 'every', schedule: 60_000, prompt: 'synthetic only', actorAgentId: 'agent-a', timezone: 'Asia/Shanghai' });
  return { dir, store, job };
}
afterEach(() => { vi.useRealTimers(); dirs.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true })); });

describe('automation health and durable manual execution', () => {
  it('distinguishes success, timeout, missed, one-off failure and orphaned claim; never infers success from disabled', () => {
    const { store, job } = fixture();
    store.logRun(job.id, { status: 'success', sessionPath: '/synthetic/result.jsonl' });
    expect(readAutomationHealth(store, job.id).status).toBe('success');
    store.logRun(job.id, { status: 'error', error: 'execution timeout (20min)' });
    expect(readAutomationHealth(store, job.id)).toMatchObject({ status: 'timeout', requiresReview: true });
    store.logRun(job.id, { status: 'skipped', reason: 'misfire' });
    expect(readAutomationHealth(store, job.id).status).toBe('missed');
    const once = store.addJob({ type: 'at', schedule: new Date(Date.now() + 60_000).toISOString(), prompt: 'synthetic only' });
    store.logRun(once.id, { status: 'error', error: 'synthetic failure' });
    store.markRun(once.id, { success: false });
    expect(readAutomationHealth(store, once.id)).toMatchObject({ status: 'one_time_failed', disabledAfterAttempt: true });
    store.claimRun(job.id, job.nextRunAt);
    const orphan = readAutomationHealth(store, job.id);
    expect(orphan).toMatchObject({ status: 'unknown', requiresReview: true, latest: { scheduledAt: job.nextRunAt } });
    expect(orphan.latest).not.toHaveProperty('startedAt');
    expect(orphan.history.find(row => row.status === 'claimed')).not.toHaveProperty('startedAt');
    expect(readAutomationHealth(store, job.id, { running: true }).status).toBe('running');
  });

  it('claims before dispatch, deduplicates rapid clicks and replayed requests after completion/restart, preserves timezone', async () => {
    const { dir, store, job } = fixture();
    let finish!: (value: unknown) => void;
    const dispatch = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    const service = createAutomationRunService();
    const first = service.start(store, job.id, 'request-one', () => dispatch());
    const duplicate = service.start(store, job.id, 'request-one', () => dispatch());
    expect(first.receipt.status).toBe('claimed');
    expect(duplicate.duplicate).toBe(true);
    await Promise.resolve();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(() => service.start(store, job.id, 'request-two', () => dispatch())).toThrow(/running/);
    finish({ status: 'success', sessionPath: '/synthetic/result.jsonl' });
    await service.settled();
    const restart = new CronStore(path.join(dir, 'jobs.json'), path.join(dir, 'runs'));
    expect(createAutomationRunService().start(restart, job.id, 'request-one', () => dispatch()).receipt.status).toBe('success');
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(restart.getJob(job.id).timezone).toBe('Asia/Shanghai');
  });

  it('does not replay a restart claim or unknown external outcome without explicit review', async () => {
    const { dir, store, job } = fixture();
    store.claimManualRun(job.id, 'request-before-crash');
    const restart = new CronStore(path.join(dir, 'jobs.json'), path.join(dir, 'runs'));
    const dispatch = vi.fn(async () => { throw new Error('network disconnected after external write'); });
    const service = createAutomationRunService();
    expect(service.start(restart, job.id, 'request-before-crash', dispatch).duplicate).toBe(true);
    expect(() => service.start(restart, job.id, 'new-request', dispatch)).toThrow(/review/);
    expect(dispatch).not.toHaveBeenCalled();
    const health = readAutomationHealth(restart, job.id);
    service.start(restart, job.id, 'new-request', dispatch, { reviewedRunKey: health.reviewKey });
    await service.settled();
    expect(readAutomationHealth(restart, job.id)).toMatchObject({ status: 'error', requiresReview: true });
    expect(() => service.start(restart, job.id, 'third-request', dispatch)).toThrow(/review/);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('surfaces corrupt/unreadable jobs, history and receipt files rather than empty data or redispatch', () => {
    const { dir, store, job } = fixture();
    fs.mkdirSync(path.join(dir, 'runs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'runs', `${job.id}.jsonl`), '{bad json}\n');
    expect(() => store.getRunHistory(job.id)).toThrow(/history/);
    fs.writeFileSync(path.join(dir, 'jobs.json'), '{bad json}');
    expect(() => store.listJobs()).toThrow(/read|JSON|jobs/i);
    expect(() => store.claimManualRun(job.id, 'unsafe-retry')).toThrow();
  });
  it('retains the original session on failure and distinguishes timeout while an executor still holds its slot', async () => {
    const { store, job } = fixture();
    const failed = createCronScheduler({ cronStore: store, executeJob: async () => { throw Object.assign(new Error('synthetic failure'), { runDetails: { sessionPath: '/synthetic/failed.jsonl', activityId: 'synthetic-failed' } }); } });
    await expect(failed.runNow(job, { requestId: 'failed-request' })).rejects.toThrow('synthetic failure');
    expect(store.getRunHistory(job.id)[0]).toMatchObject({ requestId: 'failed-request', activityId: 'synthetic-failed', sessionPath: '/synthetic/failed.jsonl' });
    await failed.stop();
    vi.useFakeTimers();
    let release!: () => void;
    const slow = createCronScheduler({ cronStore: store, executeJob: () => new Promise<void>(resolve => { release = resolve; }), executionTimeoutMs: 10 });
    const run = slow.runNow(job, { requestId: 'timeout-request' });
    const expected = expect(run).rejects.toThrow('timeout');
    await vi.advanceTimersByTimeAsync(10);
    await expected;
    expect(readAutomationHealth(store, job.id, { running: slow.isRunning(job.id) })).toMatchObject({ status: 'timeout', running: true, requiresReview: true });
    release();
    await vi.advanceTimersByTimeAsync(0);
    await slow.stop();
  });

  it('does not dispatch if claiming fails and retains unknown status if outcome persistence fails', async () => {
    const { store, job } = fixture();
    const dispatch = vi.fn(async () => ({ status: 'success' }));
    const service = createAutomationRunService();
    const save = vi.spyOn(store, '_save').mockImplementationOnce(() => { throw new Error('disk full'); });
    expect(() => service.start(store, job.id, 'first-request', dispatch)).toThrow('disk full');
    expect(dispatch).not.toHaveBeenCalled();
    save.mockRestore();
    vi.spyOn(store, 'finishManualRun').mockImplementationOnce(() => { throw new Error('disk full after execution'); });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    service.start(store, job.id, 'second-request', dispatch);
    await service.settled();
    expect(readAutomationHealth(store, job.id)).toMatchObject({ status: 'unknown', requiresReview: true });
    expect(() => service.start(store, job.id, 'third-request', dispatch)).toThrow(/review/);
    expect(dispatch).toHaveBeenCalledTimes(1);
    log.mockRestore();
  });

});
