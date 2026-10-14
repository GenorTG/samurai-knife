import * as z from "zod/v4";
import { authenticate, json, jsonError, readJsonBody } from "@/lib/accounts/http";
import { KNIFE_TOOLS, callKnifeTool, serializeKnifeToolResult } from "@/lib/mcp/tools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_TOOL_RESULT_CHARS = 20_000;

const bodySchema = z.object({
  name: z.string().min(1).max(128),
  args: z.unknown().optional(),
}).strict();

export async function POST(request: Request): Promise<Response> {
  const auth = authenticate(request, true);
  if ("response" in auth) return auth.response;

  const read = await readJsonBody(request, 512 * 1024);
  if ("response" in read) return read.response;
  const parsed = bodySchema.safeParse(read.body);
  if (!parsed.success) return jsonError("Expected { name, args }.", 400, { ok: false });

  if (!KNIFE_TOOLS.some((tool) => tool.name === parsed.data.name)) {
    return json({ ok: false, error: `Unknown tool: ${parsed.data.name}` }, 404);
  }
  try {
    const result = serializeKnifeToolResult(await callKnifeTool(parsed.data.name, parsed.data.args ?? {}, { accountId: auth.account.id }));
    const content = result.length > MAX_TOOL_RESULT_CHARS
      ? `${result.slice(0, MAX_TOOL_RESULT_CHARS)}\n[truncated]`
      : result;
    return json({ ok: true, content });
  } catch (error) {
    return json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}
