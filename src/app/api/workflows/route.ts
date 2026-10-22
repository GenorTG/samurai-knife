import * as z from "zod/v4";
import { authenticate, json, jsonError, readJsonBody } from "@/lib/accounts/http";
import { workflowError, zodMessage } from "@/lib/workflows/server/http";
import { workflowQueueStats } from "@/lib/workflows/server/runner";
import { createWorkflow, listCredentials, listWorkflows } from "@/lib/workflows/server/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createSchema = z.object({
  action: z.literal("create"),
  name: z.string().trim().min(1).max(120),
  description: z.string().max(4000).optional(),
  nodes: z.array(z.unknown()).max(300).optional(),
  connections: z.array(z.unknown()).max(1000).optional(),
  settings: z.unknown().optional(),
  tags: z.array(z.string()).max(20).optional(),
}).strict();

/** GET /api/workflows -> `{ workflows, credentials, queue }` (summaries; credentials as hints only). docs/WORKFLOWS.md. */
export function GET(request: Request): Response {
  const auth = authenticate(request, false);
  if ("response" in auth) return auth.response;
  try {
    return json({ workflows: listWorkflows(auth.account.id), credentials: listCredentials(auth.account.id), queue: workflowQueueStats() });
  } catch (error) {
    return workflowError(error);
  }
}

/** POST /api/workflows { action: "create", name, nodes?, connections?, settings?, tags? } -> 201 `{ workflow }`. */
export async function POST(request: Request): Promise<Response> {
  const auth = authenticate(request, true);
  if ("response" in auth) return auth.response;
  const read = await readJsonBody(request, 4 * 1024 * 1024);
  if ("response" in read) return read.response;
  const parsed = createSchema.safeParse(read.body);
  if (!parsed.success) return jsonError(zodMessage(parsed.error), 422);
  try {
    return json({ workflow: createWorkflow(auth.account.id, parsed.data) }, 201);
  } catch (error) {
    return workflowError(error);
  }
}
