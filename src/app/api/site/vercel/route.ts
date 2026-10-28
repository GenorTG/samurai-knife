import * as z from "zod/v4";
import { authenticate, json, parseBody } from "@/lib/accounts/http";
import { bindRequestProject } from "@/lib/cv/projects";
import { siteErrorResponse } from "@/lib/site/http";
import { loadSite, siteView } from "@/lib/site/store";
import { deployWorkBranch, previews, vercelConnect, vercelDisconnect, vercelGenerateBypass, vercelOAuthConfig, vercelProjects } from "@/lib/site/vercel-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The optional Vercel link of the current CV project's website (docs/WEBSITE-STUDIO.md "Vercel"). Secrets never come
 * back: the view carries the source, a token hint and `hasBypass`.
 * GET  -> { vercel, oauth } ; ?projects=1 adds the token's projects ; ?previews=1 adds the work branch's previews.
 */
export async function GET(request: Request): Promise<Response> {
  const auth = authenticate(request, false);
  if ("response" in auth) return auth.response;
  const unknownProject = bindRequestProject(request, auth.account.id);
  if (unknownProject) return unknownProject;
  const params = new URL(request.url).searchParams;
  try {
    const view = siteView(loadSite(auth.account.id));
    const out: Record<string, unknown> = { vercel: view.vercel, oauth: !!vercelOAuthConfig() };
    if (view.vercel && params.get("projects") === "1") out.projects = await vercelProjects(auth.account.id);
    if (view.vercel?.projectId && params.get("previews") === "1") out.previews = await previews(auth.account.id);
    return json(out);
  } catch (error) {
    return siteErrorResponse(error);
  }
}

const connectSchema = z.object({
  token: z.string().max(500).optional(),
  team: z.string().max(100).optional(),
  projectId: z.string().max(100).optional(),
  bypass: z.string().max(200).optional(),
}).strict();

/** PUT {token?, team?, projectId?, bypass?} -> connect with a token, or change team / project / bypass secret. */
export async function PUT(request: Request): Promise<Response> {
  const auth = authenticate(request, true);
  if ("response" in auth) return auth.response;
  const unknownProject = bindRequestProject(request, auth.account.id);
  if (unknownProject) return unknownProject;
  const parsed = await parseBody(request, connectSchema, "{ token?, team?, projectId?, bypass? }");
  if ("response" in parsed) return parsed.response;
  try {
    const result = await vercelConnect(auth.account.id, parsed.data);
    return json({ vercel: result.view.vercel, projects: result.projects, project: result.project });
  } catch (error) {
    return siteErrorResponse(error);
  }
}

/** DELETE -> forget the Vercel token and settings of this website (the integration stays installed on Vercel). */
export async function DELETE(request: Request): Promise<Response> {
  const auth = authenticate(request, true);
  if ("response" in auth) return auth.response;
  const unknownProject = bindRequestProject(request, auth.account.id);
  if (unknownProject) return unknownProject;
  try {
    return json({ vercel: vercelDisconnect(auth.account.id).vercel });
  } catch (error) {
    return siteErrorResponse(error);
  }
}

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("generate-bypass") }).strict(),
  z.object({ action: z.literal("deploy"), force: z.boolean().optional() }).strict(),
]);

/** POST {action:"generate-bypass"} -> a bypass secret on the project ; {action:"deploy", force?} -> preview of the work branch. */
export async function POST(request: Request): Promise<Response> {
  const auth = authenticate(request, true);
  if ("response" in auth) return auth.response;
  const unknownProject = bindRequestProject(request, auth.account.id);
  if (unknownProject) return unknownProject;
  const parsed = await parseBody(request, actionSchema, '{ action: "generate-bypass" | "deploy", force? }');
  if ("response" in parsed) return parsed.response;
  try {
    if (parsed.data.action === "generate-bypass") return json({ vercel: (await vercelGenerateBypass(auth.account.id)).vercel });
    return json(await deployWorkBranch(auth.account.id, parsed.data.force ?? false));
  } catch (error) {
    return siteErrorResponse(error);
  }
}
