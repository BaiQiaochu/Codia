import type { PostgresWorkspaceDatabase } from './postgres.ts';
import { SqlLegacyMigrationRepository, type MigrationSqlFlow, type MigrationSqlQuery } from './legacy-migration-repository.ts';
import type { CloudActor } from './store.ts';

/** Requires explicitly applied 002 + 003 schemas. Never provisions tables, roles, grants, or credentials. */
export class PostgresLegacyMigrationRepository extends SqlLegacyMigrationRepository {
  constructor(database: PostgresWorkspaceDatabase) {
    super(async <T>(actor: CloudActor, flow: MigrationSqlFlow<T>): Promise<T> => database.transaction({ actorId: actor.userId, tenantId: actor.studioId }, async tx => {
      await tx.query("SELECT set_config('codia.trusted_worker','off',true)");
      await tx.query("SET LOCAL statement_timeout = '30s'");
      await tx.query("SET LOCAL lock_timeout = '10s'");
      let next = flow.next();
      while (!next.done) {
        const instruction = next.value as MigrationSqlQuery;
        let parameter = 0;
        const sql = instruction.sql.replace(/@([a-z_]+)/g, 'codia_workspace.$1').replace(/\?/g, () => `$${++parameter}`) + (instruction.lock ? ' FOR UPDATE' : '');
        const result = await tx.query(sql, instruction.values);
        next = flow.next(result.rows);
      }
      return next.value;
    }), true);
  }
}
