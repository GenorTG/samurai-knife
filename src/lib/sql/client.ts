import type { SqlAction, SqlActionMap, SqlResponse } from "./types";

/** Browser-side wrapper over `POST /api/sql`. Never throws: network and parse failures become `{ ok: false, error }`. */
export async function callSql<A extends SqlAction>(action: A, params: SqlActionMap[A]["in"]): Promise<SqlResponse<A>> {
  try {
    const response = await fetch("/api/sql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, params }),
    });
    const body = (await response.json().catch(() => null)) as SqlResponse<A> | null;
    if (body && typeof body === "object" && "ok" in body) return body;
    return { ok: false, error: `SQL engine returned HTTP ${response.status} without a result.` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not reach the SQL engine." };
  }
}
