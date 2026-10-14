import { runPythonScript } from "@/lib/python";
import type { SqlAction, SqlActionMap, SqlResponse } from "./types";

/**
 * Server-side entry to the sqlglot engine (`server/py/scripts/sql_tool.py`), shared by `POST /api/sql`
 * and the `knife_sql_*` tools. One-shot Python process per call; no state, no database connection.
 */
export async function runSql<A extends SqlAction>(
  action: A,
  params: SqlActionMap[A]["in"],
  signal?: AbortSignal,
): Promise<SqlResponse<A>> {
  // `light` lane (never waits behind pdf work); throws QueueFullError when that lane is saturated.
  const result = await runPythonScript<SqlActionMap[A]["out"]>("sql_tool.py", { action, params }, { timeoutMs: 30_000, lane: "light", signal, label: `sql:${action}` });
  if (!result.ok || result.data === undefined) return { ok: false, error: result.error ?? "SQL engine failed." };
  return { ok: true, data: result.data };
}
