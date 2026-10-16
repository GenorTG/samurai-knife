import * as z from "zod/v4";
import { authenticate, json, jsonError, readJsonBody } from "@/lib/accounts/http";
import { deleteWorkspaceTool, readWorkspaceState, saveWorkspaceTool, saveWorkspaceState } from "@/lib/workspace-state/store";
import { QuotaExceededError } from "@/lib/storage/quota";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const fieldSchema = z.union([z.string().max(100_000), z.boolean()]);
const stateSchema = z.record(
  z.string().regex(/^[a-z0-9-]{1,80}$/),
  z.record(z.string().max(240), fieldSchema).refine((fields) => Object.keys(fields).length <= 300),
).refine((state) => Object.keys(state).length <= 160);
const toolSchema = z.object({
  tool: z.string().regex(/^[a-z0-9-]{1,80}$/),
  fields: z.record(z.string().max(240), fieldSchema).refine((fields) => Object.keys(fields).length <= 300),
});

/** GET /api/workspace[?tool=<id>] -> every draft of the account, or only that tool's (`{}` when it has none). */
export async function GET(request: Request): Promise<Response> {
  const auth = authenticate(request, false);
  if ("response" in auth) return auth.response;
  const tool = new URL(request.url).searchParams.get("tool");
  if (tool !== null && !/^[a-z0-9-]{1,80}$/.test(tool)) return jsonError("invalid_workspace_state", 400);
  try {
    const state = readWorkspaceState(auth.account.id);
    if (tool === null) return json(state);
    return json(state[tool] ? { [tool]: state[tool] } : {});
  } catch {
    return jsonError("workspace_unavailable", 500);
  }
}

export async function PUT(request: Request): Promise<Response> {
  const auth = authenticate(request, true);
  if ("response" in auth) return auth.response;
  const read = await readJsonBody(request, 2 * 1024 * 1024);
  if ("response" in read) return read.response;
  const parsed = stateSchema.safeParse(read.body);
  if (!parsed.success) return jsonError("invalid_workspace_state", 400);
  try {
    saveWorkspaceState(auth.account.id, parsed.data);
    return json({ ok: true });
  } catch (error) {
    if (error instanceof QuotaExceededError) {
      return jsonError(error.message, 507, error.details());
    }
    if (error instanceof Error && error.message.includes("exceeds 2 MiB")) return jsonError("workspace_too_large", 413);
    return jsonError("workspace_unavailable", 500);
  }
}

export async function PATCH(request: Request): Promise<Response> {
  const auth = authenticate(request, true);
  if ("response" in auth) return auth.response;
  const read = await readJsonBody(request, 512 * 1024);
  if ("response" in read) return read.response;
  const parsed = toolSchema.safeParse(read.body);
  if (!parsed.success) return jsonError("invalid_workspace_state", 400);
  try {
    saveWorkspaceTool(auth.account.id, parsed.data.tool, parsed.data.fields);
    return json({ ok: true });
  } catch (error) {
    if (error instanceof QuotaExceededError) return jsonError(error.message, 507, error.details());
    if (error instanceof Error && error.message.includes("exceeds 2 MiB")) return jsonError("workspace_too_large", 413);
    return jsonError("workspace_unavailable", 500);
  }
}

/** DELETE /api/workspace?tool=<id> -> forgets that tool's draft ("Discard"). */
export async function DELETE(request: Request): Promise<Response> {
  const auth = authenticate(request, true);
  if ("response" in auth) return auth.response;
  const tool = new URL(request.url).searchParams.get("tool");
  if (!tool || !/^[a-z0-9-]{1,80}$/.test(tool)) return jsonError("invalid_workspace_state", 400);
  try {
    return json({ ok: true, removed: deleteWorkspaceTool(auth.account.id, tool) });
  } catch {
    return jsonError("workspace_unavailable", 500);
  }
}
