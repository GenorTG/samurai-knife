import * as z from "zod/v4";
import { authenticate, json, jsonError, readJsonBody } from "@/lib/accounts/http";
import { requireAdmin } from "@/lib/accounts/authz";
import { touch } from "@/lib/services/manager";
import { learnError } from "@/lib/learn/sql/api";
import { ensureSeeded, SERVICE_ID, sidecarConnection } from "@/lib/learn/sql/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({ force: z.boolean().optional() }).strict();

/**
 * POST /api/learn/sql/setup { force? } -> { seed: { version, built, ms } }: builds the course data when it is missing or
 * older than this app's SEED_VERSION (a few seconds); `force` rebuilds it from scratch ("Rebuild course data").
 */
export async function POST(request: Request): Promise<Response> {
  const auth = authenticate(request, true);
  if ("response" in auth) return auth.response;
  const read = await readJsonBody(request, 1024);
  if ("response" in read) return read.response;
  const parsed = bodySchema.safeParse(read.body);
  if (!parsed.success) return jsonError("Bad request: body: expected { force?: boolean }", 422);
  // Rebuilding wipes the shared course data for everyone.
  if (parsed.data.force) {
    const denied = requireAdmin(auth.account, "rebuild the course data");
    if (denied) return denied;
  }
  try {
    const seed = await ensureSeeded(sidecarConnection(), parsed.data.force ?? false);
    touch(SERVICE_ID);
    return json({ seed });
  } catch (error) {
    return learnError(error);
  }
}
