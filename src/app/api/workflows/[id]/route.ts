import * as z from "zod/v4";
import { authenticate, json, jsonError, readJsonBody } from "@/lib/accounts/http";
import { hookUrls, stopListening } from "@/lib/workflows/server/hooks";
import { workflowError, zodMessage } from "@/lib/workflows/server/http";
import { deleteWorkflow, listRuns, requireWorkflow, saveWorkflow } from "@/lib/workflows/server/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const saveSchema = z.object({
  version: z.number().int().min(1),
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().max(4000).optional(),
  nodes: z.array(z.unknown()).max(300).optional(),
  connections: z.array(z.unknown()).max(1000).optional(),
  settings: z.unknown().optional(),
  tags: z.array(z.string()).max(20).optional(),
  active: z.boolean().optional(),
}).strict();

/** GET /api/workflows/<id> -> `{ workflow, hooks: { production, test }, runs }`. */
export async function GET(request: Request, ctx: Ctx): Promise<Response> {
  const auth = authenticate(request, false);
  if ("response" in auth) return auth.response;
  const { id } = await ctx.params;
  try {
    const workflow = requireWorkflow(auth.account.id, id);
    return json({ workflow, hooks: hookUrls(workflow), runs: listRuns(auth.account.id, id).slice(0, 30) });
  } catch (error) {
    return workflowError(error);
  }
}

/** PUT /api/workflows/<id> { version, …changes } -> `{ workflow }`; 409 when the stored version moved on. */
export async function PUT(request: Request, ctx: Ctx): Promise<Response> {
  const auth = authenticate(request, true);
  if ("response" in auth) return auth.response;
  const { id } = await ctx.params;
  const read = await readJsonBody(request, 4 * 1024 * 1024);
  if ("response" in read) return read.response;
  const parsed = saveSchema.safeParse(read.body);
  if (!parsed.success) return jsonError(zodMessage(parsed.error), 422);
  try {
    const { version, ...changes } = parsed.data;
    const workflow = saveWorkflow(auth.account.id, id, version, changes as Parameters<typeof saveWorkflow>[3]);
    return json({ workflow, hooks: hookUrls(workflow) });
  } catch (error) {
    return workflowError(error);
  }
}

/** DELETE /api/workflows/<id> -> 204: the workflow, its runs and static data. */
export async function DELETE(request: Request, ctx: Ctx): Promise<Response> {
  const auth = authenticate(request, true);
  if ("response" in auth) return auth.response;
  const { id } = await ctx.params;
  try {
    stopListening(auth.account.id, id);
    deleteWorkflow(auth.account.id, id);
    return new Response(null, { status: 204 });
  } catch (error) {
    return workflowError(error);
  }
}
