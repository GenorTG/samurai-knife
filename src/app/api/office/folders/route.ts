import * as z from "zod/v4";
import { authenticate, json, jsonError, readJsonBody } from "@/lib/accounts/http";
import { createFolder } from "@/lib/office/folders";
import { officeError } from "@/lib/office/http";
import { msgf } from "@/lib/i18n/msg";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({ name: z.string().min(1).max(200), parentId: z.string().regex(/^[a-f0-9]{16}$/).nullable().optional() }).strict();

/** POST /api/office/folders { name, parentId? } -> 201 `{ folder }` (409 when a sibling has the name). List: GET /api/office/docs. */
export async function POST(request: Request): Promise<Response> {
  const auth = authenticate(request, true);
  if ("response" in auth) return auth.response;
  const read = await readJsonBody(request, 4096);
  if ("response" in read) return read.response;
  const parsed = bodySchema.safeParse(read.body);
  if (!parsed.success) return jsonError(msgf("Bad request: {value}: {message}", { value: parsed.error.issues[0].path.join("/") || "body", message: parsed.error.issues[0].message }), 422);
  try {
    return json({ folder: createFolder(auth.account.id, parsed.data.name, parsed.data.parentId ?? null) }, 201);
  } catch (error) {
    return officeError(error);
  }
}
