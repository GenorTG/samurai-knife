import type { Pool } from "pg";
import {
  CoreConflictError,
  type CommitResult,
  type CoreBatch,
  type CoreLoad,
  type CoreRepo,
  type McpKeyRecord,
  type SessionRecord,
  type StoredAccount,
} from "@/lib/db/core/types";

/**
 * Postgres implementation of CoreRepo (schema: db/migrations/0001_core.sql). Both calls are ONE prepared statement
 * (named queries: parsed and planned once per connection), so a load or a commit costs exactly one round trip to the
 * primary however many rows it carries: the batch travels as one jsonb parameter into knife_apply_core(), which runs as a
 * single statement, i.e. one implicit transaction (synchronous_commit stays on: the answer means durable on the primary).
 */

const LOAD = { name: "knife_load_core_v1", text: "SELECT knife_load_core() AS core" } as const;
const COMMIT = "knife_apply_core_v1";
const COMMIT_SQL = "SELECT knife_apply_core($1::jsonb) AS result";

interface LoadRow {
  core: {
    defaultAccountId: string | null;
    accounts: StoredAccount[];
    sessions: SessionRecord[];
    keys: (McpKeyRecord & { scope: McpKeyRecord["scope"] | null })[];
  };
}

/** Postgres error with a SQLSTATE (node-postgres DatabaseError). */
function sqlState(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof (error as { code: unknown }).code === "string"
    ? (error as { code: string }).code
    : undefined;
}

export class PgCoreRepo implements CoreRepo {
  readonly kind = "pg" as const;

  private readonly pool: Pool;
  private readonly ownsPool: boolean;

  constructor(pool: Pool, ownsPool = false) {
    this.pool = pool;
    this.ownsPool = ownsPool;
  }

  async load(): Promise<CoreLoad> {
    const { rows } = await this.pool.query<LoadRow>(LOAD);
    const core = rows[0].core;
    return {
      defaultAccountId: core.defaultAccountId,
      legacyV1: false,
      accounts: core.accounts,
      sessions: core.sessions,
      // A key stored without scope reads back as null; the file format leaves the field out.
      keys: core.keys.map(({ scope, ...key }) => (scope ? { ...key, scope } : key)),
    };
  }

  async commit(batch: CoreBatch): Promise<CommitResult> {
    try {
      const { rows } = await this.pool.query<{ result: CommitResult }>({ name: COMMIT, text: COMMIT_SQL, values: [JSON.stringify(batch)] });
      return rows[0].result;
    } catch (error) {
      if (sqlState(error) === "40001") throw new CoreConflictError(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }
}

/** Runs the prepared statements once on `count` pool connections so the first real requests skip parse/plan. */
export async function warmPool(pool: Pool, count: number): Promise<void> {
  const clients = await Promise.all(Array.from({ length: count }, () => pool.connect()));
  try {
    await Promise.all(clients.map(async (client) => {
      await client.query(LOAD);
      await client.query({ name: COMMIT, text: COMMIT_SQL, values: [JSON.stringify({ origin: "warm-up" })] });
    }));
  } finally {
    for (const client of clients) client.release();
  }
}
