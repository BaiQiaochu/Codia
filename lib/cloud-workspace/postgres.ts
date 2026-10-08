/** Structural contract compatible with a node-postgres Pool; credentials stay in server configuration. */
export interface PgQueryResult<Row extends Record<string, unknown> = Record<string, unknown>> {
  rows: Row[];
  rowCount: number | null;
}

export interface PgQueryable {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string, values?: unknown[],
  ): Promise<PgQueryResult<Row>>;
}

export interface PgPoolClient extends PgQueryable {
  release(error?: Error | boolean): void;
}

export interface PgPool {
  connect(): Promise<PgPoolClient>;
}

export interface WorkspaceActor {
  tenantId: string;
  actorId: string;
}

function validateContext(context: WorkspaceActor): void {
  for (const value of [context?.tenantId, context?.actorId]) {
    if (typeof value !== "string" || !value.trim() || value.length > 128 || Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
      throw new Error("A validated tenant and actor are required for a PostgreSQL workspace transaction");
    }
  }
}

/**
 * Transaction boundary shared by the PostgreSQL runtime repository and migration
 * adapters. Only trusted server code may choose context or execute SQL here.
 * User-scoped transactions explicitly clear any inherited worker capability.
 */
export class PostgresWorkspaceDatabase {
  readonly kind = "postgres";
  readonly #pool: PgPool;

  constructor(pool: PgPool) {
    this.#pool = pool;
  }

  async transaction<T>(context: WorkspaceActor, work: (transaction: PgQueryable) => Promise<T>): Promise<T> {
    validateContext(context);
    // Capture before awaiting the pool: caller mutation must not switch tenants.
    const { tenantId, actorId } = context;
    const client = await this.#pool.connect();
    let began = false;
    let active = false;
    let discard = false;
    const transaction: PgQueryable = {
      query: async <Row extends Record<string, unknown>>(text: string, values?: unknown[]) => {
        if (!active) throw new Error("Workspace transaction is no longer active");
        return client.query<Row>(text, values);
      },
    };
    try {
      await client.query("BEGIN");
      began = true;
      await client.query("SET LOCAL search_path = pg_catalog");
      // set_config(..., true) is parameterized SET LOCAL, cleared at COMMIT/ROLLBACK.
      await client.query(
        "SELECT set_config('codia.tenant_id', $1, true), set_config('codia.actor_id', $2, true)",
        [tenantId, actorId],
      );
      await client.query("SELECT set_config('codia.trusted_worker', 'off', true)");
      active = true;
      const result = await work(transaction);
      active = false;
      await client.query("COMMIT");
      return result;
    } catch (error) {
      active = false;
      if (began) {
        try { await client.query("ROLLBACK"); } catch { discard = true; }
      } else {
        discard = true;
      }
      throw error;
    } finally {
      active = false;
      // A failed rollback/BEGIN must not return an indeterminate session to the pool.
      client.release(discard || undefined);
    }
  }
}
