import * as z from "zod/v4";
import { authenticate, flowErrorResponse, json, jsonError, parseBody } from "@/lib/accounts/http";
import { createMcpKey, listMcpKeys, McpKeyError, revokeMcpKey } from "@/lib/accounts/mcp-keys";
import { consumeLimits, LIMITS } from "@/lib/accounts/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), name: z.string().max(200) }).strict(),
  z.object({ action: z.literal("revoke"), id: z.string().max(40) }).strict(),
]);

/** GET /api/account/mcp-keys -> { keys: [{id, name, hint, createdAt, lastUsedAt}] } of this account (never a key or hash). */
export async function GET(request: Request): Promise<Response> {
  const auth = authenticate(request, false);
  if ("response" in auth) return auth.response;
  return json({ keys: listMcpKeys(auth.account.id) });
}

/**
 * POST /api/account/mcp-keys { action: "create", name } -> 201 { key, keyInfo }: the raw key, shown this once.
 * POST /api/account/mcp-keys { action: "revoke", id } -> { ok }: stops working at once; 404 for a key of another account.
 */
export async function POST(request: Request): Promise<Response> {
  const auth = authenticate(request, true);
  if ("response" in auth) return auth.response;
  const parsed = await parseBody(request, bodySchema, '{ action: "create", name } or { action: "revoke", id }');
  if ("response" in parsed) return parsed.response;
  const body = parsed.data;
  if (body.action === "revoke") {
    return revokeMcpKey(auth.account.id, body.id) ? json({ ok: true }) : jsonError("not_found", 404);
  }
  const limited = consumeLimits([LIMITS.mcpKeyCreate(auth.account.id)]);
  if (!limited.ok) return flowErrorResponse({ status: 429, error: "rate_limited", retryAfterSeconds: limited.retryAfterSeconds });
  try {
    const created = createMcpKey(auth.account.id, body.name);
    return json({ key: created.key, keyInfo: created.view, username: auth.account.id }, 201);
  } catch (error) {
    if (error instanceof McpKeyError) return jsonError(error.message, error.status);
    throw error;
  }
}
