#!/usr/bin/env node
/** Explicit operator-only import. Never accepts a remote request's source path or guessed identity. */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadBetterSqliteDatabase } from '../core/session-manifest/store.ts';
import { CloudWorkspaceStore, CloudWorkspaceError } from '../lib/cloud-workspace/store.ts';
import { LocalObjectStore } from '../lib/cloud-workspace/object-store.ts';
import { createCloudWorkspaceRuntime } from '../lib/cloud-workspace/config.ts';
import { PostgresLegacyMigrationRepository } from '../lib/cloud-workspace/postgres-legacy-migration.ts';
import { SqliteLegacyMigrationRepository } from '../lib/cloud-workspace/sqlite-legacy-migration.ts';
import { scanLegacyData, planLegacyMigration, migrationPlanSummary, applyLegacyMigration, LegacyMigrationError } from '../lib/cloud-workspace/legacy-migration.ts';

const help = `Usage: node scripts/migrate-cloud-workspace.mjs --backend sqlite-local|postgres
  --mode dry-run|apply|rollback --workspace-id UUID --user-id USER --studio-id STUDIO
  [--sqlite PATH --objects PATH]  Explicit existing local-development destination
  [--source-root ABSOLUTE_PATH --source-id STABLE_ID --agent AGENT_ID ...]
  [--include-shared-state]        Include reviewed shared business/workflow stores
  [--batch-id UUID]               Required for rollback; new ID after a prior rollback
  [--expected-plan SHA256 --ack-source-ownership]  Required for apply

Defaults to dry-run. PostgreSQL/S3 use existing CODIA_CLOUD_* server configuration.
Dry-run outputs metadata only; review skipped files and the planSha256 before apply.
Source records are never modified. Import snapshots do not resume legacy executors.
This operator-only Linux command must not be exposed as an HTTP/renderer endpoint.
`;
let close = async () => {};
try {
  const { values: args } = parseArgs({ options: {
    help: { type: 'boolean' }, backend: { type: 'string' }, mode: { type: 'string', default: 'dry-run' },
    'workspace-id': { type: 'string' }, 'user-id': { type: 'string' }, 'studio-id': { type: 'string' },
    sqlite: { type: 'string' }, objects: { type: 'string' }, 'source-root': { type: 'string' }, 'source-id': { type: 'string' },
    agent: { type: 'string', multiple: true, default: [] }, 'include-shared-state': { type: 'boolean', default: false },
    'batch-id': { type: 'string' }, 'expected-plan': { type: 'string' }, 'ack-source-ownership': { type: 'boolean', default: false },
  }, strict: true, allowPositionals: false });
  if (args.help) { process.stdout.write(help); process.exit(0); }
  const required = name => { if (!args[name]) throw new LegacyMigrationError(`missing_${name.replaceAll('-', '_')}`); return args[name]; };
  const backend = required('backend'), mode = args.mode;
  if (!['sqlite-local', 'postgres'].includes(backend) || !['dry-run', 'apply', 'rollback'].includes(mode)) throw new LegacyMigrationError('invalid_backend_or_mode');
  const actor = { userId: required('user-id'), studioId: required('studio-id') }, workspaceId = required('workspace-id');
  if (mode === 'apply' && (!args['ack-source-ownership'] || !/^[a-f0-9]{64}$/.test(required('expected-plan')))) throw new LegacyMigrationError('review_plan_and_confirm_source_ownership');
  let repository, objects;
  if (backend === 'sqlite-local') {
    if (process.env.CODIA_CLOUD_MODE === 'production') throw new LegacyMigrationError('local_migration_disabled_in_production');
    const databasePath = path.resolve(required('sqlite'));
    if (!fs.existsSync(databasePath)) throw new LegacyMigrationError('destination_database_must_already_exist');
    if (mode === 'dry-run') {
      const Database = loadBetterSqliteDatabase(), db = new Database(databasePath, { readonly: true, fileMustExist: true });
      repository = new SqliteLegacyMigrationRepository({ db, transaction: fn => db.transaction(fn)(), workspace: (who, id) => {
        const row = db.prepare('SELECT * FROM cw_workspaces WHERE owner_user=? AND studio_id=? AND id=?').get(who.userId, who.studioId, id);
        if (!row) throw new CloudWorkspaceError('not_found', 404); return row;
      } });
      close = async () => db.close();
    } else {
      const store = new CloudWorkspaceStore(databasePath); repository = new SqliteLegacyMigrationRepository(store); close = async () => store.close();
      if (mode === 'apply') objects = new LocalObjectStore(path.resolve(required('objects')));
    }
  } else {
    if (args.sqlite || args.objects) throw new LegacyMigrationError('local_options_not_valid_for_postgres');
    const runtime = await createCloudWorkspaceRuntime({ localDirectory: process.cwd(), env: { ...process.env, CODIA_CLOUD_DATABASE: 'postgres', CODIA_CLOUD_OBJECT_STORE: 's3' } });
    close = () => runtime.close();
    repository = new PostgresLegacyMigrationRepository(runtime.store.database); objects = runtime.objects;
  }
  if (mode === 'rollback') {
    process.stdout.write(`${JSON.stringify(await repository.rollbackMigration(actor, workspaceId, required('batch-id')), null, 2)}\n`);
  } else {
    // Authorization is checked before opening legacy source files.
    const sourceId = required('source-id');
    const snapshot = await repository.migrationSnapshot(actor, workspaceId, sourceId);
    const scan = await scanLegacyData({ sourceRoot: required('source-root'), sourceId, owner: actor, agentIds: args.agent, includeSharedState: args['include-shared-state'] });
    const plan = planLegacyMigration(actor, workspaceId, scan, snapshot, args['batch-id']);
    if (mode === 'dry-run') process.stdout.write(`${JSON.stringify(migrationPlanSummary(plan), null, 2)}\n`);
    else {
      if (plan.planSha256 !== args['expected-plan']) throw new LegacyMigrationError('reviewed_plan_changed_run_dry_run_again');
      const result = await applyLegacyMigration(repository, objects, plan);
      process.stdout.write(`${JSON.stringify({ ...result, skipped: plan.skipped, planSha256: plan.planSha256, execution: 'legacy-executors-not-resumed' }, null, 2)}\n`);
    }
  }
} catch (error) {
  // Never print raw SQL/transport errors, stack traces, record contents or environment values.
  const code = error instanceof LegacyMigrationError || error instanceof CloudWorkspaceError ? error.code : 'migration_failed_check_configuration_source_and_schema';
  process.stderr.write(`${JSON.stringify({ error: code })}\n`); process.exitCode = 1;
} finally {
  try { await close(); } catch { process.stderr.write(`${JSON.stringify({ error: 'migration_connection_close_failed' })}\n`); process.exitCode = 1; }
}
