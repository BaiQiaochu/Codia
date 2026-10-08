import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { PostgresWorkspaceStore } from '../lib/cloud-workspace/postgres-store.ts';
import { PostgresLegacyMigrationRepository } from '../lib/cloud-workspace/postgres-legacy-migration.ts';
import { LocalObjectStore } from '../lib/cloud-workspace/object-store.ts';
import { applyLegacyMigration, planLegacyMigration, scanLegacyData } from '../lib/cloud-workspace/legacy-migration.ts';
import type { CloudActor } from '../lib/cloud-workspace/store.ts';

// Run in the isolated disposable native PostgreSQL helper, never against a customer database.
const connectionString = process.env.CODIA_TEST_POSTGRES_URL;
const suite = connectionString ? describe : describe.skip;
suite('real PostgreSQL legacy migration, non-owner RLS role', () => {
  let admin: Pool, store: PostgresWorkspaceStore, repository: PostgresLegacyMigrationRepository, objects: LocalObjectStore, directory: string;
  const actor: CloudActor = { userId: 'migration-alice', studioId: 'migration-studio' };
  beforeAll(async () => {
    admin = new Pool({ connectionString, max: 4 });
    for (const filename of ['002-workspace-runtime.sql', '003-legacy-migration.sql', '004-cloud-agent-tasks.sql']) await admin.query(fs.readFileSync(new URL(`../lib/cloud-workspace/migrations/${filename}`, import.meta.url), 'utf8'));
    await admin.query(`CREATE ROLE codia_migration_test_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS;
      GRANT USAGE ON SCHEMA codia_workspace TO codia_migration_test_runtime;
      GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA codia_workspace TO codia_migration_test_runtime;
      GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA codia_workspace TO codia_migration_test_runtime;`);
    const pool = { connect: async () => { const client = await admin.connect(); await client.query('SET ROLE codia_migration_test_runtime'); return client; } };
    store = new PostgresWorkspaceStore(pool); repository = new PostgresLegacyMigrationRepository(store.database);
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-legacy-migration-')); objects = new LocalObjectStore(path.join(directory, 'objects'));
    fs.mkdirSync(path.join(directory, 'source/agents/demo/sessions'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'source/agents/demo/sessions/one.jsonl'), '{"type":"message","content":"original legacy content"}\n');
  });
  afterAll(async () => { await admin?.end(); if (directory) fs.rmSync(directory, { recursive: true, force: true }); });
  it('applies 002+003, imports actual bytes, retries, changes source and preserves later writes on rollback', async () => {
    const workspace = await store.createWorkspace(actor, 'Legacy PostgreSQL acceptance');
    const selection = { sourceRoot: path.join(directory, 'source'), sourceId: 'pg-demo', owner: actor, agentIds: ['demo'] };
    const makePlan = async () => planLegacyMigration(actor, workspace.id, await scanLegacyData(selection), await repository.migrationSnapshot(actor, workspace.id, selection.sourceId));
    const original = await makePlan();
    expect(await applyLegacyMigration(repository, objects, original)).toMatchObject({ imported: 2 });
    expect(await applyLegacyMigration(repository, objects, await makePlan())).toMatchObject({ imported: 0, unchanged: 2 });
    const session = original.assets.find(item => item.kind === 'session')!;
    expect((await objects.get((await store.version(actor, session.versionId)).object_key)).toString()).toContain('original legacy content');
    for (const other of [{ ...actor, userId: 'migration-bob' }, { ...actor, studioId: 'other-studio' }]) {
      await expect(repository.migrationSnapshot(other, workspace.id, selection.sourceId)).rejects.toThrow('not_found');
      await expect(repository.rollbackMigration(other, workspace.id, original.batchId)).rejects.toThrow('not_found');
    }
    fs.writeFileSync(path.join(directory, 'source/agents/demo/sessions/one.jsonl'), '{"type":"message","content":"second source revision"}\n');
    const revision = await makePlan(); expect(await applyLegacyMigration(repository, objects, revision)).toMatchObject({ imported: 1, unchanged: 1 });
    const updated = revision.assets.find(item => item.kind === 'session')!; expect(updated.fileId).toBe(session.fileId);
    expect(await repository.rollbackMigration(actor, workspace.id, revision.batchId)).toMatchObject({ rolledBack: 1, preserved: 0 });
    expect((await store.file(actor, session.fileId)).current_version).toBe(session.versionId);
    const bytes = Buffer.from('new cloud write'); const sha256 = createHash('sha256').update(bytes).digest('hex');
    const staged = await store.stageVersion(actor, workspace.id, session.name, bytes.length, sha256, session.fileId, session.versionId);
    await objects.putImmutable(staged.version.object_key, bytes); await store.finalizeVersion(actor, staged.version.id, staged.expected);
    expect(await repository.rollbackMigration(actor, workspace.id, original.batchId)).toMatchObject({ rolledBack: 1, preserved: 1 });
    expect((await store.file(actor, session.fileId)).current_version).toBe(staged.version.id);
    const result = await repository.rollbackMigration(actor, workspace.id, original.batchId); expect(result).toMatchObject({ rolledBack: 1, preserved: 1 });
    await store.database.transaction({ actorId: actor.userId, tenantId: actor.studioId }, async tx => {
      const audit = await tx.query('SELECT * FROM codia_workspace.legacy_audit WHERE workspace_id=$1', [workspace.id]); expect(audit.rows).toHaveLength(4);
      const history = await tx.query('SELECT * FROM codia_workspace.versions WHERE workspace_id=$1', [workspace.id]); expect(history.rows).toHaveLength(4);
    });
    await expect(store.database.transaction({ actorId: actor.userId, tenantId: actor.studioId }, tx => tx.query("UPDATE codia_workspace.legacy_audit SET action='applied' WHERE workspace_id=$1", [workspace.id]))).rejects.toThrow('immutable');
    await store.database.transaction({ actorId: 'migration-bob', tenantId: actor.studioId }, async tx => { expect((await tx.query('SELECT * FROM codia_workspace.legacy_audit')).rows).toEqual([]); });
  });
});
