import * as z from "zod/v4";
import { authenticate, json, jsonError, readJsonBody } from "@/lib/accounts/http";
import { queueFullOrNull } from "@/lib/queue-http";
import { runSql } from "@/lib/sql/engine";
import { SQL_ACTIONS } from "@/lib/sql/types";
import { msg } from "@/lib/i18n/msg";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  action: z.enum(SQL_ACTIONS),
  params: z.record(z.string(), z.unknown()),
}).strict();

/** POST /api/sql { action, params } -> { ok, data | error }. Parameter/result shapes: `src/lib/sql/types.ts`. */
export async function POST(request: Request): Promise<Response> {
  const auth = authenticate(request, true);
  if ("response" in auth) return auth.response;

  const read = await readJsonBody(request, 1024 * 1024);
  if ("response" in read) return read.response;
  const parsed = bodySchema.safeParse(read.body);
  if (!parsed.success) return jsonError(msg("Expected { action, params }."), 400, { ok: false });

  // The engine validates per-action params; the cast keeps this route generic over actions.
  try {
    const result = await runSql(parsed.data.action, parsed.data.params as never, request.signal, auth.account.id);
    return json(result, result.ok ? 200 : 422);
  } catch (error) {
    const full = queueFullOrNull(error);
    if (full) return full;
    throw error;
  }
}
