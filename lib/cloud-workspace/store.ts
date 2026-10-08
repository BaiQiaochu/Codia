import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { CloudOperation, CreateCloudSchedule, EnqueueCloudRun } from './repository.ts';
import { normalizeSchedule, sameScheduleSpecification, nextScheduleOccurrence, scheduleTimestamp, scheduleLimit, scheduleRevision } from './schedules.ts';
import { loadBetterSqliteDatabase } from '../../core/session-manifest/store.ts';

export type CloudActor = { userId: string; studioId: string };
export type CloudRow = Record<string, any>;
export class CloudWorkspaceError extends Error {
  declare status: number;
  declare code: string;
  constructor(code: string, status = 400) { super(code); this.code = code; this.status = status; }
}
const id = () => crypto.randomUUID();
const now = () => new Date().toISOString();

/** Local development authority. Explicitly NOT the production PostgreSQL adapter. */
export class CloudWorkspaceStore {
  declare db: any;
  readonly kind = 'sqlite-local';
  constructor(filename: string) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new (loadBetterSqliteDatabase())(filename);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cw_workspaces (id TEXT PRIMARY KEY, owner_user TEXT NOT NULL, studio_id TEXT NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS cw_workspace_owner ON cw_workspaces(owner_user,studio_id);
      CREATE TABLE IF NOT EXISTS cw_files (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES cw_workspaces(id), name TEXT NOT NULL, current_version TEXT, created_at TEXT NOT NULL, UNIQUE(workspace_id,name));
      CREATE TABLE IF NOT EXISTS cw_versions (id TEXT PRIMARY KEY, file_id TEXT NOT NULL REFERENCES cw_files(id), object_key TEXT NOT NULL UNIQUE, size INTEGER NOT NULL, sha256 TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('staging','ready','rejected')), created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cw_runs (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES cw_workspaces(id), input_version TEXT NOT NULL REFERENCES cw_versions(id), operation TEXT NOT NULL, request_key TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed')), attempt INTEGER NOT NULL DEFAULT 0, lease_until INTEGER, artifact_file_id TEXT REFERENCES cw_files(id), error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(workspace_id,request_key));
      CREATE INDEX IF NOT EXISTS cw_run_claim ON cw_runs(status,lease_until,created_at);
      CREATE TABLE IF NOT EXISTS cw_schedules (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES cw_workspaces(id), input_version TEXT NOT NULL REFERENCES cw_versions(id),
        operation TEXT NOT NULL CHECK(operation IN ('document-summary','agent-summary','agent-task')), name TEXT NOT NULL, request_key TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('enabled','paused','completed')), next_run_at INTEGER NOT NULL CHECK(next_run_at BETWEEN 0 AND 253402300799999),
        interval_ms INTEGER CHECK(interval_ms BETWEEN 60000 AND 31622400000), revision INTEGER NOT NULL DEFAULT 1 CHECK(revision BETWEEN 1 AND 9007199254740991),
        last_run_id TEXT REFERENCES cw_runs(id), creation_spec TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(workspace_id,request_key)
      );
      CREATE INDEX IF NOT EXISTS cw_schedule_due ON cw_schedules(state,next_run_at,id);
      CREATE TRIGGER IF NOT EXISTS cw_schedule_immutable BEFORE UPDATE ON cw_schedules
        WHEN NEW.id<>OLD.id OR NEW.workspace_id<>OLD.workspace_id OR NEW.input_version<>OLD.input_version OR NEW.operation<>OLD.operation
          OR NEW.name<>OLD.name OR NEW.request_key<>OLD.request_key OR NEW.interval_ms IS NOT OLD.interval_ms
          OR NEW.creation_spec<>OLD.creation_spec OR NEW.created_at<>OLD.created_at
        BEGIN SELECT RAISE(ABORT,'Schedule specification is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS cw_schedule_transition BEFORE UPDATE ON cw_schedules
        WHEN NEW.revision<>OLD.revision+1 OR (OLD.state='completed' AND NEW.state<>'completed')
        BEGIN SELECT RAISE(ABORT,'Invalid schedule revision or terminal state transition'); END;
      CREATE TRIGGER IF NOT EXISTS cw_schedule_input_scope BEFORE INSERT ON cw_schedules
        WHEN NOT EXISTS(SELECT 1 FROM cw_versions v JOIN cw_files f ON f.id=v.file_id WHERE v.id=NEW.input_version AND f.workspace_id=NEW.workspace_id AND v.status='ready')
        BEGIN SELECT RAISE(ABORT,'Schedule input is outside workspace or not ready'); END;
      CREATE TRIGGER IF NOT EXISTS cw_schedule_run_scope BEFORE UPDATE OF last_run_id ON cw_schedules
        WHEN NEW.last_run_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM cw_runs WHERE id=NEW.last_run_id AND workspace_id=NEW.workspace_id)
        BEGIN SELECT RAISE(ABORT,'Schedule run is outside workspace'); END;
      CREATE TABLE IF NOT EXISTS cw_artifacts (id TEXT PRIMARY KEY, run_id TEXT NOT NULL UNIQUE REFERENCES cw_runs(id), file_id TEXT NOT NULL REFERENCES cw_files(id), version_id TEXT NOT NULL REFERENCES cw_versions(id));
      CREATE TABLE IF NOT EXISTS cw_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL REFERENCES cw_workspaces(id), run_id TEXT, kind TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL, published INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS cw_events (id INTEGER PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES cw_workspaces(id), run_id TEXT, kind TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
    `);
  }
  close() { this.db.close(); }
  transaction<T>(fn: () => T): T { return this.db.transaction(fn).immediate(); }
  workspace(actor: CloudActor, workspaceId: string): CloudRow {
    this.assertActor(actor);
    const row = this.db.prepare('SELECT * FROM cw_workspaces WHERE id=? AND owner_user=? AND studio_id=?').get(workspaceId, actor.userId, actor.studioId);
    if (!row) throw new CloudWorkspaceError('not_found', 404);
    return row;
  }
  assertActor(actor: CloudActor) {
    if (!actor?.userId || !actor?.studioId) throw new CloudWorkspaceError('authenticated_identity_required', 401);
  }
  listWorkspaces(actor: CloudActor) {
    this.assertActor(actor);
    return this.db.prepare('SELECT id,name,created_at FROM cw_workspaces WHERE owner_user=? AND studio_id=? ORDER BY created_at,id').all(actor.userId, actor.studioId);
  }
  createWorkspace(actor: CloudActor, name: string) {
    this.assertActor(actor);
    const row = { id: id(), name: validName(name), created_at: now() };
    this.db.prepare('INSERT INTO cw_workspaces VALUES (?,?,?,?,?)').run(row.id, actor.userId, actor.studioId, row.name, row.created_at);
    return row;
  }
  file(actor: CloudActor, fileId: string): CloudRow {
    const row = this.db.prepare('SELECT * FROM cw_files WHERE id=?').get(fileId);
    if (!row) throw new CloudWorkspaceError('not_found', 404);
    this.workspace(actor, row.workspace_id);
    return row;
  }
  version(actor: CloudActor, versionId: string): CloudRow {
    const row = this.db.prepare('SELECT v.*,f.workspace_id,f.name FROM cw_versions v JOIN cw_files f ON f.id=v.file_id WHERE v.id=? AND v.status=\'ready\'').get(versionId);
    if (!row) throw new CloudWorkspaceError('not_found', 404);
    this.workspace(actor, row.workspace_id);
    return row;
  }
  listFiles(actor: CloudActor, workspaceId: string) {
    this.workspace(actor, workspaceId);
    return this.db.prepare(`SELECT f.*,v.size,v.sha256,(SELECT COUNT(*) FROM cw_versions v2 WHERE v2.file_id=f.id AND v2.status='ready') AS version_count FROM cw_files f JOIN cw_versions v ON v.id=f.current_version AND v.status='ready' WHERE f.workspace_id=? ORDER BY f.created_at,f.id`).all(workspaceId);
  }
  fileSummary(actor: CloudActor, fileId: string) {
    const file = this.file(actor, fileId);
    const summary = this.db.prepare("SELECT f.*,v.size,v.sha256,(SELECT COUNT(*) FROM cw_versions v2 WHERE v2.file_id=f.id AND v2.status='ready') AS version_count FROM cw_files f JOIN cw_versions v ON v.id=f.current_version AND v.status='ready' WHERE f.id=?").get(file.id);
    if (!summary) throw new CloudWorkspaceError('not_found', 404);
    return summary;
  }
  versions(actor: CloudActor, fileId: string) {
    this.file(actor, fileId);
    return this.db.prepare("SELECT id,size,sha256,created_at FROM cw_versions WHERE file_id=? AND status='ready' ORDER BY created_at,id").all(fileId);
  }
  stageVersion(actor: CloudActor, workspaceId: string, name: string, size: number, sha256: string, fileId?: string, expectedVersion?: string) {
    return this.transaction(() => {
      this.workspace(actor, workspaceId);
      this.reconcileStaging();
      let file: CloudRow;
      if (fileId) {
        file = this.file(actor, fileId);
        if (file.workspace_id !== workspaceId) throw new CloudWorkspaceError('not_found', 404);
        if (!expectedVersion || file.current_version !== expectedVersion) throw new CloudWorkspaceError('version_conflict', 409);
      } else {
        const normalized = validName(name);
        if (this.db.prepare('SELECT id FROM cw_files WHERE workspace_id=? AND name=?').get(workspaceId, normalized)) throw new CloudWorkspaceError('file_name_exists', 409);
        file = { id: id(), workspace_id: workspaceId, name: normalized, current_version: null, created_at: now() };
        this.db.prepare('INSERT INTO cw_files VALUES (?,?,?,?,?)').run(file.id, workspaceId, file.name, null, file.created_at);
      }
      const version = { id: id(), file_id: file.id, object_key: '', size, sha256, status: 'staging', created_at: now() };
      version.object_key = `workspaces/${workspaceId}/files/${file.id}/versions/${version.id}`;
      this.db.prepare('INSERT INTO cw_versions VALUES (?,?,?,?,?,?,?)').run(version.id, file.id, version.object_key, size, sha256, 'staging', version.created_at);
      return { file, version, expected: file.current_version };
    });
  }
  finalizeVersion(actor: CloudActor, versionId: string, expected: string | null, enqueue?: EnqueueCloudRun) {
    return this.transaction(() => {
      const version = this.db.prepare('SELECT * FROM cw_versions WHERE id=?').get(versionId);
      if (!version || version.status !== 'staging') throw new CloudWorkspaceError('upload_not_pending', 409);
      const file = this.file(actor, version.file_id);
      if (file.current_version !== expected) throw new CloudWorkspaceError('version_conflict', 409);
      this.db.prepare("UPDATE cw_versions SET status='ready' WHERE id=?").run(versionId);
      this.db.prepare('UPDATE cw_files SET current_version=? WHERE id=?').run(versionId, file.id);
      this.event(file.workspace_id, null, 'file.version_ready', { fileId: file.id, versionId });
      const run = enqueue ? this.createRun(actor, file.workspace_id, versionId, enqueue.requestKey, enqueue.operation) : undefined;
      return { file: this.fileSummary(actor, file.id), version: publicVersion(version), ...(run ? { run } : {}) };
    });
  }
  // Bounded uploads retain five-minute in-flight grace; crash leftovers preserve bytes.
  reconcileStaging(timestamp = Date.now(), graceMs = 5 * 60 * 1000) {
    const cutoff = new Date(timestamp - graceMs).toISOString();
    const stale = this.db.prepare("SELECT id FROM cw_versions WHERE status='staging' AND created_at<?").all(cutoff);
    for (const row of stale) this.rejectVersion(row.id);
    return stale.length;
  }
  rejectVersion(versionId: string) {
    this.transaction(() => {
      const v = this.db.prepare("SELECT file_id FROM cw_versions WHERE id=? AND status='staging'").get(versionId);
      if (!v) return;
      this.db.prepare("UPDATE cw_versions SET status='rejected' WHERE id=?").run(versionId);
      this.db.prepare("UPDATE cw_files SET name=name || '.failed-' || id WHERE id=? AND current_version IS NULL").run(v.file_id);
    });
  }
  createRun(actor: CloudActor, workspaceId: string, inputVersion: string, requestKey: string, operation: CloudOperation = 'document-summary') {
    if (typeof requestKey === 'string' && requestKey.startsWith('schedule_')) throw new CloudWorkspaceError('reserved_request_key');
    return this.#createRun(actor, workspaceId, inputVersion, requestKey, operation);
  }
  #createRun(actor: CloudActor, workspaceId: string, inputVersion: string, requestKey: string, operation: CloudOperation) {
    return this.transaction(() => {
      this.workspace(actor, workspaceId);
      if (!['document-summary', 'agent-summary', 'agent-conversation', 'agent-task'].includes(operation)) throw new CloudWorkspaceError('unsupported_operation');
      const input = this.version(actor, inputVersion);
      if (input.workspace_id !== workspaceId) throw new CloudWorkspaceError('not_found', 404);
      if (!/^[A-Za-z0-9_-]{8,128}$/.test(requestKey || '')) throw new CloudWorkspaceError('invalid_request_key');
      const old = this.db.prepare('SELECT * FROM cw_runs WHERE workspace_id=? AND request_key=?').get(workspaceId, requestKey);
      if (old) {
        if (old.input_version !== inputVersion || old.operation !== operation) throw new CloudWorkspaceError('idempotency_conflict', 409);
        return publicRun(old);
      }
      const run = { id: id(), workspace_id: workspaceId, input_version: inputVersion, operation, request_key: requestKey, status: 'queued', attempt: 0, lease_until: null, artifact_file_id: null, error: null, created_at: now(), updated_at: now() };
      this.db.prepare('INSERT INTO cw_runs VALUES (@id,@workspace_id,@input_version,@operation,@request_key,@status,@attempt,@lease_until,@artifact_file_id,@error,@created_at,@updated_at)').run(run);
      this.event(workspaceId, run.id, 'run.queued', { runId: run.id });
      return publicRun(run);
    });
  }
  cancelRun(actor: CloudActor, runId: string) {
    return this.transaction(() => {
      this.assertActor(actor);
      const run = this.db.prepare('SELECT * FROM cw_runs WHERE id=?').get(runId);
      if (!run) throw new CloudWorkspaceError('not_found', 404);
      this.workspace(actor, run.workspace_id);
      if (run.status === 'queued' || run.status === 'running') {
        this.db.prepare("UPDATE cw_runs SET status='failed',error='cancelled',lease_until=NULL,updated_at=? WHERE id=?").run(now(), runId);
        this.event(run.workspace_id, run.id, 'run.cancelled', { runId });
      }
      return publicRun(this.db.prepare('SELECT * FROM cw_runs WHERE id=?').get(runId));
    });
  }
  listSchedules(actor: CloudActor, workspaceId: string) {
    this.workspace(actor, workspaceId);
    return this.db.prepare('SELECT * FROM cw_schedules WHERE workspace_id=? ORDER BY created_at,id').all(workspaceId).map(publicSchedule);
  }
  schedule(actor: CloudActor, scheduleId: string) {
    this.assertActor(actor);
    const row = this.db.prepare('SELECT * FROM cw_schedules WHERE id=?').get(scheduleId);
    if (!row) throw new CloudWorkspaceError('not_found', 404);
    this.workspace(actor, row.workspace_id);
    return publicSchedule(row);
  }
  createSchedule(actor: CloudActor, workspaceId: string, input: CreateCloudSchedule) {
    return this.transaction(() => {
      this.workspace(actor, workspaceId);
      const spec = normalizeSchedule(input);
      const version = this.version(actor, spec.inputVersion);
      if (version.workspace_id !== workspaceId) throw new CloudWorkspaceError('not_found', 404);
      const old = this.db.prepare('SELECT * FROM cw_schedules WHERE workspace_id=? AND request_key=?').get(workspaceId, input.requestKey);
      if (old) {
        if (!sameScheduleSpecification(old.creation_spec, spec)) throw new CloudWorkspaceError('idempotency_conflict', 409);
        return publicSchedule(old);
      }
      const schedule = { id: id(), workspace_id: workspaceId, input_version: spec.inputVersion, operation: spec.operation, name: spec.name,
        request_key: input.requestKey, state: spec.enabled ? 'enabled' : 'paused', next_run_at: spec.firstRunAt, interval_ms: spec.intervalMs,
        revision: 1, last_run_id: null, creation_spec: JSON.stringify(spec), created_at: now(), updated_at: now() };
      this.db.prepare('INSERT INTO cw_schedules VALUES (@id,@workspace_id,@input_version,@operation,@name,@request_key,@state,@next_run_at,@interval_ms,@revision,@last_run_id,@creation_spec,@created_at,@updated_at)').run(schedule);
      this.event(workspaceId, null, 'schedule.created', { scheduleId: schedule.id, state: schedule.state, revision: 1 });
      return publicSchedule(schedule);
    });
  }
  setScheduleEnabled(actor: CloudActor, scheduleId: string, expectedRevision: number, enabled: boolean) {
    return this.transaction(() => {
      this.assertActor(actor);
      const schedule = this.db.prepare('SELECT * FROM cw_schedules WHERE id=?').get(scheduleId);
      if (!schedule) throw new CloudWorkspaceError('not_found', 404);
      this.workspace(actor, schedule.workspace_id);
      scheduleRevision(expectedRevision, enabled);
      if (schedule.revision !== expectedRevision) throw new CloudWorkspaceError('schedule_conflict', 409);
      if (schedule.state === 'completed') {
        if (enabled) throw new CloudWorkspaceError('schedule_completed', 409);
        return publicSchedule(schedule);
      }
      const state = enabled ? 'enabled' : 'paused';
      if (state === schedule.state) return publicSchedule(schedule);
      this.db.prepare('UPDATE cw_schedules SET state=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?').run(state, now(), scheduleId, expectedRevision);
      this.event(schedule.workspace_id, null, enabled ? 'schedule.enabled' : 'schedule.paused', { scheduleId, revision: expectedRevision + 1 });
      return publicSchedule(this.db.prepare('SELECT * FROM cw_schedules WHERE id=?').get(scheduleId));
    });
  }
  dispatchDueSchedules(timestamp = Date.now(), limit = 100) {
    scheduleTimestamp(timestamp); scheduleLimit(limit);
    return this.transaction(() => {
      const due = this.db.prepare("SELECT s.*,w.owner_user,w.studio_id FROM cw_schedules s JOIN cw_workspaces w ON w.id=s.workspace_id WHERE s.state='enabled' AND s.next_run_at<=? ORDER BY s.next_run_at,s.id LIMIT ?").all(timestamp, limit);
      let dispatched = 0;
      for (const schedule of due) {
        const active = schedule.last_run_id && this.db.prepare("SELECT id FROM cw_runs WHERE id=? AND status IN ('queued','running')").get(schedule.last_run_id);
        const run = active ? null : this.#createRun({userId: schedule.owner_user, studioId: schedule.studio_id}, schedule.workspace_id,
          schedule.input_version, `schedule_${schedule.id}_${schedule.next_run_at}`, schedule.operation);
        const next = nextScheduleOccurrence(schedule.next_run_at, schedule.interval_ms, timestamp);
        const state = schedule.interval_ms === null ? 'completed' : 'enabled';
        this.db.prepare('UPDATE cw_schedules SET state=?,next_run_at=?,revision=revision+1,last_run_id=?,updated_at=? WHERE id=?').run(state, next, run?.id ?? schedule.last_run_id, now(), schedule.id);
        this.event(schedule.workspace_id, run?.id ?? schedule.last_run_id, active ? 'schedule.skipped' : 'schedule.dispatched', {
          scheduleId: schedule.id, dueAt: schedule.next_run_at, nextRunAt: next, revision: schedule.revision + 1,
          ...(active ? { reason: 'overlap', runId: schedule.last_run_id } : { runId: run!.id }),
        });
        if (run) dispatched += 1;
      }
      return dispatched;
    });
  }
  listRuns(actor: CloudActor, workspaceId: string) {
    this.workspace(actor, workspaceId);
    return this.db.prepare('SELECT * FROM cw_runs WHERE workspace_id=? ORDER BY created_at DESC,id').all(workspaceId).map(publicRun);
  }
  run(actor: CloudActor, runId: string) {
    const run = this.db.prepare('SELECT * FROM cw_runs WHERE id=?').get(runId);
    if (!run) throw new CloudWorkspaceError('not_found', 404);
    this.workspace(actor, run.workspace_id);
    this.publishOutbox();
    return { run: publicRun(run), events: this.db.prepare('SELECT * FROM cw_events WHERE run_id=? ORDER BY id').all(runId).map(publicEvent), artifacts: this.db.prepare('SELECT a.*,f.name,v.size FROM cw_artifacts a JOIN cw_files f ON a.file_id=f.id JOIN cw_versions v ON v.id=a.version_id WHERE a.run_id=?').all(runId) };
  }
  claim(leaseMs = 30000, timestamp = Date.now()): CloudRow | null {
    return this.transaction(() => {
      const exhausted = this.db.prepare("SELECT * FROM cw_runs WHERE status='running' AND lease_until<=? AND attempt>=3").all(timestamp);
      for (const row of exhausted) {
        this.db.prepare("UPDATE cw_runs SET status='failed',error='retry_limit',updated_at=? WHERE id=?").run(now(), row.id);
        this.event(row.workspace_id, row.id, 'run.failed', { error: 'retry_limit' });
      }
      const row = this.db.prepare("SELECT r.*,v.object_key,v.sha256,v.size,f.name,w.owner_user,w.studio_id FROM cw_runs r JOIN cw_workspaces w ON w.id=r.workspace_id JOIN cw_versions v ON v.id=r.input_version JOIN cw_files f ON f.id=v.file_id WHERE (r.status='queued' OR (r.status='running' AND r.lease_until<=?)) AND r.attempt<3 ORDER BY r.created_at,r.id LIMIT 1").get(timestamp);
      if (!row) return null;
      const attempt = row.attempt + 1;
      this.db.prepare("UPDATE cw_runs SET status='running',attempt=?,lease_until=?,updated_at=? WHERE id=?").run(attempt, timestamp + leaseMs, now(), row.id);
      this.event(row.workspace_id, row.id, 'run.running', { attempt, recovered: row.attempt > 0 });
      return { ...row, attempt, lease_until: timestamp + leaseMs, status: 'running' };
    });
  }
  renewLease(run: CloudRow, leaseMs = 30000, timestamp = Date.now()): boolean {
    const update = this.db.prepare("UPDATE cw_runs SET lease_until=?,updated_at=? WHERE id=? AND status='running' AND attempt=? AND lease_until>?").run(timestamp + leaseMs, now(), run.id, run.attempt, timestamp);
    return update.changes === 1;
  }
  complete(run: CloudRow, output: { objectKey: string; size: number; sha256: string }, timestamp = Date.now()) {
    return this.transaction(() => {
      const current = this.db.prepare("SELECT * FROM cw_runs WHERE id=? AND status='running' AND attempt=? AND lease_until>?").get(run.id, run.attempt, timestamp);
      if (!current) throw new CloudWorkspaceError('stale_executor', 409);
      const fileId = id(), versionId = id(), created = now();
      const name = current.operation === 'agent-task' ? `task-session-${current.id}.json` : `检查结果-${current.id.slice(0, 8)}.md`;
      this.db.prepare('INSERT INTO cw_files VALUES (?,?,?,?,?)').run(fileId, current.workspace_id, name, versionId, created);
      this.db.prepare('INSERT INTO cw_versions VALUES (?,?,?,?,?,?,?)').run(versionId, fileId, output.objectKey, output.size, output.sha256, 'ready', created);
      this.db.prepare('INSERT INTO cw_artifacts VALUES (?,?,?,?)').run(id(), run.id, fileId, versionId);
      this.db.prepare("UPDATE cw_runs SET status='succeeded',artifact_file_id=?,lease_until=NULL,updated_at=? WHERE id=?").run(fileId, created, run.id);
      this.event(current.workspace_id, run.id, 'run.succeeded', { fileId, versionId });
      return { fileId, versionId };
    });
  }
  fail(run: CloudRow, code: string) {
    this.transaction(() => {
      const update = this.db.prepare("UPDATE cw_runs SET status='failed',error=?,lease_until=NULL,updated_at=? WHERE id=? AND status='running' AND attempt=? AND lease_until>?").run(code, now(), run.id, run.attempt, Date.now());
      if (update.changes) this.event(run.workspace_id, run.id, 'run.failed', { error: code });
    });
  }
  event(workspaceId: string, runId: string | null, kind: string, payload: unknown) {
    this.db.prepare('INSERT INTO cw_outbox(workspace_id,run_id,kind,payload,created_at) VALUES (?,?,?,?,?)').run(workspaceId, runId, kind, JSON.stringify(payload), now());
  }
  publishOutbox() {
    this.transaction(() => {
      this.db.exec(`INSERT OR IGNORE INTO cw_events SELECT id,workspace_id,run_id,kind,payload,created_at FROM cw_outbox WHERE published=0;
        UPDATE cw_outbox SET published=1 WHERE published=0;`);
    });
  }
  events(actor: CloudActor, workspaceId: string, after = 0) {
    this.workspace(actor, workspaceId);
    this.publishOutbox();
    const events = this.db.prepare('SELECT * FROM cw_events WHERE workspace_id=? AND id>? ORDER BY id LIMIT 200').all(workspaceId, after).map(publicEvent);
    return { events, cursor: events.at(-1)?.id ?? after };
  }
}
export function validName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 160 || (value.includes('/') || value.includes('\\') || Array.from(value).some(char => char.charCodeAt(0) < 32))) throw new CloudWorkspaceError('invalid_name');
  return value.trim();
}
function publicVersion(v: CloudRow) { return { id: v.id, size: v.size, sha256: v.sha256, created_at: v.created_at }; }
function publicRun(r: CloudRow) { const { lease_until: _lease, request_key: _key, ...publicRow } = r; return publicRow; }
function publicEvent(e: CloudRow) { return { id: e.id, kind: e.kind, payload: JSON.parse(e.payload), created_at: e.created_at }; }

function publicSchedule(row: CloudRow) { const { creation_spec: _spec, owner_user: _owner, studio_id: _studio, ...result } = row; return result; }
