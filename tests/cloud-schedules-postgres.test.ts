import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PostgresWorkspaceStore } from '../lib/cloud-workspace/postgres-store.ts';
import type { CloudRow } from '../lib/cloud-workspace/store.ts';
import type { CreateCloudSchedule } from '../lib/cloud-workspace/repository.ts';

// Explicitly disposable loopback database only. Uses PostgreSQL's existing
// pg_database_owner role; this fixture creates no credential or runtime role.
const url = process.env.CODIA_TEST_POSTGRES_URL;
const suite = url ? describe : describe.skip;
const actor = { userId: 'schedule-alice', studioId: 'schedule-studio' };
const strangers = [{ ...actor, userId: 'schedule-bob' }, { ...actor, studioId: 'other-studio' }];
const hash = 'a'.repeat(64);
const databaseName = `codia_schedules_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
let bootstrap: Pool, admin: Pool, pool: Pool, store: PostgresWorkspaceStore, databaseUrl: string;
let workspace: CloudRow, version: CloudRow;
const errors: string[] = [];
function watch(pool: Pool) { pool.on('error', error => errors.push(error.message)); return pool; }
function input(overrides: Partial<CreateCloudSchedule> = {}): CreateCloudSchedule {
  return { name: 'Scheduled task', inputVersion: version.id, operation: 'agent-task', requestKey: 'schedule-request-1', firstRunAt: 1000, intervalMs: 60_000, ...overrides };
}
function runtimePool() { return watch(new Pool({ connectionString: databaseUrl, options: '-c role=pg_database_owner', max: 12 })); }

suite('Native PostgreSQL durable schedules, owner RLS, and dispatcher concurrency', () => {
  beforeAll(async () => {
    const parsed = new URL(url!);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || !parsed.pathname.startsWith('/codia_')) throw new Error('Requires an isolated loopback codia_ database');
    bootstrap = watch(new Pool({ connectionString: url })); await bootstrap.query(`CREATE DATABASE ${databaseName}`);
    parsed.pathname = `/${databaseName}`; databaseUrl = parsed.toString(); admin = watch(new Pool({ connectionString: databaseUrl }));
    await admin.query(await readFile(new URL('../lib/cloud-workspace/migrations/002-workspace-runtime.sql', import.meta.url), 'utf8'));
    await expect(new PostgresWorkspaceStore(admin).dispatchDueSchedules(1000)).rejects.toMatchObject({ code: 'cloud_database_migration_required', status: 503 });
    await admin.query(await readFile(new URL('../lib/cloud-workspace/migrations/004-cloud-agent-tasks.sql', import.meta.url), 'utf8'));
    await admin.query(await readFile(new URL('../lib/cloud-workspace/migrations/005-resumable-uploads.sql', import.meta.url), 'utf8'));
    await admin.query('GRANT USAGE ON SCHEMA codia_workspace TO pg_database_owner; GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA codia_workspace TO pg_database_owner; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA codia_workspace TO pg_database_owner');
    pool = runtimePool(); store = new PostgresWorkspaceStore(pool); await store.verifySchema();
    expect((await pool.query('SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0]).toMatchObject({ current_user: 'pg_database_owner', rolsuper: false, rolbypassrls: false });
  });
  beforeEach(async () => {
    workspace = await store.createWorkspace(actor, 'Schedules');
    const staged = await store.stageVersion(actor, workspace.id, 'task.json', 2, hash);
    version = (await store.finalizeVersion(actor, staged.version.id, null)).version;
  });
  afterEach(async () => {
    // End remaining fixture work so global worker claims in the next test remain
    // deterministic. These are synthetic rows in the isolated test database.
    await admin?.query("UPDATE codia_workspace.schedules SET state='paused',revision=revision+1 WHERE state='enabled'; UPDATE codia_workspace.runs SET status='failed',error='fixture_cleanup',lease_until=NULL WHERE status IN ('queued','running')");
  });
  afterAll(async () => {
    await pool?.end(); await admin?.end();
    if (bootstrap) {
      try {
        const deadline = Date.now() + 5000;
        while (Number((await bootstrap.query('SELECT count(*) AS count FROM pg_stat_activity WHERE datname=$1', [databaseName])).rows[0].count) !== 0) {
          if (Date.now() > deadline) throw new Error('PostgreSQL fixture connections did not close');
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        await bootstrap.query(`DROP DATABASE IF EXISTS ${databaseName}`);
      } finally { await bootstrap.end(); }
    }
    expect(errors).toEqual([]);
  });
  it('makes concurrent create and due dispatch exactly once and survives client restart', async () => {
    const spec = input({ enabled: true });
    const created = await Promise.all(Array.from({ length: 8 }, () => store.createSchedule(actor, workspace.id, spec)));
    expect(new Set(created.map(row => row.id)).size).toBe(1);
    const results = await Promise.all(Array.from({ length: 8 }, () => store.dispatchDueSchedules(181000)));
    expect(results.reduce((sum, count) => sum + count, 0)).toBe(1);
    expect(await store.listRuns(actor, workspace.id)).toHaveLength(1);
    const schedule = await store.schedule(actor, created[0].id);
    expect(schedule).toMatchObject({ revision: 2, next_run_at: 241000 });
    expect(schedule.creation_spec).toBeUndefined(); expect(schedule.owner_user).toBeUndefined();
    const raw = (await admin.query('SELECT request_key FROM codia_workspace.runs WHERE id=$1', [schedule.last_run_id])).rows[0];
    expect(raw.request_key).toBe(`schedule_${schedule.id}_1000`);
    await pool.end(); pool = runtimePool(); store = new PostgresWorkspaceStore(pool);
    expect(await store.schedule(actor, schedule.id)).toEqual(schedule);
    expect(await store.dispatchDueSchedules(181000)).toBe(0);
    expect(await store.createSchedule(actor, workspace.id, spec)).toEqual(schedule);
  });
  it('serializes pause/resume CAS against dispatch and preserves original idempotency intent', async () => {
    const spec = input(); const schedule = await store.createSchedule(actor, workspace.id, spec);
    expect(schedule.state).toBe('paused'); expect(await store.dispatchDueSchedules(1_000_000)).toBe(0);
    const edits = await Promise.allSettled([store.setScheduleEnabled(actor, schedule.id, 1, true), store.setScheduleEnabled(actor, schedule.id, 1, true)]);
    expect(edits.filter(edit => edit.status === 'fulfilled')).toHaveLength(1);
    expect((edits.find(edit => edit.status === 'rejected') as PromiseRejectedResult).reason.code).toBe('schedule_conflict');
    const paused = await store.setScheduleEnabled(actor, schedule.id, 2, false);
    expect(await store.createSchedule(actor, workspace.id, { ...spec, enabled: false })).toEqual(paused);
    await expect(store.createSchedule(actor, workspace.id, { ...spec, enabled: true })).rejects.toMatchObject({ code: 'idempotency_conflict' });
    await store.setScheduleEnabled(actor, schedule.id, 3, true); expect(await store.dispatchDueSchedules(1_000_000)).toBe(1);
    expect((await store.schedule(actor, schedule.id)).next_run_at).toBe(1_021_000);
    const kinds = (await store.events(actor, workspace.id)).events.map(event => event.kind);
    expect(kinds).toContain('schedule.paused'); expect(kinds.filter(kind => kind === 'schedule.created')).toHaveLength(1);
  });
  it('suppresses both queued and running overlap and coalesces missed intervals', async () => {
    const schedule = await store.createSchedule(actor, workspace.id, input({ enabled: true }));
    expect(await store.dispatchDueSchedules(1000)).toBe(1); expect(await store.dispatchDueSchedules(61000)).toBe(0);
    const running = await store.claim(30000, 121000); expect(running).not.toBeNull();
    expect(await store.dispatchDueSchedules(181000)).toBe(0);
    await store.cancelRun(actor, running!.id);
    expect(await store.dispatchDueSchedules(241000)).toBe(1); expect(await store.listRuns(actor, workspace.id)).toHaveLength(2);
    expect((await store.schedule(actor, schedule.id)).next_run_at).toBe(301000);
    const skipped = (await store.events(actor, workspace.id)).events.filter(event => event.kind === 'schedule.skipped');
    expect(skipped).toHaveLength(2); expect(skipped[1].payload).toMatchObject({ dueAt: 121000, nextRunAt: 241000, reason: 'overlap' });
  });
  it('applies a bounded batch, completes one-shots, and rejects their re-enable', async () => {
    for (const operation of ['agent-task', 'document-summary', 'agent-summary'] as const) await store.createSchedule(actor, workspace.id, input({ operation, requestKey: `once-${operation}`, enabled: true, intervalMs: null }));
    expect(await store.dispatchDueSchedules(1000, 2)).toBe(2); expect(await store.dispatchDueSchedules(1000, 2)).toBe(1);
    expect(await store.dispatchDueSchedules(100000)).toBe(0);
    for (const schedule of await store.listSchedules(actor, workspace.id)) {
      expect(schedule.state).toBe('completed'); await expect(store.setScheduleEnabled(actor, schedule.id, schedule.revision, true)).rejects.toMatchObject({ code: 'schedule_completed' });
    }
  });
  it('enforces owner/tenant RLS, scoped foreign keys and immutable schedule specifications', async () => {
    const schedule = await store.createSchedule(actor, workspace.id, input());
    const run = await store.createRun(actor, workspace.id, version.id, 'test-cancel-owner');
    for (const stranger of strangers) {
      await expect(store.listSchedules(stranger, workspace.id)).rejects.toMatchObject({ code: 'not_found' });
      await expect(store.schedule(stranger, schedule.id)).rejects.toMatchObject({ code: 'not_found' });
      await expect(store.createSchedule(stranger, workspace.id, input())).rejects.toMatchObject({ code: 'not_found' });
      await expect(store.setScheduleEnabled(stranger, schedule.id, 1, true)).rejects.toMatchObject({ code: 'not_found' });
      await expect(store.cancelRun(stranger, run.id)).rejects.toMatchObject({ code: 'not_found' });
      await store.database.transaction({ actorId: stranger.userId, tenantId: stranger.studioId }, async tx => {
        expect((await tx.query('SELECT * FROM codia_workspace.schedules WHERE id=$1', [schedule.id])).rows).toEqual([]);
        expect((await tx.query("UPDATE codia_workspace.schedules SET state='enabled',revision=revision+1 WHERE id=$1 RETURNING id", [schedule.id])).rows).toEqual([]);
      });
    }
    const other = await store.createWorkspace(actor, 'other');
    await expect(store.createSchedule(actor, other.id, input())).rejects.toMatchObject({ code: 'not_found' });
    await expect(store.database.transaction({ actorId: actor.userId, tenantId: actor.studioId }, tx => tx.query("UPDATE codia_workspace.schedules SET input_version=$1,revision=revision+1 WHERE id=$2", [randomUUID(), schedule.id]))).rejects.toThrow('immutable');
    await expect(store.database.transaction({ actorId: actor.userId, tenantId: actor.studioId }, tx => tx.query('INSERT INTO codia_workspace.schedules SELECT $1, $2, owner_user, studio_id, input_version,operation,name,$3,state,next_run_at,interval_ms,revision,last_run_id,creation_spec,created_at,updated_at FROM codia_workspace.schedules WHERE id=$4', [randomUUID(), other.id, 'forged-fk-key', schedule.id]))).rejects.toThrow('foreign key');
    expect((await pool.query("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='codia_workspace.schedules'::regclass")).rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    expect((await pool.query("SELECT current_setting('codia.trusted_worker',true) AS worker")).rows[0].worker).not.toBe('on');
  });
  it('isolates legacy oversized schedules under concurrent dispatch and preserves other-owner claims', async () => {
    const failed=[];
    for(const [operation,size,error] of [['agent-summary',131073,'agent_input_too_large'],['document-summary',2097153,'document_input_too_large']] as const) {
      const staged=await store.stageVersion(actor,workspace.id,`${operation}.txt`,size,hash);
      const pinned=(await store.finalizeVersion(actor,staged.version.id,null)).version;
      const spec=input({inputVersion:pinned.id,operation,requestKey:randomUUID(),enabled:true}),scheduleId=randomUUID();
      // Legacy applications admitted these immutable version sizes. Seed that
      // persisted shape through the fixture owner, without changing runtime RLS.
      await admin.query(`INSERT INTO codia_workspace.schedules(id,workspace_id,owner_user,studio_id,input_version,operation,name,request_key,state,next_run_at,interval_ms,revision,creation_spec)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,'enabled',1000,60000,1,$9)`,[scheduleId,workspace.id,actor.userId,actor.studioId,pinned.id,operation,spec.name,spec.requestKey,JSON.stringify(spec)]);
      failed.push({id:scheduleId,error});
    }
    const other=strangers[0],space=await store.createWorkspace(other,'unrelated owner'),stage=await store.stageVersion(other,space.id,'small.txt',2,hash);
    const good=(await store.finalizeVersion(other,stage.version.id,null)).version;
    const queued=await store.createRun(other,space.id,good.id,randomUUID());
    const healthy=await store.createSchedule(other,space.id,{...input(),inputVersion:good.id,operation:'document-summary',firstRunAt:1001,enabled:true});
    await pool.end();pool=runtimePool();store=new PostgresWorkspaceStore(pool);
    const results=await Promise.allSettled(Array.from({length:8},()=>store.dispatchDueSchedules(1001)));
    let dispatched=0;for(const outcome of results) { if(outcome.status==='rejected') throw outcome.reason;dispatched+=outcome.value; }
    expect(dispatched).toBe(1);
    for(const failedSchedule of failed) {
      expect(await store.schedule(actor,failedSchedule.id)).toMatchObject({state:'paused',revision:2,next_run_at:1000,last_run_id:null});
      const events=(await store.events(actor,workspace.id)).events.filter(event=>event.kind==='schedule.paused'&&event.payload.scheduleId===failedSchedule.id);
      expect(events).toHaveLength(1);expect(events[0].payload).toMatchObject({reason:'dispatch_rejected',error:failedSchedule.error,dueAt:1000,revision:2});
    }
    expect(await store.listRuns(actor,workspace.id)).toEqual([]);expect((await store.schedule(other,healthy.id)).last_run_id).toBeTruthy();
    expect(await store.claim()).toMatchObject({id:queued.id,status:'running',attempt:1});
    await pool.end();pool=runtimePool();store=new PostgresWorkspaceStore(pool);
    expect(await store.dispatchDueSchedules(1001)).toBe(0);
    for(const failedSchedule of failed) expect(await store.schedule(actor,failedSchedule.id)).toMatchObject({state:'paused',revision:2});
  });
  it('rolls back automatic pause together with a failed diagnostic event', async () => {
    const staged=await store.stageVersion(actor,workspace.id,'oversized.txt',131073,hash);
    const pinned=(await store.finalizeVersion(actor,staged.version.id,null)).version;
    const spec=input({inputVersion:pinned.id,operation:'agent-summary',requestKey:randomUUID(),enabled:true}),scheduleId=randomUUID();
    await admin.query(`INSERT INTO codia_workspace.schedules(id,workspace_id,owner_user,studio_id,input_version,operation,name,request_key,state,next_run_at,interval_ms,revision,creation_spec)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'enabled',1000,60000,1,$9)`,[scheduleId,workspace.id,actor.userId,actor.studioId,pinned.id,spec.operation,spec.name,spec.requestKey,JSON.stringify(spec)]);
    const before=await store.schedule(actor,scheduleId);
    await admin.query("CREATE FUNCTION codia_workspace.reject_test_pause() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='schedule.paused' THEN RAISE EXCEPTION 'pause_event_failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_test_pause BEFORE INSERT ON codia_workspace.outbox FOR EACH ROW EXECUTE FUNCTION codia_workspace.reject_test_pause()");
    try {
      await expect(store.dispatchDueSchedules(1000)).rejects.toThrow('pause_event_failure');
      expect(await store.schedule(actor,scheduleId)).toEqual(before);expect(await store.listRuns(actor,workspace.id)).toEqual([]);
      expect((await store.events(actor,workspace.id)).events.filter(event=>event.kind==='schedule.paused')).toEqual([]);
    } finally { await admin.query('DROP TRIGGER reject_test_pause ON codia_workspace.outbox; DROP FUNCTION codia_workspace.reject_test_pause()'); }
    expect(await store.dispatchDueSchedules(1000)).toBe(0);expect(await store.schedule(actor,scheduleId)).toMatchObject({state:'paused',revision:2});
  });
  it.each(['run.queued','schedule.dispatched'])('rolls back run, schedule advance, and outbox on %s persistence failure', async kind => {
    const schedule = await store.createSchedule(actor, workspace.id, input({ enabled: true }));
    await admin.query(`CREATE FUNCTION codia_workspace.reject_test_dispatch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='${kind}' THEN RAISE EXCEPTION 'injected_dispatch_failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_test_dispatch BEFORE INSERT ON codia_workspace.outbox FOR EACH ROW EXECUTE FUNCTION codia_workspace.reject_test_dispatch()`);
    try {
      await expect(store.dispatchDueSchedules(1000)).rejects.toThrow('injected_dispatch_failure');
      expect(await store.listRuns(actor, workspace.id)).toEqual([]); expect(await store.schedule(actor, schedule.id)).toEqual(schedule);
    } finally { await admin.query('DROP TRIGGER reject_test_dispatch ON codia_workspace.outbox; DROP FUNCTION codia_workspace.reject_test_dispatch()'); }
    expect(await store.dispatchDueSchedules(1000)).toBe(1);
  });
  it('cancels work once, fences stale execution, and preserves successful full-ID artifacts', async () => {
    const cancelled = await store.createRun(actor, workspace.id, version.id, 'cancel-task-run', 'agent-task'); const running = (await store.claim(30000, 1000))!;
    const results = await Promise.all(Array.from({ length: 5 }, () => store.cancelRun(actor, cancelled.id)));
    expect(results.every(row => row.status === 'failed' && row.error === 'cancelled')).toBe(true);
    expect(await store.renewLease(running, 30000, 1001)).toBe(false);
    await expect(store.complete(running, { objectKey: 'cancelled-object', size: 1, sha256: hash }, 1001)).rejects.toMatchObject({ code: 'stale_executor' });
    expect((await store.run(actor, cancelled.id)).events.filter(event => event.kind === 'run.cancelled')).toHaveLength(1);
    const success = await store.createRun(actor, workspace.id, version.id, 'successful-task-run', 'agent-task'); const claim = (await store.claim(30000, 1000))!;
    const artifact = await store.complete(claim, { objectKey: `task-session-${success.id}`, size: 1, sha256: hash }, 1001);
    expect((await store.file(actor, artifact.fileId)).name).toBe(`task-session-${success.id}.json`);
    expect((await store.cancelRun(actor, success.id)).status).toBe('succeeded');
  });
  it('fails clearly when migration marker is absent instead of partially enabling schedules', async () => {
    await admin.query('DELETE FROM codia_workspace.schema_version WHERE version=4');
    try {
      await expect(store.verifySchema()).rejects.toMatchObject({ code: 'cloud_database_migration_required', status: 503 });
      await expect(store.listSchedules(actor, workspace.id)).rejects.toMatchObject({ code: 'cloud_database_migration_required' });
      await expect(store.createSchedule(actor, workspace.id, input())).rejects.toMatchObject({ code: 'cloud_database_migration_required' });
      await expect(store.dispatchDueSchedules(1000)).rejects.toMatchObject({ code: 'cloud_database_migration_required' });
    } finally { await admin.query('INSERT INTO codia_workspace.schema_version VALUES(4)'); }
  });
});
