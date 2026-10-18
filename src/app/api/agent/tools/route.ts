import { authenticate, json } from "@/lib/accounts/http";
import { toolContextFor } from "@/lib/accounts/authz";
import { getOpenAiToolDefinitions, getToolEffects } from "@/lib/mcp/tools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const auth = authenticate(request, false);
  if ("response" in auth) return auth.response;
  const ctx = toolContextFor(auth.account);
  // `effects` drives the widget's approval policy (server-tool-policy.ts); it never goes to the model.
  return json({ tools: getOpenAiToolDefinitions(ctx), effects: getToolEffects(ctx) });
}
