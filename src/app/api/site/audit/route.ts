import * as z from "zod/v4";
import { authenticate, json, jsonError, parseBody } from "@/lib/accounts/http";
import { auditProgress, currentAudit, startAudit } from "@/lib/site/audit/run";
import { siteErrorResponse } from "@/lib/site/http";
import { loadSite } from "@/lib/site/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const startSchema = z.object({
  url: z.string().max(500).optional(),
  target: z.enum(["production", "preview", "custom"]).optional(),
  pages: z.array(z.string().max(300)).max(10).optional(),
  lighthouse: z.boolean().optional(),
}).strict();

/** POST /api/site/audit {url?, target?, pages?, lighthouse?} -> 202 {id}; poll GET ?id=. */
export async function POST(request: Request): Promise<Response> {
  const auth = authenticate(request, true);
  if ("response" in auth) return auth.response;
  const parsed = await parseBody(request, startSchema, "{ url?, target?, pages?, lighthouse? }");
  if ("response" in parsed) return parsed.response;
  try {
    return json(await startAudit(auth.account.id, parsed.data), 202);
  } catch (error) {
    return siteErrorResponse(error);
  }
}

/**
 * GET /api/site/audit?id=<run> -> progress {phase, done, total, finished, error}; ?run=<id> (or ?run=latest) -> the
 * stored run; no parameter -> the account's running audit, if any.
 */
export async function GET(request: Request): Promise<Response> {
  const auth = authenticate(request, false);
  if ("response" in auth) return auth.response;
  const params = new URL(request.url).searchParams;
  try {
    const runId = params.get("run");
    if (runId) {
      const audits = loadSite(auth.account.id).audits;
      const run = runId === "latest" ? audits[0] : audits.find((a) => a.id === runId);
      return run ? json(run) : jsonError("audit_not_found", 404);
    }
    const id = params.get("id");
    const progress = id ? auditProgress(auth.account.id, id) : currentAudit(auth.account.id);
    if (!progress) return id ? jsonError("audit_not_found", 404) : json({ running: false });
    const { accountId: _owner, ...view } = progress;
    void _owner;
    return json({ running: !progress.finished, ...view });
  } catch (error) {
    return siteErrorResponse(error);
  }
}
