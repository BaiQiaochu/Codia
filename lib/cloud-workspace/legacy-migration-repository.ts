import type { CloudActor } from './store.ts';
import { LegacyMigrationError, validateMigrationScope, type LegacyMigrationRepository, type MigrationCommit, type MigrationResult, type MigrationRollback, type MigrationSnapshot } from './legacy-migration.ts';

export type MigrationSqlRow = {
  id?: string; file_id?: string; workspace_id?: string; source_id?: string; source_key?: string;
  imported_version_id?: string | null; current_version?: string | null; sha256?: string | null;
  plan_sha256?: string; state?: 'applied' | 'rolled_back'; version_id?: string;
  previous_version_id?: string | null; previous_imported_version_id?: string | null; previous_sha256?: string | null;
  payload?: string | { rolledBack: number; preserved: number };
};
export type MigrationSqlQuery = { sql: string; values: unknown[]; lock?: boolean };
export type MigrationSqlFlow<T> = Generator<MigrationSqlQuery, T, MigrationSqlRow[]>;
export type MigrationSqlExecutor = <T>(actor: CloudActor, flow: MigrationSqlFlow<T>) => Promise<T>;
const query = (sql: string, values: unknown[] = [], lock = false): MigrationSqlQuery => ({ sql, values, lock });
const scope = (actor: CloudActor, workspaceId: string) => [actor.userId, actor.studioId, workspaceId];
const now = () => new Date().toISOString();
const fail = (code: string): never => { throw new LegacyMigrationError(code); };

/** SQL is static and parameterized. The adapters choose only fixed table names and transaction mechanics. */
export class SqlLegacyMigrationRepository implements LegacyMigrationRepository {
  private readonly execute: MigrationSqlExecutor;
  private readonly scopedFileColumns: boolean;
  constructor(execute: MigrationSqlExecutor, scopedFileColumns: boolean) { this.execute = execute; this.scopedFileColumns = scopedFileColumns; }
  async migrationSnapshot(actor: CloudActor, workspaceId: string, sourceId: string): Promise<MigrationSnapshot> {
    validateMigrationScope(actor, workspaceId, sourceId);
    const owner = { ...actor };
    return this.execute(owner, this.snapshot(owner, workspaceId, sourceId));
  }
  private *workspace(actor: CloudActor, workspaceId: string, lock = false): MigrationSqlFlow<void> {
    const rows = yield query('SELECT id FROM @workspaces WHERE owner_user=? AND studio_id=? AND id=?', scope(actor, workspaceId), lock);
    if (!rows.length) fail('not_found');
  }
  private *snapshot(actor: CloudActor, workspaceId: string, sourceId: string): MigrationSqlFlow<MigrationSnapshot> {
    yield* this.workspace(actor, workspaceId);
    const items = yield query('SELECT m.source_key,m.file_id,m.imported_version_id,m.sha256,f.current_version FROM @legacy_sources m JOIN @files f ON f.id=m.file_id WHERE m.owner_user=? AND m.studio_id=? AND m.workspace_id=? AND m.source_id=? ORDER BY m.source_key', [...scope(actor, workspaceId), sourceId]);
    const batches = yield query('SELECT id,plan_sha256,state FROM @legacy_batches WHERE owner_user=? AND studio_id=? AND workspace_id=? AND source_id=? ORDER BY created_at,id', [...scope(actor, workspaceId), sourceId]);
    return { items: items.map(r => ({ sourceKey: r.source_key, fileId: r.file_id, currentVersionId: r.current_version, importedVersionId: r.imported_version_id, sha256: r.sha256 })), batches: batches.map(r => ({ id: r.id, planSha256: r.plan_sha256, state: r.state })) };
  }
  async commitMigration(actor: CloudActor, input: MigrationCommit): Promise<MigrationResult> {
    validateMigrationScope(actor, input.workspaceId, input.sourceId);
    if (!/^[a-f0-9]{64}$/.test(input.planSha256) || !input.items.length || input.items.length > 10001 || new Set(input.items.map(item => item.sourceKey)).size !== input.items.length) fail('invalid_migration_commit');
    const owner = { ...actor }, commit = { ...input, items: input.items.map(item => ({ ...item })) };
    return this.execute(owner, this.commit(owner, commit));
  }
  private *commit(actor: CloudActor, input: MigrationCommit): MigrationSqlFlow<MigrationResult> {
    const { workspaceId, sourceId, batchId, planSha256 } = input;
    const scoped = scope(actor, workspaceId);
    yield* this.workspace(actor, workspaceId, true);
    const oldBatch = (yield query('SELECT * FROM @legacy_batches WHERE owner_user=? AND studio_id=? AND workspace_id=? AND id=?', [...scoped, batchId]))[0];
    if (oldBatch) {
      if (oldBatch.plan_sha256 !== planSha256 || oldBatch.source_id !== sourceId) fail('migration_idempotency_conflict');
      if (oldBatch.state !== 'applied') fail('migration_already_rolled_back_use_new_batch_id');
      return { batchId, state: 'applied', imported: 0, unchanged: input.items.length };
    }
    const created = now();
    yield query('INSERT INTO @legacy_batches (id,owner_user,studio_id,workspace_id,source_id,plan_sha256,state,created_at) VALUES (?,?,?,?,?,?,?,?)', [batchId, ...scoped, sourceId, planSha256, 'applied', created]);
    let imported = 0, unchanged = 0;
    for (const item of input.items) {
      const mapping = (yield query('SELECT * FROM @legacy_sources WHERE owner_user=? AND studio_id=? AND workspace_id=? AND source_id=? AND source_key=?', [...scoped, sourceId, item.sourceKey], true))[0];
      if (mapping && mapping.file_id !== item.fileId) fail('migration_mapping_conflict');
      if (mapping?.sha256 === item.sha256 && mapping.imported_version_id) { unchanged++; continue; }
      if ((mapping?.imported_version_id ?? null) !== item.expectedImportedVersionId) fail('migration_version_conflict');
      const file = (yield query('SELECT * FROM @files WHERE id=?', [item.fileId], true))[0];
      if (file && (!mapping || file.workspace_id !== workspaceId)) fail('migration_file_collision');
      if ((file?.current_version ?? null) !== item.expectedVersionId || item.expectedVersionId !== item.expectedImportedVersionId) fail('migration_preserves_later_writes');
      if (!file) {
        yield query(this.scopedFileColumns ? 'INSERT INTO @files(id,workspace_id,owner_user,studio_id,name,current_version,created_at) VALUES(?,?,?,?,?,?,?)' : 'INSERT INTO @files(id,workspace_id,name,current_version,created_at) VALUES(?,?,?,?,?)', this.scopedFileColumns ? [item.fileId, workspaceId, actor.userId, actor.studioId, item.name, null, created] : [item.fileId, workspaceId, item.name, null, created]);
      }
      yield query(this.scopedFileColumns ? 'INSERT INTO @versions(id,file_id,workspace_id,owner_user,studio_id,object_key,size,sha256,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)' : 'INSERT INTO @versions(id,file_id,object_key,size,sha256,status,created_at) VALUES(?,?,?,?,?,?,?)', this.scopedFileColumns ? [item.versionId, item.fileId, workspaceId, actor.userId, actor.studioId, item.objectKey, item.size, item.sha256, 'ready', created] : [item.versionId, item.fileId, item.objectKey, item.size, item.sha256, 'ready', created]);
      const updated = yield query('UPDATE @files SET current_version=? WHERE id=? AND current_version IS NOT DISTINCT FROM ? RETURNING id', [item.versionId, item.fileId, item.expectedVersionId]);
      if (updated.length !== 1) fail('migration_version_conflict');
      yield query('INSERT INTO @legacy_items(owner_user,studio_id,workspace_id,batch_id,source_id,source_key,file_id,version_id,previous_version_id,previous_imported_version_id,previous_sha256,sha256) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', [...scoped, batchId, sourceId, item.sourceKey, item.fileId, item.versionId, item.expectedVersionId, mapping?.imported_version_id ?? null, mapping?.sha256 ?? null, item.sha256]);
      if (mapping) yield query('UPDATE @legacy_sources SET imported_version_id=?,sha256=? WHERE owner_user=? AND studio_id=? AND workspace_id=? AND source_id=? AND source_key=?', [item.versionId, item.sha256, ...scoped, sourceId, item.sourceKey]);
      else yield query('INSERT INTO @legacy_sources(owner_user,studio_id,workspace_id,source_id,source_key,file_id,imported_version_id,sha256) VALUES(?,?,?,?,?,?,?,?)', [...scoped, sourceId, item.sourceKey, item.fileId, item.versionId, item.sha256]);
      imported++;
    }
    yield query('INSERT INTO @legacy_audit(owner_user,studio_id,workspace_id,batch_id,action,payload,created_at) VALUES(?,?,?,?,?,?,?)', [...scoped, batchId, 'applied', JSON.stringify({ imported, unchanged, planSha256 }), created]);
    return { batchId, state: 'applied', imported, unchanged };
  }
  async rollbackMigration(actor: CloudActor, workspaceId: string, batchId: string): Promise<MigrationRollback> {
    validateMigrationScope(actor, workspaceId);
    const owner = { ...actor };
    return this.execute(owner, this.rollback(owner, workspaceId, batchId));
  }
  private *rollback(actor: CloudActor, workspaceId: string, batchId: string): MigrationSqlFlow<MigrationRollback> {
    const scoped = scope(actor, workspaceId);
    yield* this.workspace(actor, workspaceId, true);
    const batch = (yield query('SELECT * FROM @legacy_batches WHERE owner_user=? AND studio_id=? AND workspace_id=? AND id=?', [...scoped, batchId], true))[0];
    if (!batch) fail('not_found');
    if (batch.state === 'rolled_back') {
      const audit = (yield query('SELECT payload FROM @legacy_audit WHERE owner_user=? AND studio_id=? AND workspace_id=? AND batch_id=? AND action=?', [...scoped, batchId, 'rolled_back']))[0];
      const result = typeof audit.payload === 'string' ? JSON.parse(audit.payload) : audit.payload;
      return { batchId, rolledBack: result.rolledBack, preserved: result.preserved };
    }
    const items = yield query('SELECT * FROM @legacy_items WHERE owner_user=? AND studio_id=? AND workspace_id=? AND batch_id=? ORDER BY source_key', [...scoped, batchId]);
    let rolledBack = 0, preserved = 0;
    for (const item of items) {
      const file = (yield query('SELECT current_version FROM @files WHERE id=?', [item.file_id], true))[0];
      const mapping = (yield query('SELECT imported_version_id FROM @legacy_sources WHERE owner_user=? AND studio_id=? AND workspace_id=? AND source_id=? AND source_key=?', [...scoped, item.source_id, item.source_key], true))[0];
      if (!file || file.current_version !== item.version_id || mapping?.imported_version_id !== item.version_id) { preserved++; continue; }
      const changed = yield query('UPDATE @files SET current_version=? WHERE id=? AND current_version=? RETURNING id', [item.previous_version_id, item.file_id, item.version_id]);
      if (changed.length !== 1) { preserved++; continue; }
      yield query('UPDATE @legacy_sources SET imported_version_id=?,sha256=? WHERE owner_user=? AND studio_id=? AND workspace_id=? AND source_id=? AND source_key=?', [item.previous_imported_version_id, item.previous_sha256, ...scoped, item.source_id, item.source_key]);
      rolledBack++;
    }
    yield query('UPDATE @legacy_batches SET state=? WHERE owner_user=? AND studio_id=? AND workspace_id=? AND id=?', ['rolled_back', ...scoped, batchId]);
    yield query('INSERT INTO @legacy_audit(owner_user,studio_id,workspace_id,batch_id,action,payload,created_at) VALUES(?,?,?,?,?,?,?)', [...scoped, batchId, 'rolled_back', JSON.stringify({ rolledBack, preserved }), now()]);
    return { batchId, rolledBack, preserved };
  }
}
