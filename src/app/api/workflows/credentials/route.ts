import * as z from "zod/v4";
import { authenticate, json, jsonError, readJsonBody } from "@/lib/accounts/http";
import { workflowError, zodMessage } from "@/lib/workflows/server/http";
import { deleteCredential, listCredentials, saveCredential } from "@/lib/workflows/server/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const data = z.record(z.string(), z.union([z.string().max(16_384), z.boolean(), z.null()]));
const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), name: z.string().max(80), type: z.string().max(40), data }).strict(),
  /** Blank secret fields keep the stored value (the form never receives it); `null` clears a field. */
  z.object({ action: z.literal("update"), id: z.string().regex(/^[0-9a-f]{12}$/), name: z.string().max(80), type: z.string().max(40), data }).strict(),
  z.object({ action: z.literal("delete"), id: z.string().regex(/^[0-9a-f]{12}$/) }).strict(),
]);

/** GET /api/workflows/credentials -> `{ credentials }` (secret fields only as `true` when set). */
export function GET(request: Request): Response {
  const auth = authenticate(request, false);
  if ("response" in auth) return auth.response;
  try {
    return json({ credentials: listCredentials(auth.account.id) });
  } catch (error) {
    return workflowError(error);
  }
}

/** POST /api/workflows/credentials { action: create | update | delete, … } -> `{ credential }` / `{ deleted, usedBy }`. */
export async function POST(request: Request): Promise<Response> {
  const auth = authenticate(request, true);
  if ("response" in auth) return auth.response;
  const read = await readJsonBody(request, 64 * 1024);
  if ("response" in read) return read.response;
  const parsed = bodySchema.safeParse(read.body);
  if (!parsed.success) return jsonError(zodMessage(parsed.error), 422);
  const body = parsed.data;
  try {
    if (body.action === "delete") return json({ deleted: true, usedBy: deleteCredential(auth.account.id, body.id) });
    const credential = saveCredential(auth.account.id, { ...(body.action === "update" ? { id: body.id } : {}), name: body.name, type: body.type, data: body.data });
    return json({ credential }, body.action === "create" ? 201 : 200);
  } catch (error) {
    return workflowError(error);
  }
}
