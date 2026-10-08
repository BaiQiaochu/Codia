import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CloudWorkspaceStore, type CloudActor } from '../lib/cloud-workspace/store.ts';
import { LocalObjectStore, type ObjectStore } from '../lib/cloud-workspace/object-store.ts';
import { SqliteLegacyMigrationRepository } from '../lib/cloud-workspace/sqlite-legacy-migration.ts';
import { applyLegacyMigration, migrationPlanSummary, planLegacyMigration, scanLegacyData, type MigrationPlan } from '../lib/cloud-workspace/legacy-migration.ts';

const actor: CloudActor = { userId: 'alice', studioId: 'studio-a' };
const bob: CloudActor = { userId: 'bob', studioId: 'studio-a' };
let directory: string, source: string, store: CloudWorkspaceStore, repository: SqliteLegacyMigrationRepository, objects: ObjectStore, workspaceId: string;
const sessionPath = 'agents/agent-a/sessions/first.jsonl';
function write(relativePath: string, value: string) { const filename = path.join(source, relativePath); fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, value); }
function selection() { return { sourceRoot: source, sourceId: 'desktop-one', owner: actor, agentIds: ['agent-a'], includeSharedState: true }; }
async function plan(batchId?: string) { return planLegacyMigration(actor, workspaceId, await scanLegacyData(selection()), await repository.migrationSnapshot(actor, workspaceId, 'desktop-one'), batchId); }
async function imported(plan: MigrationPlan) { const item = plan.assets.find(item => item.kind === 'session')!; return { item, file: store.file(actor, item.fileId) }; }
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-migration-')); source = path.join(directory, 'source'); fs.mkdirSync(source);
  store = new CloudWorkspaceStore(path.join(directory, 'metadata.db')); repository = new SqliteLegacyMigrationRepository(store); objects = new LocalObjectStore(path.join(directory, 'objects'));
  workspaceId = store.createWorkspace(actor, 'Imported records').id;
  write(sessionPath, '{"type":"session","id":"old-session-1"}\n{"type":"message","content":"Hello"}\n');
  write('agents/agent-a/workflow-journals/run-a.jsonl', '{"nodeSeq":1,"key":"result","result":"done","status":"ok"}\n');
  write('workflow-activity.json', '{"schemaVersion":1,"entries":{"run-a":{"status":"running"}}}');
  write('aftersales/tasks.json', '{"version":1,"tasks":[{"id":"task-a","status":"pending"}]}');
  write('user/session-projects.json', '{"version":1,"projects":[{"id":"project-a","name":"Client"}]}');
});
afterEach(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });

describe('scoped legacy migration', () => {
  it('dry-runs without object, metadata, audit, or source mutation', async () => {
    const original = fs.readFileSync(path.join(source, sessionPath));
    const p = await plan(); expect(p.assets).toHaveLength(6);
    expect(store.listFiles(actor, workspaceId)).toEqual([]);
    expect(store.db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'cw_legacy_%'").all()).toEqual([]);
    expect(fs.existsSync(path.join(directory, 'objects'))).toBe(false);
    expect(fs.readFileSync(path.join(source, sessionPath))).toEqual(original);
    const summary = JSON.stringify(migrationPlanSummary(p)); expect(summary).not.toContain('Hello'); expect(summary).not.toContain(source);
  });
  it('imports real session/workflow/business payloads, canonical IDs and a manifest without replaying', async () => {
    const p = await plan(), result = await applyLegacyMigration(repository, objects, p);
    expect(result.imported).toBe(6); expect(store.listFiles(actor, workspaceId)).toHaveLength(6); expect(store.listRuns(actor, workspaceId)).toEqual([]);
    const { item } = await imported(p), saved = JSON.parse((await objects.get(store.version(actor, item.versionId).object_key)).toString());
    expect(saved).toMatchObject({ schemaVersion: 1, id: item.fileId, kind: 'conversation', data: { legacy: { execution: 'inert-snapshot', originalSha256: expect.stringMatching(/^[a-f0-9]{64}$/) }, content: [{ type: 'session', id: 'old-session-1' }, { type: 'message', content: 'Hello' }] } });
    expect(item.name).toBe(`record-conversation-${item.fileId}.json`);
    const manifest = JSON.parse((await objects.get(p.assets.find(a => a.kind === 'manifest')!.objectKey)).toString());
    expect(manifest.entries.find(e => e.relativePath === sessionPath).resourceId).toBe(`cloud-file:${item.fileId}`);
  });
  it('exposes imported sessions as readable and editable cloud records with optimistic versions', async () => {
    const { CloudRecordService } = await import('../lib/cloud-workspace/records.ts');
    const { CloudWorkspaceService } = await import('../lib/cloud-workspace/service.ts');
    write(sessionPath, JSON.stringify({ type: 'session', id: 'old-session' }) + '\n' + JSON.stringify({ type: 'message', id: 'legacy-user', timestamp: '2026-10-01T00:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'Please review this design' }] } }) + '\n' + JSON.stringify({ type: 'message', id: 'legacy-assistant', timestamp: '2026-10-01T00:00:01.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'The design is ready' }] } }) + '\n');
    const p = await plan(); await applyLegacyMigration(repository, objects, p);
    const records = new CloudRecordService(new CloudWorkspaceService(store, objects));
    const list = await records.list(actor, workspaceId); expect(list).toHaveLength(5);
    const fileId = p.assets.find(item => item.kind === 'session')!.fileId;
    const conversation = await records.get(actor, fileId);
    expect(conversation.data.messages).toMatchObject([{ id: 'legacy-user', role: 'user', text: 'Please review this design' }, { id: 'legacy-assistant', role: 'assistant', text: 'The design is ready' }]);
    const updated = await records.update(actor, fileId, conversation.currentVersion, { ...conversation.data, cloudNote: 'Reviewed from second client' });
    expect(updated.currentVersion).not.toBe(conversation.currentVersion); expect(updated.data.cloudNote).toBe('Reviewed from second client');
    await expect(records.update(actor, fileId, conversation.currentVersion, conversation.data)).rejects.toThrow('version_conflict');
    expect(await repository.rollbackMigration(actor, workspaceId, p.batchId)).toMatchObject({ preserved: 1 });
    expect((await records.get(actor, fileId)).data.cloudNote).toBe('Reviewed from second client');
  });
  it('is idempotent across retries and metadata reopen, preserving one audit row', async () => {
    const p = await plan(); await applyLegacyMigration(repository, objects, p);
    store.close(); store = new CloudWorkspaceStore(path.join(directory, 'metadata.db')); repository = new SqliteLegacyMigrationRepository(store);
    const retry = await plan(); expect(retry.batchId).toBe(p.batchId); expect(retry.assets.every(a => a.action === 'unchanged')).toBe(true);
    expect(await applyLegacyMigration(repository, objects, retry)).toMatchObject({ imported: 0, unchanged: 6 });
    expect(store.db.prepare('SELECT * FROM cw_legacy_audit').all()).toHaveLength(1); expect(store.db.prepare('SELECT * FROM cw_versions').all()).toHaveLength(6);
  });
  it('scopes source selection and records to both owner and tenant', async () => {
    const scan = await scanLegacyData(selection());
    expect(() => planLegacyMigration(bob, workspaceId, scan, { items: [], batches: [] })).toThrow('source_owner_mismatch');
    for (const other of [bob, { ...actor, studioId: 'studio-b' }]) {
      await expect(repository.migrationSnapshot(other, workspaceId, scan.sourceId)).rejects.toThrow('not_found');
      const p = await plan(); await expect(repository.commitMigration(other, p)).rejects.toThrow('not_found');
    }
    const p = await plan(); await applyLegacyMigration(repository, objects, p);
    await expect(repository.rollbackMigration(bob, workspaceId, p.batchId)).rejects.toThrow('not_found');
  });
  it('does not infer permission for unselected agents or shared stores', async () => {
    write('agents/other-user/sessions/private.jsonl', '{"content":"Not mine"}\n');
    const scan = await scanLegacyData({ ...selection(), includeSharedState: false });
    expect(scan.assets.map(a => a.kind)).toEqual(['session', 'workflow-journal']); expect(JSON.stringify(scan)).not.toContain('Not mine');
    await expect(scanLegacyData({ ...selection(), agentIds: ['../other-user'] })).rejects.toThrow('explicit_source_selection_required');
    await expect(scanLegacyData({ ...selection(), sourceRoot: '.' })).rejects.toThrow('absolute_source_root_required');
  });
  it('skips credentials, malformed records, symlinks, hardlinks, oversized and unknown files', async () => {
    write('auth.json', '{"access_token":"DO_NOT_READ"}'); write('agents/agent-a/sessions/.env', 'PASSWORD=DO_NOT_READ');
    write('agents/agent-a/sessions/leaked.jsonl', '{"apiKey":"DO_NOT_UPLOAD"}\n');
    write('agents/agent-a/sessions/broken.jsonl', '{broken}\n'); write('agents/agent-a/sessions/large.jsonl', 'a'.repeat(500));
    write('agents/agent-a/sessions/code.js', 'throw new Error("Never execute");');
    const outside = path.join(directory, 'outside.jsonl'); fs.writeFileSync(outside, '{"outside":true}\n');
    fs.symlinkSync(outside, path.join(source, 'agents/agent-a/sessions/link.jsonl')); fs.linkSync(outside, path.join(source, 'agents/agent-a/sessions/hard.jsonl'));
    const scan = await scanLegacyData({ ...selection(), maxFileBytes: 250 });
    expect(scan.skipped.map(s => s.reason)).toEqual(expect.arrayContaining(['secret_filename', 'possible_credentials', 'invalid_or_unreadable_record', 'source_too_large', 'not_allowlisted', 'symlink_skipped', 'non_regular_source']));
    expect(JSON.stringify(scan.assets)).not.toContain('DO_NOT'); expect(JSON.stringify(scan.assets)).not.toContain('outside');
    expect(fs.readFileSync(path.join(source, 'agents/agent-a/sessions/leaked.jsonl'), 'utf8')).toContain('DO_NOT_UPLOAD');
  });
  it('rejects symlink source roots and symlink parent directories', async () => {
    const linked = path.join(directory, 'linked'); fs.symlinkSync(source, linked);
    await expect(scanLegacyData({ ...selection(), sourceRoot: linked })).rejects.toThrow('symlink_source_root');
    fs.renameSync(path.join(source, 'agents/agent-a/sessions'), path.join(source, 'real-sessions'));
    fs.symlinkSync(path.join(source, 'real-sessions'), path.join(source, 'agents/agent-a/sessions'));
    const scan = await scanLegacyData(selection()); expect(scan.assets.some(a => a.kind === 'session')).toBe(false); expect(scan.skipped).toContainEqual({ relativePath: 'agents/agent-a/sessions', reason: 'symlink_skipped' });
  });
  it('keeps historical records above the edit limit readable without weakening edit limits', async () => {
    const { CloudRecordService } = await import('../lib/cloud-workspace/records.ts');
    const { CloudWorkspaceService } = await import('../lib/cloud-workspace/service.ts');
    write(sessionPath, JSON.stringify({ type: 'message', message: { role: 'user', content: 'x'.repeat(180 * 1024) } }) + '\n');
    const p = await plan(); await applyLegacyMigration(repository, objects, p);
    const records = new CloudRecordService(new CloudWorkspaceService(store, objects));
    expect(await records.list(actor, workspaceId)).toHaveLength(5);
    const conversation = await records.get(actor, p.assets.find(item => item.kind === 'session')!.fileId);
    expect(conversation.data.messages[0].text).toHaveLength(180 * 1024);
    await expect(records.update(actor, conversation.id, conversation.currentVersion, conversation.data)).rejects.toThrow('record_too_large');
  });
  it('rejects an oversized serialized cloud envelope during planning before any destination writes', async () => {
    write(sessionPath, JSON.stringify({ content: 'x'.repeat(2 * 1024 * 1024 - 100) }) + '\n');
    await expect(plan()).rejects.toThrow('migration_record_too_large');
    expect(fs.existsSync(path.join(directory, 'objects'))).toBe(false);
    expect(store.listFiles(actor, workspaceId)).toEqual([]);
    expect(store.db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'cw_legacy_%'").all()).toEqual([]);
  });
  it('refuses stale source contents before transmitting bytes', async () => {
    const p = await plan(); write(sessionPath, '{"content":"changed"}\n');
    await expect(applyLegacyMigration(repository, objects, p)).rejects.toThrow('source_changed_after_plan');
    expect(fs.existsSync(path.join(directory, 'objects'))).toBe(false); expect(store.listFiles(actor, workspaceId)).toEqual([]);
  });
  it('does not publish partial imports when object writes fail and can reuse immutable orphan objects on retry', async () => {
    const p = await plan(); let calls = 0;
    const failing: ObjectStore = { kind: 'test', get: key => objects.get(key), putImmutable: (key, bytes) => { if (++calls === 2) throw new Error('simulated outage'); return objects.putImmutable(key, bytes); } };
    await expect(applyLegacyMigration(repository, failing, p)).rejects.toThrow('simulated outage');
    expect(store.listFiles(actor, workspaceId)).toEqual([]);
    await expect(applyLegacyMigration(repository, objects, p)).resolves.toMatchObject({ imported: 6 });
  });
  it('never publishes failed readback integrity verification', async () => {
    const p = await plan(); const corrupt: ObjectStore = { kind: 'test', putImmutable: (key, bytes) => objects.putImmutable(key, bytes), get: async () => Buffer.from('corrupt') };
    await expect(applyLegacyMigration(repository, corrupt, p)).rejects.toThrow('migration_object_integrity_error'); expect(store.listFiles(actor, workspaceId)).toEqual([]);
  });
  it('changes source through a new immutable version with stable file ID', async () => {
    const p = await plan(); await applyLegacyMigration(repository, objects, p); const old = await imported(p);
    write(sessionPath, '{"content":"new message"}\n'); const update = await plan(); const next = update.assets.find(a => a.kind === 'session')!;
    expect(next.fileId).toBe(old.item.fileId); expect(next.versionId).not.toBe(old.item.versionId);
    await applyLegacyMigration(repository, objects, update); expect(store.versions(actor, next.fileId)).toHaveLength(2);
    expect((await objects.get(old.item.objectKey)).toString()).toContain('Hello');
    await repository.rollbackMigration(actor, workspaceId, update.batchId); expect(store.file(actor, next.fileId).current_version).toBe(old.item.versionId);
  });
  it('rollback hides only imported heads and preserves immutable history and original source', async () => {
    const p = await plan(); await applyLegacyMigration(repository, objects, p);
    expect(await repository.rollbackMigration(actor, workspaceId, p.batchId)).toEqual({ batchId: p.batchId, rolledBack: 6, preserved: 0 }); expect(store.listFiles(actor, workspaceId)).toEqual([]);
    expect(store.db.prepare('SELECT * FROM cw_versions').all()).toHaveLength(6); expect(fs.readFileSync(path.join(source, sessionPath), 'utf8')).toContain('Hello');
    expect(await repository.rollbackMigration(actor, workspaceId, p.batchId)).toMatchObject({ rolledBack: 6, preserved: 0 }); expect(store.db.prepare('SELECT * FROM cw_legacy_audit').all()).toHaveLength(2);
    await expect(plan()).rejects.toThrow('migration_already_rolled_back_use_new_batch_id');
    const fresh = await plan('11111111-1111-5111-a111-111111111111'); await applyLegacyMigration(repository, objects, fresh); expect(store.listFiles(actor, workspaceId)).toHaveLength(6);
  });
  it('preserves later cloud writes on rollback and changed-source import', async () => {
    const p = await plan(); await applyLegacyMigration(repository, objects, p); const { item } = await imported(p);
    const staged = store.stageVersion(actor, workspaceId, item.name, 1, 'a'.repeat(64), item.fileId, item.versionId); store.finalizeVersion(actor, staged.version.id, item.versionId);
    write(sessionPath, '{"content":"source changed too"}\n'); const update = await plan(); expect(update.assets.find(a => a.kind === 'session')!.action).toBe('conflict');
    await expect(applyLegacyMigration(repository, objects, update)).rejects.toThrow('migration_preserves_later_writes');
    expect(await repository.rollbackMigration(actor, workspaceId, p.batchId)).toMatchObject({ rolledBack: 5, preserved: 1 }); expect(store.file(actor, item.fileId).current_version).toBe(staged.version.id);
  });
  it('deduplicates the same source revision across concurrent explicit batches', async () => {
    const initial = await plan(); await applyLegacyMigration(repository, objects, initial);
    write(sessionPath, '{"content":"revision two"}\n'); const a = await plan('22222222-2222-5222-a222-222222222222'); const b = await plan('33333333-3333-5333-a333-333333333333');
    await applyLegacyMigration(repository, objects, a);
    // Same source content is idempotently unchanged even under a different explicit batch.
    await expect(applyLegacyMigration(repository, objects, b)).resolves.toMatchObject({ imported: 0 });
    expect(store.versions(actor, a.assets.find(i => i.kind === 'session')!.fileId)).toHaveLength(2);
  });
  it('rolls back every metadata write if a late concurrent edit conflicts mid-batch', async () => {
    const first = await plan(); await applyLegacyMigration(repository, objects, first);
    write('aftersales/tasks.json', '{"version":1,"tasks":[{"id":"updated-business"}]}');
    write(sessionPath, '{"content":"changed session"}\n');
    const next = await plan();
    const session = first.assets.find(item => item.kind === 'session')!;
    const staged = store.stageVersion(actor, workspaceId, session.name, 1, 'b'.repeat(64), session.fileId, session.versionId);
    store.finalizeVersion(actor, staged.version.id, session.versionId);
    const beforeVersions = store.db.prepare('SELECT COUNT(*) AS n FROM cw_versions').get().n;
    await expect(applyLegacyMigration(repository, objects, next)).rejects.toThrow('migration_preserves_later_writes');
    const business = first.assets.find(item => item.kind === 'business')!;
    expect(store.file(actor, business.fileId).current_version).toBe(business.versionId);
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM cw_versions').get().n).toBe(beforeVersions);
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM cw_legacy_batches').get().n).toBe(1);
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM cw_legacy_audit').get().n).toBe(1);
  });
  it('rejects mutated plan metadata before any object writes', async () => {
    const p = await plan(); p.items[0].sha256 = '0'.repeat(64);
    await expect(applyLegacyMigration(repository, objects, p)).rejects.toThrow('migration_plan_integrity_error');
    expect(fs.existsSync(path.join(directory, 'objects'))).toBe(false);
  });
  it('protects the audit and migration item history from mutation', async () => {
    await applyLegacyMigration(repository, objects, await plan());
    expect(() => store.db.prepare('DELETE FROM cw_legacy_audit').run()).toThrow('immutable'); expect(() => store.db.prepare("UPDATE cw_legacy_items SET sha256='forged'").run()).toThrow('immutable');
  });
});

describe('migration operator CLI', () => {
  it('dry-runs read-only, applies only the reviewed plan, and rolls back using the recorded batch', async () => {
    const { spawnSync } = await import('node:child_process');
    const common = ['scripts/migrate-cloud-workspace.mjs', '--backend', 'sqlite-local', '--sqlite', path.join(directory, 'metadata.db'), '--workspace-id', workspaceId, '--user-id', actor.userId, '--studio-id', actor.studioId];
    const sourceArgs = ['--source-root', source, '--source-id', 'desktop-one', '--agent', 'agent-a', '--include-shared-state'];
    const run = (args: string[]) => spawnSync(process.execPath, [...common, ...args], { cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test' } });
    const dry = run(sourceArgs); expect(dry.status, dry.stderr).toBe(0); const report = JSON.parse(dry.stdout);
    expect(store.db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'cw_legacy_%'").all()).toEqual([]);
    const blocked = run([...sourceArgs, '--mode', 'apply', '--objects', path.join(directory, 'objects'), '--expected-plan', report.planSha256]); expect(blocked.status).toBe(1); expect(blocked.stderr).toContain('review_plan_and_confirm_source_ownership');
    const mismatch = run([...sourceArgs, '--mode', 'apply', '--objects', path.join(directory, 'objects'), '--expected-plan', '0'.repeat(64), '--ack-source-ownership']); expect(mismatch.status).toBe(1); expect(mismatch.stderr).toContain('reviewed_plan_changed');
    const applied = run([...sourceArgs, '--mode', 'apply', '--objects', path.join(directory, 'objects'), '--expected-plan', report.planSha256, '--ack-source-ownership']); expect(applied.status, applied.stderr).toBe(0); expect(JSON.parse(applied.stdout).imported).toBe(6);
    const rolled = run(['--mode', 'rollback', '--batch-id', report.batchId]); expect(rolled.status, rolled.stderr).toBe(0); expect(JSON.parse(rolled.stdout).rolledBack).toBe(6);
    expect(store.listFiles(actor, workspaceId)).toEqual([]); expect(applied.stdout).not.toContain('Hello');
  });
  it('requires an explicit known backend and an existing destination', async () => {
    const { spawnSync } = await import('node:child_process');
    const run = (args: string[]) => spawnSync(process.execPath, ['scripts/migrate-cloud-workspace.mjs', ...args], { cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test' } });
    expect(run(['--backend', 'guess']).stderr).toContain('invalid_backend_or_mode');
    const result = run(['--backend', 'sqlite-local', '--sqlite', path.join(directory, 'missing.db'), '--workspace-id', workspaceId, '--user-id', actor.userId, '--studio-id', actor.studioId]);
    expect(result.stderr).toContain('destination_database_must_already_exist'); expect(fs.existsSync(path.join(directory, 'missing.db'))).toBe(false);
  });
});
