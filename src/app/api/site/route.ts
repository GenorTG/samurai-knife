import * as z from "zod/v4";
import { authenticate, json, parseBody } from "@/lib/accounts/http";
import { siteErrorResponse } from "@/lib/site/http";
import { clearSiteUrl, connect, disconnect, setSiteUrl, verifySiteUrl } from "@/lib/site/service";
import { loadSite, siteView } from "@/lib/site/store";
import { bindRequestProject } from "@/lib/cv/projects";
import { outboundBudgeted } from "@/lib/net/outbound";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/site[?revision=N] -> the account's website studio view (no token); `{changed:false}` when N is current. */
export async function GET(request: Request): Promise<Response> {
  const auth = authenticate(request, false);
  if ("response" in auth) return auth.response;
  const unknownProject = bindRequestProject(request, auth.account.id);
  if (unknownProject) return unknownProject;
  try {
    const site = loadSite(auth.account.id);
    const known = Number(new URL(request.url).searchParams.get("revision") ?? NaN);
    if (known === site.revision) return json({ changed: false, revision: site.revision });
    // proofNeeded: this account's checks of a website without a repository need the ownership proof (public mode, not admin).
    return json({ ...siteView(site), proofNeeded: outboundBudgeted(auth.account) });
  } catch (error) {
    return siteErrorResponse(error);
  }
}

const connectSchema = z.object({
  repo: z.string().min(3).max(200),
  baseBranch: z.string().max(200).optional(),
  productionUrl: z.string().max(500).optional(),
  pages: z.array(z.string().max(300)).max(10).optional(),
  tokenSource: z.enum(["pat", "host-gh", "app"]).optional(),
  installationId: z.number().int().positive().optional(),
  token: z.string().max(500).optional(),
  psiKey: z.string().max(200).optional(),
}).strict();

/** PUT /api/site {repo, token?, tokenSource?, baseBranch?, productionUrl?, pages?, psiKey?} -> connect or change settings. */
export async function PUT(request: Request): Promise<Response> {
  const auth = authenticate(request, true);
  if ("response" in auth) return auth.response;
  const unknownProject = bindRequestProject(request, auth.account.id);
  if (unknownProject) return unknownProject;
  const parsed = await parseBody(request, connectSchema, "{ repo, token?, tokenSource?, installationId?, baseBranch?, productionUrl?, pages?, psiKey? }");
  if ("response" in parsed) return parsed.response;
  try {
    return json(await connect(auth.account.id, parsed.data));
  } catch (error) {
    return siteErrorResponse(error);
  }
}

/** DELETE /api/site -> disconnect (forgets the token, settings and work branch; audits stay). */
export async function DELETE(request: Request): Promise<Response> {
  const auth = authenticate(request, true);
  if ("response" in auth) return auth.response;
  const unknownProject = bindRequestProject(request, auth.account.id);
  if (unknownProject) return unknownProject;
  try {
    return json(disconnect(auth.account.id));
  } catch (error) {
    return siteErrorResponse(error);
  }
}

const urlSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("set-url"), url: z.string().max(500), pages: z.array(z.string().max(300)).max(10).optional() }).strict(),
  z.object({ action: z.literal("verify-url") }).strict(),
  z.object({ action: z.literal("clear-url") }).strict(),
]);

/**
 * POST /api/site — a website without a repository (the CV check only), for the current CV project:
 * { action: "set-url", url, pages? } -> view (with the verification token); { action: "verify-url" } -> view (verified, or
 * 422 with why); { action: "clear-url" } -> view. docs/WEBSITE-STUDIO.md "Without a repository".
 */
export async function POST(request: Request): Promise<Response> {
  const auth = authenticate(request, true);
  if ("response" in auth) return auth.response;
  const unknownProject = bindRequestProject(request, auth.account.id);
  if (unknownProject) return unknownProject;
  const parsed = await parseBody(request, urlSchema, '{ action: "set-url"|"verify-url"|"clear-url", url?, pages? }');
  if ("response" in parsed) return parsed.response;
  try {
    const body = parsed.data;
    if (body.action === "set-url") return json(setSiteUrl(auth.account.id, { url: body.url, pages: body.pages }));
    if (body.action === "verify-url") return json(await verifySiteUrl(auth.account.id));
    return json(clearSiteUrl(auth.account.id));
  } catch (error) {
    return siteErrorResponse(error);
  }
}
