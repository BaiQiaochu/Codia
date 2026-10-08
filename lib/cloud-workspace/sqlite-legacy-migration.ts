import type { CloudActor, CloudWorkspaceStore } from './store.ts';
import { LegacyMigrationError, validateMigrationScope, type MigrationCommit, type MigrationSnapshot } from './legacy-migration.ts';
import { SqlLegacyMigrationRepository, type MigrationSqlFlow, type MigrationSqlQuery } from './legacy-migration-repository.ts';

const schema = `
CREATE TABLE IF NOT EXISTS cw_legacy_batches (
 id TEXT NOT NULL,owner_user TEXT NOT NULL,studio_id TEXT NOT NULL,workspace_id TEXT NOT NULL REFERENCES cw_workspaces(id),source_id TEXT NOT NULL,plan_sha256 TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('applied','rolled_back')),created_at TEXT NOT NULL,
 PRIMARY KEY(owner_user,studio_id,workspace_id,id));
CREATE TABLE IF NOT EXISTS cw_legacy_sources (
 owner_user TEXT NOT NULL,studio_id TEXT NOT NULL,workspace_id TEXT NOT NULL REFERENCES cw_workspaces(id),source_id TEXT NOT NULL,source_key TEXT NOT NULL,file_id TEXT NOT NULL REFERENCES cw_files(id),imported_version_id TEXT REFERENCES cw_versions(id),sha256 TEXT,
 PRIMARY KEY(owner_user,studio_id,workspace_id,source_id,source_key));
CREATE TABLE IF NOT EXISTS cw_legacy_items (
 owner_user TEXT NOT NULL,studio_id TEXT NOT NULL,workspace_id TEXT NOT NULL,batch_id TEXT NOT NULL,source_id TEXT NOT NULL,source_key TEXT NOT NULL,file_id TEXT NOT NULL REFERENCES cw_files(id),version_id TEXT NOT NULL REFERENCES cw_versions(id),previous_version_id TEXT REFERENCES cw_versions(id),previous_imported_version_id TEXT REFERENCES cw_versions(id),previous_sha256 TEXT,sha256 TEXT NOT NULL,
 PRIMARY KEY(owner_user,studio_id,workspace_id,batch_id,source_key),
 FOREIGN KEY(owner_user,studio_id,workspace_id,batch_id) REFERENCES cw_legacy_batches(owner_user,studio_id,workspace_id,id));
CREATE TABLE IF NOT EXISTS cw_legacy_audit (
 owner_user TEXT NOT NULL,studio_id TEXT NOT NULL,workspace_id TEXT NOT NULL,batch_id TEXT NOT NULL,action TEXT NOT NULL CHECK(action IN ('applied','rolled_back')),payload TEXT NOT NULL,created_at TEXT NOT NULL,
 PRIMARY KEY(owner_user,studio_id,workspace_id,batch_id,action),
 FOREIGN KEY(owner_user,studio_id,workspace_id,batch_id) REFERENCES cw_legacy_batches(owner_user,studio_id,workspace_id,id));
CREATE TRIGGER IF NOT EXISTS cw_legacy_audit_no_update BEFORE UPDATE ON cw_legacy_audit BEGIN SELECT RAISE(ABORT,'Migration audit is immutable'); END;
CREATE TRIGGER IF NOT EXISTS cw_legacy_audit_no_delete BEFORE DELETE ON cw_legacy_audit BEGIN SELECT RAISE(ABORT,'Migration audit is immutable'); END;
CREATE TRIGGER IF NOT EXISTS cw_legacy_items_no_update BEFORE UPDATE ON cw_legacy_items BEGIN SELECT RAISE(ABORT,'Migration history is immutable'); END;
CREATE TRIGGER IF NOT EXISTS cw_legacy_items_no_delete BEFORE DELETE ON cw_legacy_items BEGIN SELECT RAISE(ABORT,'Migration history is immutable'); END;
`;
/** Local-development adapter. Construction and dry-run snapshots never create migration tables. */
export class SqliteLegacyMigrationRepository extends SqlLegacyMigrationRepository {
  private readonly store: Pick<CloudWorkspaceStore, 'db' | 'workspace' | 'transaction'>;
  constructor(store: Pick<CloudWorkspaceStore, 'db' | 'workspace' | 'transaction'>) {
    const execute = async <T>(actor: CloudActor, flow: MigrationSqlFlow<T>): Promise<T> => store.transaction(() => {
      // No await inside better-sqlite3's transaction callback.
      let next = flow.next();
      while (!next.done) {
        const instruction = next.value as MigrationSqlQuery;
        const statement = store.db.prepare(instruction.sql.replace(/@([a-z_]+)/g, 'cw_$1'));
        const rows = statement.reader ? statement.all(...instruction.values) : (statement.run(...instruction.values), []);
        next = flow.next(rows);
      }
      return next.value;
    });
    super(execute, false);
    this.store = store;
  }
  private hasSchema(): boolean { return !!this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='cw_legacy_batches'").get(); }
  override async migrationSnapshot(actor: CloudActor, workspaceId: string, sourceId: string): Promise<MigrationSnapshot> {
    validateMigrationScope(actor, workspaceId, sourceId);
    if (!this.hasSchema()) { this.store.workspace(actor, workspaceId); return { items: [], batches: [] }; }
    return super.migrationSnapshot(actor, workspaceId, sourceId);
  }
  override async commitMigration(actor: CloudActor, input: MigrationCommit) {
    // Validate ownership before any DDL. Tables are local operational metadata only.
    validateMigrationScope(actor, input.workspaceId, input.sourceId);
    this.store.workspace(actor, input.workspaceId);
    this.store.db.exec(schema);
    return super.commitMigration(actor, input);
  }
  override async rollbackMigration(actor: CloudActor, workspaceId: string, batchId: string) {
    validateMigrationScope(actor, workspaceId);
    this.store.workspace(actor, workspaceId);
    if (!this.hasSchema()) throw new LegacyMigrationError('not_found');
    return super.rollbackMigration(actor, workspaceId, batchId);
  }
}
