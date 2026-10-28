import * as z from "zod/v4";
import { authenticate, json, jsonError, parseBody } from "@/lib/accounts/http";
import { createProject, CvProjectError, deleteProject, listProjects, renameProject, setActiveProject } from "@/lib/cv/projects";
import { quotaErrorResponse } from "@/lib/storage/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function failure(error: unknown): Response {
  if (error instanceof CvProjectError) return jsonError(error.message, error.status);
  const quota = quotaErrorResponse(error);
  if (quota) return quota;
  throw error;
}

/** GET /api/cv/projects -> { active, projects: [{id, name, createdAt}] } (docs/CV-STUDIO.md "Projects"). */
export async function GET(request: Request): Promise<Response> {
  const auth = authenticate(request, false);
  if ("response" in auth) return auth.response;
  try {
    return json(listProjects(auth.account.id));
  } catch (error) {
    return failure(error);
  }
}

const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), name: z.string().max(200), duplicateOf: z.string().max(40).optional() }).strict(),
  z.object({ action: z.literal("rename"), id: z.string().max(40), name: z.string().max(200) }).strict(),
  z.object({ action: z.literal("switch"), id: z.string().max(40) }).strict(),
]);

/**
 * POST /api/cv/projects { action: "create", name, duplicateOf? } -> 201 { project, active } (the new project becomes active);
 * { action: "rename", id, name } -> { project }; { action: "switch", id } -> { project, active }.
 */
export async function POST(request: Request): Promise<Response> {
  const auth = authenticate(request, true);
  if ("response" in auth) return auth.response;
  const parsed = await parseBody(request, bodySchema, '{ action: "create"|"rename"|"switch", ... }');
  if ("response" in parsed) return parsed.response;
  const id = auth.account.id;
  try {
    const body = parsed.data;
    if (body.action === "create") {
      const project = createProject(id, { name: body.name, duplicateOf: body.duplicateOf });
      return json({ project, active: project.id }, 201);
    }
    if (body.action === "rename") return json({ project: renameProject(id, body.id, body.name) });
    const project = setActiveProject(id, body.id);
    return json({ project, active: project.id });
  } catch (error) {
    return failure(error);
  }
}

/** DELETE /api/cv/projects?id=<id> -> { removed, active }: the project's CV, snapshots, photo and website connection. */
export async function DELETE(request: Request): Promise<Response> {
  const auth = authenticate(request, true);
  if ("response" in auth) return auth.response;
  const target = new URL(request.url).searchParams.get("id") ?? "";
  if (!target) return jsonError("Pass ?id=<project id>.", 422);
  try {
    return json({ removed: target, ...deleteProject(auth.account.id, target) });
  } catch (error) {
    return failure(error);
  }
}
