import * as z from "zod/v4";
import { authenticate, json, parseBody } from "@/lib/accounts/http";
import { siteErrorResponse } from "@/lib/site/http";
import { connect, disconnect } from "@/lib/site/service";
import { loadSite, siteView } from "@/lib/site/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/site[?revision=N] -> the account's website studio view (no token); `{changed:false}` when N is current. */
export async function GET(request: Request): Promise<Response> {
  const auth = authenticate(request, false);
  if ("response" in auth) return auth.response;
  try {
    const site = loadSite(auth.account.id);
    const known = Number(new URL(request.url).searchParams.get("revision") ?? NaN);
    if (known === site.revision) return json({ changed: false, revision: site.revision });
    return json(siteView(site));
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
  try {
    return json(disconnect(auth.account.id));
  } catch (error) {
    return siteErrorResponse(error);
  }
}
