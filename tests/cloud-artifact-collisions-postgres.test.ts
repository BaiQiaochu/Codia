import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PostgresWorkspaceStore } from '../lib/cloud-workspace/postgres-store.ts';
import { CloudWorkspaceService } from '../lib/cloud-workspace/service.ts';
import { LocalObjectStore } from '../lib/cloud-workspace/object-store.ts';
import { uploadHash } from '../lib/cloud-workspace/uploads.ts';
import { artifactCollisionContract } from './helpers/cloud-artifact-contract.ts';
const url = process.env.CODIA_TEST_POSTGRES_URL;
const database = `codia_artifacts_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
let bootstrap: Pool, admin: Pool, pool: Pool, service: CloudWorkspaceService, root: string;
const errors: string[] = [];
const watch = (value: Pool) => { value.on('error', error => errors.push(error.message)); return value; };
(url ? describe : describe.skip)('Native PostgreSQL result filename collision recovery', () => {
  beforeAll(async () => {
    const parsed = new URL(url!);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || !parsed.pathname.startsWith('/codia_')) throw new Error('Requires an isolated loopback codia_ database');
    bootstrap = watch(new Pool({ connectionString: url })); await bootstrap.query(`CREATE DATABASE ${database}`);
    parsed.pathname = `/${database}`; admin = watch(new Pool({ connectionString: parsed.toString() }));
    for (const name of ['002-workspace-runtime.sql', '004-cloud-agent-tasks.sql', '005-resumable-uploads.sql']) await admin.query(await readFile(new URL(`../lib/cloud-workspace/migrations/${name}`, import.meta.url), 'utf8'));
    await admin.query('GRANT USAGE ON SCHEMA codia_workspace TO pg_database_owner; GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA codia_workspace TO pg_database_owner; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA codia_workspace TO pg_database_owner');
    pool = watch(new Pool({ connectionString: parsed.toString(), options: '-c role=pg_database_owner', max: 8 }));
    expect((await pool.query('SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0]).toMatchObject({ current_user: 'pg_database_owner', rolsuper: false, rolbypassrls: false });
    root = await mkdtemp(path.join(os.tmpdir(), 'codia-artifact-pg-'));
    service = new CloudWorkspaceService(new PostgresWorkspaceStore(pool), new LocalObjectStore(root));
  });
  beforeEach(async () => { await admin.query('TRUNCATE codia_workspace.workspaces CASCADE'); });
  afterAll(async () => {
    await pool?.end(); await admin?.end(); if (root) await rm(root, { recursive: true, force: true });
    if (bootstrap) {
      try {
        const deadline = Date.now() + 5000;
        while (Number((await bootstrap.query('SELECT count(*) AS count FROM pg_stat_activity WHERE datname=$1', [database])).rows[0].count) !== 0) {
          if (Date.now() > deadline) throw new Error('Fixture clients did not close');
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        await bootstrap.query(`DROP DATABASE IF EXISTS ${database}`);
      } finally { await bootstrap.end(); }
    }
    expect(errors).toEqual([]);
  });
  artifactCollisionContract(() => ({ service }));
  it('allocates another result name after a concurrent user upload commits first', async () => {
    const actor = { userId: 'race-owner', studioId: 'race-studio' };
    const workspace = await service.store.createWorkspace(actor, 'Concurrent publication');
    const input = await service.upload(actor, workspace.id, 'input.txt', Buffer.from('synthetic input'));
    const queued = await service.store.createRun(actor, workspace.id, input.version.id, randomUUID());
    const claimed = (await service.store.claim())!;
    expect(claimed.id).toBe(queued.id);
    const name = `检查结果-${queued.id}.md`, original = Buffer.from('Original concurrent user upload');
    const fileId = randomUUID(), versionId = randomUUID(), objectKey = `fixtures/${fileId}/${versionId}`;
    await service.objects.putImmutable(objectKey, original);
    const result = Buffer.from('Successful independent result'), resultKey = `fixtures/${queued.id}/result`;
    await service.objects.putImmutable(resultKey, result);
    const writer = await admin.connect();
    let completion: ReturnType<typeof service.store.complete> | undefined;
    try {
      // The user upload owns the unique filename but has not committed yet.
      // Actual PostgreSQL constraint locking, not a mocked conflict response.
      await writer.query('BEGIN');
      await writer.query('INSERT INTO codia_workspace.files(id,workspace_id,owner_user,studio_id,name,current_version) VALUES($1,$2,$3,$4,$5,$6)', [fileId, workspace.id, actor.userId, actor.studioId, name, versionId]);
      await writer.query("INSERT INTO codia_workspace.versions(id,file_id,workspace_id,owner_user,studio_id,object_key,size,sha256,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'ready')", [versionId, fileId, workspace.id, actor.userId, actor.studioId, objectKey, original.length, uploadHash(original)]);
      completion = service.store.complete(claimed, { objectKey: resultKey, size: result.length, sha256: uploadHash(result) });
      // Attach the observer before waiting; a regression cannot emit an
      // unhandled rejection after the writer releases the constraint lock.
      void completion.catch(() => {});
      const deadline = Date.now() + 3000;
      while (!(await admin.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'INSERT INTO codia_workspace.files%'")).rowCount) {
        if (Date.now() >= deadline) throw new Error('Artifact publication did not reach the filename lock');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      await writer.query('COMMIT');
      const saved = await completion;
      expect((await service.read(actor, saved.versionId)).bytes).toEqual(result);
      expect((await service.store.file(actor, saved.fileId)).name).not.toBe(name);
      expect((await service.read(actor, versionId)).bytes).toEqual(original);
      expect((await service.store.file(actor, fileId)).current_version).toBe(versionId);
      const detail = await service.store.run(actor, queued.id);
      expect(detail.run.status).toBe('succeeded'); expect(detail.artifacts).toHaveLength(1);
      expect((await service.store.run(actor, queued.id)).artifacts).toEqual(detail.artifacts);
    } finally {
      await writer.query('ROLLBACK'); writer.release();
      await completion?.catch(() => {});
    }
  });

});
