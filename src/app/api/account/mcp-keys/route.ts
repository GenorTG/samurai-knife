import * as z from "zod/v4";
import { authenticate, flowErrorResponse, json, jsonError, parseBody } from "@/lib/accounts/http";
import { createMcpKey, listMcpKeys, MCP_KEY_SCOPES, mcpKeyRequired, McpKeyError, revokeMcpKey } from "@/lib/accounts/mcp-keys";
import { isPublicMode } from "@/lib/accounts/mode";
import { consumeLimits, LIMITS } from "@/lib/accounts/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), name: z.string().max(200), scope: z.enum(MCP_KEY_SCOPES).optional() }).strict(),
  z.object({ action: z.literal("revoke"), id: z.string().max(40) }).strict(),
]);

/** KNIFE_PUBLIC_URL's origin when set (the address agents reach), else null: the page uses its own origin. */
function publicOrigin(): string | null {
  try {
    return process.env.KNIFE_PUBLIC_URL ? new URL(process.env.KNIFE_PUBLIC_URL).origin : null;
  } catch {
    return null;
  }
}

/**
 * GET /api/account/mcp-keys -> { keys: [{id, name, hint, createdAt, lastUsedAt, scope}], username, origin, keyRequired }
 * of this account (never a key or hash). `origin` (KNIFE_PUBLIC_URL, or null = the page's own) builds the personal URL
 * `<origin>/api/mcp/u/<username>`; `keyRequired` = `/api/mcp` refuses requests without a key.
 */
export async function GET(request: Request): Promise<Response> {
  const auth = authenticate(request, false);
  if ("response" in auth) return auth.response;
  return json({ keys: listMcpKeys(auth.account.id), username: auth.account.id, origin: publicOrigin(), keyRequired: mcpKeyRequired(isPublicMode()) });
}

/**
 * POST /api/account/mcp-keys { action: "create", name, scope? } -> 201 { key, keyInfo }: the raw key, shown this once;
 * scope "full" (default) or "read-only" (only tools that change nothing).
 * POST /api/account/mcp-keys { action: "revoke", id } -> { ok }: stops working at once; 404 for a key of another account.
 */
export async function POST(request: Request): Promise<Response> {
  const auth = authenticate(request, true);
  if ("response" in auth) return auth.response;
  const parsed = await parseBody(request, bodySchema, '{ action: "create", name, scope? } or { action: "revoke", id }');
  if ("response" in parsed) return parsed.response;
  const body = parsed.data;
  if (body.action === "revoke") {
    return revokeMcpKey(auth.account.id, body.id) ? json({ ok: true }) : jsonError("not_found", 404);
  }
  const limited = consumeLimits([LIMITS.mcpKeyCreate(auth.account.id)]);
  if (!limited.ok) return flowErrorResponse({ status: 429, error: "rate_limited", retryAfterSeconds: limited.retryAfterSeconds });
  try {
    const created = createMcpKey(auth.account.id, body.name, body.scope ?? "full");
    return json({ key: created.key, keyInfo: created.view, username: auth.account.id }, 201);
  } catch (error) {
    if (error instanceof McpKeyError) return jsonError(error.message, error.status);
    throw error;
  }
}
