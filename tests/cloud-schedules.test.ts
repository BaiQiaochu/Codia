import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CloudWorkspaceStore, CloudWorkspaceError, type CloudRow } from '../lib/cloud-workspace/store.ts';
import type { CreateCloudSchedule } from '../lib/cloud-workspace/repository.ts';
import { randomUUID } from 'node:crypto';
import { CloudWorkspaceService } from '../lib/cloud-workspace/service.ts';
import { CloudWorkspaceWorker } from '../lib/cloud-workspace/worker.ts';
import { LocalObjectStore } from '../lib/cloud-workspace/object-store.ts';
import { MAX_SCHEDULE_INTERVAL_MS, MAX_SCHEDULE_TIMESTAMP, scheduleDispatchRejection } from '../lib/cloud-workspace/schedules.ts';

const actor = { userId: 'schedule-alice', studioId: 'schedule-studio' };
const strangers = [{ ...actor, userId: 'schedule-bob' }, { ...actor, studioId: 'other-studio' }];
let directory: string, filename: string, store: CloudWorkspaceStore, workspace: CloudRow, file: CloudRow, version: CloudRow;
const hash = 'a'.repeat(64);
function input(overrides: Partial<CreateCloudSchedule> = {}): CreateCloudSchedule {
  return { name: 'Daily task', inputVersion: version.id, operation: 'agent-task', requestKey: 'schedule-create-01', firstRunAt: 1000, intervalMs: 60_000, ...overrides };
}
function reopen() { store.close(); store = new CloudWorkspaceStore(filename); }
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codia-schedules-')); filename = path.join(directory, 'workspace.db');
  store = new CloudWorkspaceStore(filename); workspace = store.createWorkspace(actor, 'Schedules');
  const staged = store.stageVersion(actor, workspace.id, 'task.json', 2, hash); const finalized = store.finalizeVersion(actor, staged.version.id, null);
  file = finalized.file; version = finalized.version;
});
afterEach(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });

describe('SQLite durable cloud schedules and cancellation', () => {
  it('adds scheduling to an existing v2 SQLite database without altering stored work', () => {
    const run = store.createRun(actor, workspace.id, version.id, 'legacy-existing-run');
    const before = { files: store.listFiles(actor, workspace.id), runs: store.listRuns(actor, workspace.id), events: store.events(actor, workspace.id) };
    // Remove only the empty new table to reproduce the previous runtime schema.
    store.db.exec('DROP TABLE cw_schedules'); reopen();
    expect({ files: store.listFiles(actor, workspace.id), runs: store.listRuns(actor, workspace.id), events: store.events(actor, workspace.id) }).toEqual(before);
    expect(store.run(actor, run.id).run.status).toBe('queued');
    expect(store.createSchedule(actor, workspace.id, input()).input_version).toBe(version.id);
  });
  it('defaults to paused and persists across restart, pinning immutable input', () => {
    const schedule = store.createSchedule(actor, workspace.id, input());
    expect(schedule).toMatchObject({ state: 'paused', revision: 1, next_run_at: 1000, interval_ms: 60000, input_version: version.id, last_run_id: null });
    expect(schedule.creation_spec).toBeUndefined(); expect(store.dispatchDueSchedules(1000)).toBe(0);
    const staged = store.stageVersion(actor, workspace.id, file.name, 3, 'b'.repeat(64), file.id, version.id);
    store.finalizeVersion(actor, staged.version.id, version.id); reopen();
    expect(store.schedule(actor, schedule.id)).toEqual(schedule);
    expect(store.setScheduleEnabled(actor, schedule.id, 1, true)).toMatchObject({ state: 'enabled', revision: 2 });
    expect(store.dispatchDueSchedules(1000)).toBe(1);
    expect(store.listRuns(actor, workspace.id)[0].input_version).toBe(version.id);
  });
  it('compares original normalized creation intent after dispatch and pause', () => {
    const spec = input({ name: '  Daily task ', enabled: true }); const first = store.createSchedule(actor, workspace.id, spec);
    store.dispatchDueSchedules(121000); const advanced = store.schedule(actor, first.id);
    const paused = store.setScheduleEnabled(actor, first.id, advanced.revision, false);
    expect(store.createSchedule(actor, workspace.id, input({ enabled: true }))).toEqual(paused);
    for (const changed of [{ name: 'changed' }, { operation: 'agent-summary' as const }, { firstRunAt: 1001 }, { intervalMs: null }, { enabled: false }]) {
      expect(() => store.createSchedule(actor, workspace.id, { ...spec, ...changed })).toThrow('idempotency_conflict');
    }
    expect(store.listSchedules(actor, workspace.id)).toHaveLength(1);
    expect(store.events(actor, workspace.id).events.filter(e => e.kind === 'schedule.created')).toHaveLength(1);
  });
  it('uses pause/resume CAS, rejects stale updates, and resumes without catch-up bursts', () => {
    const schedule = store.createSchedule(actor, workspace.id, input({ enabled: true }));
    expect(store.setScheduleEnabled(actor, schedule.id, 1, true).revision).toBe(1);
    expect(store.setScheduleEnabled(actor, schedule.id, 1, false).revision).toBe(2);
    expect(() => store.setScheduleEnabled(actor, schedule.id, 1, true)).toThrow('schedule_conflict');
    expect(store.dispatchDueSchedules(9_000_000)).toBe(0);
    store.setScheduleEnabled(actor, schedule.id, 2, true);
    expect(store.dispatchDueSchedules(9_000_000)).toBe(1);
    expect(store.schedule(actor, schedule.id)).toMatchObject({ next_run_at: 9_001_000, revision: 4 });
    expect(store.dispatchDueSchedules(9_000_000)).toBe(0);
    expect(store.events(actor, workspace.id).events.map(e => e.kind)).toContain('schedule.paused');
  });
  it('creates one stable request per occurrence across independent connections and restart', () => {
    const schedule = store.createSchedule(actor, workspace.id, input({ enabled: true }));
    const second = new CloudWorkspaceStore(filename);
    try { expect(store.dispatchDueSchedules(181000)).toBe(1); expect(second.dispatchDueSchedules(181000)).toBe(0); } finally { second.close(); }
    reopen(); expect(store.dispatchDueSchedules(181000)).toBe(0);
    expect(store.listRuns(actor, workspace.id)).toHaveLength(1);
    const run = store.db.prepare('SELECT * FROM cw_runs').get(); expect(run.request_key).toBe(`schedule_${schedule.id}_1000`);
    expect(store.schedule(actor, schedule.id)).toMatchObject({ next_run_at: 241000, last_run_id: run.id, revision: 2 });
    expect(() => store.createRun(actor, workspace.id, version.id, `schedule_${schedule.id}_241000`)).toThrow('reserved_request_key');
  });
  it('suppresses queued/running overlap, advances skipped occurrences, and resumes after cancellation', () => {
    const schedule = store.createSchedule(actor, workspace.id, input({ enabled: true }));
    expect(store.dispatchDueSchedules(1000)).toBe(1);
    expect(store.dispatchDueSchedules(61000)).toBe(0);
    const running = store.claim(30000, 121000)!; expect(running.status).toBe('running');
    expect(store.dispatchDueSchedules(181000)).toBe(0);
    expect(store.schedule(actor, schedule.id).next_run_at).toBe(241000);
    const cancelled = store.cancelRun(actor, running.id); expect(cancelled).toMatchObject({ status: 'failed', error: 'cancelled' });
    expect(store.dispatchDueSchedules(241000)).toBe(1);
    expect(store.listRuns(actor, workspace.id)).toHaveLength(2);
    const skipped = store.events(actor, workspace.id).events.filter(e => e.kind === 'schedule.skipped');
    expect(skipped).toHaveLength(2); expect(skipped[1].payload).toMatchObject({ reason: 'overlap', dueAt: 121000, nextRunAt: 241000 });
  });
  it('completes one-shot schedules and cannot accidentally restart them', () => {
    const schedule = store.createSchedule(actor, workspace.id, input({ enabled: true, intervalMs: null }));
    expect(store.dispatchDueSchedules(999)).toBe(0); expect(store.dispatchDueSchedules(1000)).toBe(1);
    expect(store.schedule(actor, schedule.id)).toMatchObject({ state: 'completed', revision: 2, next_run_at: 1000 });
    expect(store.dispatchDueSchedules(1_000_000)).toBe(0);
    expect(() => store.setScheduleEnabled(actor, schedule.id, 2, true)).toThrow('schedule_completed');
    expect(store.setScheduleEnabled(actor, schedule.id, 2, false).state).toBe('completed');
    expect(store.createSchedule(actor, workspace.id, input({ enabled: true, intervalMs: null })).id).toBe(schedule.id);
  });
  it('pauses legacy oversized due schedules once and still dispatches and executes other owners work', async () => {
    const failed=[];
    for(const [operation,size,error] of [['agent-summary',131073,'agent_input_too_large'],['document-summary',2097153,'document_input_too_large']] as const) {
      const staged=store.stageVersion(actor,workspace.id,`${operation}.txt`,size,hash);
      const pinned=store.finalizeVersion(actor,staged.version.id,null).version;
      const spec=input({inputVersion:pinned.id,operation,requestKey:randomUUID(),enabled:true});
      const scheduleId=randomUUID();
      // Persist the shape admitted before input-size admission existed, then reopen.
      store.db.prepare(`INSERT INTO cw_schedules(id,workspace_id,input_version,operation,name,request_key,state,next_run_at,interval_ms,revision,last_run_id,creation_spec,created_at,updated_at)
        VALUES(?,?,?,?,?,?,'enabled',1000,60000,1,NULL,?,?,?)`).run(scheduleId,workspace.id,pinned.id,operation,spec.name,spec.requestKey,JSON.stringify(spec),new Date().toISOString(),new Date().toISOString());
      failed.push({id:scheduleId,error});
    }
    const service=new CloudWorkspaceService(store,new LocalObjectStore(path.join(directory,'objects')));
    const other=strangers[0],space=store.createWorkspace(other,'unrelated owner');
    const good=await service.upload(other,space.id,'ready.md',Buffer.from('# Good\nMust keep running.'));
    const queued=store.createRun(other,space.id,good.version.id,randomUUID());
    const healthy=store.createSchedule(other,space.id,{...input(),inputVersion:good.version.id,operation:'document-summary',firstRunAt:1001,enabled:true});
    reopen();
    const second=new CloudWorkspaceStore(filename);
    try { expect(store.dispatchDueSchedules(1001)).toBe(1);expect(second.dispatchDueSchedules(1001)).toBe(0); }
    finally { second.close(); }
    for(const failedSchedule of failed) {
      expect(store.schedule(actor,failedSchedule.id)).toMatchObject({state:'paused',revision:2,next_run_at:1000,last_run_id:null});
      const events=store.events(actor,workspace.id).events.filter(event=>event.kind==='schedule.paused'&&event.payload.scheduleId===failedSchedule.id);
      expect(events).toHaveLength(1);expect(events[0].payload).toMatchObject({reason:'dispatch_rejected',error:failedSchedule.error,dueAt:1000,revision:2});
    }
    expect(store.listRuns(actor,workspace.id)).toEqual([]);expect(store.schedule(other,healthy.id).last_run_id).toBeTruthy();
    const worker=new CloudWorkspaceWorker(new CloudWorkspaceService(store,service.objects));
    await expect(worker.tick()).resolves.toBe(true);await expect(worker.tick()).resolves.toBe(true);
    expect(store.run(other,queued.id).run).toMatchObject({status:'succeeded',attempt:1});
    reopen();
    for(const failedSchedule of failed) expect(store.schedule(actor,failedSchedule.id)).toMatchObject({state:'paused',revision:2});
  });
  it('rolls back automatic pause when its diagnostic event cannot persist', () => {
    const schedule=store.createSchedule(actor,workspace.id,input({enabled:true}));
    // Legacy-sized metadata fixture: no SQL failure may be mistaken for admission.
    store.db.prepare('UPDATE cw_versions SET size=131073 WHERE id=?').run(version.id);
    store.db.exec("CREATE TRIGGER reject_pause BEFORE INSERT ON cw_outbox WHEN NEW.kind='schedule.paused' BEGIN SELECT RAISE(ABORT,'pause_event_failure'); END");
    expect(()=>store.dispatchDueSchedules(1000)).toThrow('pause_event_failure');
    expect(store.schedule(actor,schedule.id)).toEqual(schedule);expect(store.listRuns(actor,workspace.id)).toEqual([]);
    expect(store.events(actor,workspace.id).events.filter(event=>event.kind==='schedule.paused')).toEqual([]);
    store.db.exec('DROP TRIGGER reject_pause');expect(store.dispatchDueSchedules(1000)).toBe(0);
    expect(store.schedule(actor,schedule.id)).toMatchObject({state:'paused',revision:2});
  });
  it('classifies only known typed admission failures as permanent schedule rejections', () => {
    for(const code of ['document_input_too_large','agent_input_too_large','not_found','unsupported_operation','invalid_request_key','idempotency_conflict']) {
      expect(scheduleDispatchRejection(new CloudWorkspaceError(code))).toBe(code);
    }
    for(const error of [new CloudWorkspaceError('cloud_database_migration_required',503),new CloudWorkspaceError('processing_failed',500),Object.assign(new Error('database failure'),{code:'agent_input_too_large'}),new Error('not_found'),null]) {
      expect(scheduleDispatchRejection(error)).toBeNull();
    }
  });
  it.each(['run.queued','schedule.dispatched'])('rolls back queue insert, schedule advance, and events on %s persistence failure', kind => {
    const schedule = store.createSchedule(actor, workspace.id, input({ enabled: true }));
    store.db.exec(`CREATE TRIGGER reject_dispatch BEFORE INSERT ON cw_outbox WHEN NEW.kind='${kind}' BEGIN SELECT RAISE(ABORT,'injected_failure'); END`);
    expect(() => store.dispatchDueSchedules(1000)).toThrow('injected_failure');
    expect(store.listRuns(actor, workspace.id)).toEqual([]); expect(store.schedule(actor, schedule.id)).toEqual(schedule);
    store.db.exec('DROP TRIGGER reject_dispatch'); expect(store.dispatchDueSchedules(1000)).toBe(1);
  });
  it('rejects another user, tenant, workspace, and unauthenticated reads/mutations', () => {
    const schedule = store.createSchedule(actor, workspace.id, input());
    const run = store.createRun(actor, workspace.id, version.id, 'cancel-auth-run');
    for (const stranger of strangers) {
      expect(() => store.listSchedules(stranger, workspace.id)).toThrow('not_found');
      expect(() => store.schedule(stranger, schedule.id)).toThrow('not_found');
      expect(() => store.createSchedule(stranger, workspace.id, input())).toThrow('not_found');
      expect(() => store.setScheduleEnabled(stranger, schedule.id, 1, true)).toThrow('not_found');
      expect(() => store.cancelRun(stranger, run.id)).toThrow('not_found');
    }
    const other = store.createWorkspace(actor, 'Other');
    expect(() => store.createSchedule(actor, other.id, input())).toThrow('not_found');
    expect(() => store.schedule(null as any, schedule.id)).toThrow('authenticated_identity_required');
    expect(() => store.cancelRun(null as any, run.id)).toThrow('authenticated_identity_required');
  });
  it('validates safe integer timestamps, bounded intervals, booleans, operations, and limits', () => {
    for (const firstRunAt of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER, '1000' as any]) expect(() => store.createSchedule(actor, workspace.id, input({ firstRunAt }))).toThrow('invalid_schedule_time');
    for (const intervalMs of [0, 59999, 60000.5, MAX_SCHEDULE_INTERVAL_MS + 1, Infinity, undefined, '60000' as any]) expect(() => store.createSchedule(actor, workspace.id, input({ intervalMs }))).toThrow('invalid_schedule_interval');
    expect(() => store.createSchedule(actor, workspace.id, input({ enabled: 'true' as any }))).toThrow('invalid_schedule_enabled');
    expect(() => store.createSchedule(actor, workspace.id, input({ operation: 'agent-conversation' as any }))).toThrow('unsupported_operation');
    expect(() => store.createSchedule(actor, workspace.id, input({ requestKey: 12345678 as any }))).toThrow('invalid_request_key');
    for (const limit of [0, 1001, 1.5]) expect(() => store.dispatchDueSchedules(1000, limit)).toThrow('invalid_schedule_limit');
    expect(() => store.dispatchDueSchedules(-1)).toThrow('invalid_schedule_time');
    const schedule = store.createSchedule(actor, workspace.id, input({ firstRunAt: MAX_SCHEDULE_TIMESTAMP, intervalMs: MAX_SCHEDULE_INTERVAL_MS, enabled: true }));
    expect(store.dispatchDueSchedules(MAX_SCHEDULE_TIMESTAMP)).toBe(1);
    expect(Number.isSafeInteger(store.schedule(actor, schedule.id).next_run_at)).toBe(true);
    expect(new Date(store.schedule(actor, schedule.id).next_run_at).toISOString()).toBe('9999-12-31T23:59:59.999Z');
    expect(() => store.setScheduleEnabled(actor, schedule.id, 1.5, false)).toThrow('invalid_schedule_revision');
  });
  it('caps dispatch batch size and supports each allowed scheduled operation', () => {
    for (const operation of ['document-summary', 'agent-summary', 'agent-task'] as const) store.createSchedule(actor, workspace.id, input({ operation, requestKey: `create-${operation}`, enabled: true, intervalMs: null }));
    expect(store.dispatchDueSchedules(1000, 2)).toBe(2); expect(store.dispatchDueSchedules(1000, 2)).toBe(1);
    expect(store.listRuns(actor, workspace.id).map(run => run.operation).sort()).toEqual(['agent-summary', 'agent-task', 'document-summary']);
  });
  it('protects pinned schedule specification at database level', () => {
    const schedule = store.createSchedule(actor, workspace.id, input());
    expect(() => store.db.prepare('UPDATE cw_schedules SET name=?,revision=revision+1 WHERE id=?').run('changed', schedule.id)).toThrow('immutable');
    expect(() => store.db.prepare('UPDATE cw_schedules SET creation_spec=?,revision=revision+1 WHERE id=?').run('{}', schedule.id)).toThrow('immutable');
  });
  it('cancels queued/running work idempotently and fences old execution leases', () => {
    const queued = store.createRun(actor, workspace.id, version.id, 'cancel-queued-run');
    expect(store.cancelRun(actor, queued.id)).toMatchObject({ status: 'failed', error: 'cancelled' });
    expect(store.cancelRun(actor, queued.id).error).toBe('cancelled');
    expect(store.run(actor, queued.id).events.filter(e => e.kind === 'run.cancelled')).toHaveLength(1);
    expect(store.claim(30000, 1000)).toBeNull();
    const task = store.createRun(actor, workspace.id, version.id, 'cancel-running-run', 'agent-task'); const running = store.claim(30000, 1000)!;
    store.cancelRun(actor, task.id); expect(store.renewLease(running, 30000, 1001)).toBe(false);
    expect(() => store.complete(running, { objectKey: 'cancelled-output', size: 1, sha256: hash }, 1001)).toThrow('stale_executor');
    expect(store.run(actor, task.id).artifacts).toEqual([]); reopen(); expect(store.run(actor, task.id).run.error).toBe('cancelled');
  });
  it('keeps succeeded output immutable and names task session bundle with full run ID', () => {
    const queued = store.createRun(actor, workspace.id, version.id, 'successful-task-run', 'agent-task'); const running = store.claim(30000, 1000)!;
    const completed = store.complete(running, { objectKey: 'task-session', size: 1, sha256: hash }, 1001);
    expect(store.file(actor, completed.fileId).name).toBe(`task-session-${queued.id}.json`);
    expect(store.cancelRun(actor, queued.id).status).toBe('succeeded');
    expect(store.run(actor, queued.id).events.map(e => e.kind)).toEqual(['run.queued', 'run.running', 'run.succeeded']);
  });
});
