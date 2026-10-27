import { authenticate, json } from "@/lib/accounts/http";
import { siteErrorResponse } from "@/lib/site/http";
import { listFiles, readFile } from "@/lib/site/service";
import { bindRequestProject } from "@/lib/cv/projects";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/site/files?path=<dir>&ref=  -> one directory level; ?file=<path>&ref= -> one file's text. */
export async function GET(request: Request): Promise<Response> {
  const auth = authenticate(request, false);
  if ("response" in auth) return auth.response;
  const unknownProject = bindRequestProject(request, auth.account.id);
  if (unknownProject) return unknownProject;
  const params = new URL(request.url).searchParams;
  try {
    const file = params.get("file");
    const ref = params.get("ref") ?? undefined;
    return json(file ? await readFile(auth.account.id, file, ref) : await listFiles(auth.account.id, params.get("path") ?? "", ref));
  } catch (error) {
    return siteErrorResponse(error);
  }
}
