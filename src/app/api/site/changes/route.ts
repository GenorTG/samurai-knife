import * as z from "zod/v4";
import { authenticate, json, parseBody } from "@/lib/accounts/http";
import { siteErrorResponse } from "@/lib/site/http";
import { changes, discard, openPull, publish } from "@/lib/site/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/site/changes -> work branch vs base (commits, files, patches), pull request, checks, preview URL. */
export async function GET(request: Request): Promise<Response> {
  const auth = authenticate(request, false);
  if ("response" in auth) return auth.response;
  try {
    return json(await changes(auth.account.id));
  } catch (error) {
    return siteErrorResponse(error);
  }
}

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("pr"), title: z.string().max(250), body: z.string().max(20_000).default("") }).strict(),
  // Publishing merges into the production branch: the head the user reviewed must still be the branch head.
  z.object({ action: z.literal("publish"), head: z.string().regex(/^[0-9a-f]{40}$/) }).strict(),
  z.object({ action: z.literal("discard") }).strict(),
]);

/** POST /api/site/changes {action: "pr", title, body} | {action: "publish", head} | {action: "discard"}. */
export async function POST(request: Request): Promise<Response> {
  const auth = authenticate(request, true);
  if ("response" in auth) return auth.response;
  const parsed = await parseBody(request, actionSchema, '{ action: "pr", title, body } | { action: "publish", head } | { action: "discard" }', 32 * 1024);
  if ("response" in parsed) return parsed.response;
  try {
    const body = parsed.data;
    if (body.action === "pr") return json(await openPull(auth.account.id, body.title, body.body));
    if (body.action === "publish") return json(await publish(auth.account.id, body.head));
    return json(await discard(auth.account.id));
  } catch (error) {
    return siteErrorResponse(error);
  }
}
