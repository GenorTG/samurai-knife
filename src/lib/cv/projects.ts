import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as z from "zod/v4";
import { readAccountFile, readAccountText } from "@/lib/storage/sealed";
import { removeAccountPath, writeAccountFile } from "@/lib/storage/quota";
import { accountScope, ensurePrivateDir, StorageScopeError } from "@/lib/storage/scope";
import { msg, msgf } from "@/lib/i18n/msg";

/**
 * CV projects (docs/CV-STUDIO.md "Projects"): one account holds several independent CVs (several people, or one person's
 * separate CVs). Each project has its own CV data with its undo snapshots, its own photo and its own website
 * connection. Server only.
 *
 * Layout, chosen so the first project needs no migration at all (the files an account already has ARE it):
 *   cv/<account>.projects.json          index {active, projects[{id, name, createdAt}]}; absent = one project `main`
 *   project `main`:   cv/<account>.json, cv/<account>.snapshots/, cv/<account>.photo.jpg, site/<account>.json
 *   project `<id>`:   cv/<account>.p-<id>.json, .p-<id>.snapshots/, .p-<id>.photo.jpg, .p-<id>.site.json
 * Everything but `site/<account>.json` starts with `cv/<account>.`, so the quota, account rename and deletion already
 * cover every project. Linked GitHub App installations stay account-wide in `site/<account>.json` (src/lib/site/store.ts).
 *
 * Which project a call works on: the explicit one bound for the request (`?project=` on the routes, `projectId` on the
 * tools; `withCvProject`) or else the account's ACTIVE project (the switcher; one per account, the UI follows it).
 */

export const MAIN_PROJECT = "main";
export const MAX_PROJECTS = 30;
const PROJECT_ID = /^[a-z0-9][a-z0-9-]{0,23}$/;

export class CvProjectError extends Error {
  readonly status: number;
  constructor(message: string, status = 422) {
    super(message);
    this.status = status;
  }
}

const projectSchema = z.object({
  id: z.string().regex(PROJECT_ID),
  name: z.string().trim().min(1).max(80),
  createdAt: z.string(),
});
export type CvProject = z.infer<typeof projectSchema>;

const indexSchema = z.object({
  version: z.literal(1),
  active: z.string(),
  projects: z.array(projectSchema).min(1).max(MAX_PROJECTS),
});
type ProjectIndex = z.infer<typeof indexSchema>;

export interface ProjectPaths {
  file: string;
  snapshots: string;
  photo: string;
  site: string;
}

function scope(accountId: string) {
  try {
    const s = accountScope(accountId);
    ensurePrivateDir(s.cv.dir);
    return s;
  } catch (error) {
    if (error instanceof StorageScopeError) throw new CvProjectError("invalid account id", 400);
    throw error;
  }
}

function indexFile(accountId: string): string {
  const { cv } = scope(accountId);
  return join(cv.dir, `${cv.prefix}projects.json`);
}

/** The files of one project (the project need not exist yet). */
export function projectPaths(accountId: string, projectId: string): ProjectPaths {
  if (!PROJECT_ID.test(projectId)) throw new CvProjectError(msgf("'{id}' is not a project id", { id: projectId.slice(0, 40) }), 400);
  const s = scope(accountId);
  if (projectId === MAIN_PROJECT) return { file: s.cv.file, snapshots: s.cv.snapshots, photo: s.cv.photo, site: s.siteFile };
  const base = join(s.cv.dir, `${s.cv.prefix}p-${projectId}`);
  return { file: `${base}.json`, snapshots: `${base}.snapshots`, photo: `${base}.photo.jpg`, site: `${base}.site.json` };
}

/** Name for the implicit first project: the CV's own name when it has one. */
function firstProjectName(accountId: string): string {
  const file = accountScope(accountId).cv.file;
  if (existsSync(file)) {
    try {
      const data = JSON.parse(readAccountText(accountId, file)) as { profile?: { contact?: { name?: unknown } } };
      const name = data.profile?.contact?.name;
      if (typeof name === "string" && name.trim()) return name.trim().slice(0, 80);
    } catch {
      /* a damaged CV is reported by the store, not here */
    }
  }
  return msg("My CV");
}

function readIndex(accountId: string): ProjectIndex {
  const file = indexFile(accountId);
  if (existsSync(file)) {
    let raw: unknown;
    try {
      raw = JSON.parse(readAccountText(accountId, file));
    } catch {
      throw new CvProjectError(msg("the CV project list is damaged (cv/<account>.projects.json)"), 500);
    }
    const parsed = indexSchema.safeParse(raw);
    if (!parsed.success) throw new CvProjectError(msg("the CV project list is invalid (cv/<account>.projects.json)"), 500);
    const index = parsed.data;
    if (!index.projects.some((p) => p.id === index.active)) index.active = index.projects[0].id;
    return index;
  }
  // An account from before projects (or a new one): its CV files are the project `main`. Nothing is written until the
  // list changes, so reading never touches the disk and an old install migrates without moving a byte.
  return { version: 1, active: MAIN_PROJECT, projects: [{ id: MAIN_PROJECT, name: firstProjectName(accountId), createdAt: new Date(0).toISOString() }] };
}

function writeIndex(accountId: string, index: ProjectIndex): void {
  writeAccountFile(accountId, indexFile(accountId), JSON.stringify(indexSchema.parse(index), null, 2));
}

export function listProjects(accountId: string): { active: string; projects: CvProject[] } {
  const index = readIndex(accountId);
  return { active: index.active, projects: index.projects };
}

export function getProject(accountId: string, projectId: string): CvProject | null {
  return readIndex(accountId).projects.find((p) => p.id === projectId) ?? null;
}

/* ------------------------------------------------------------------------------------------------ binding */

const bound = new AsyncLocalStorage<{ accountId: string; projectId: string }>();

/** The project a store call works on: the one bound for this request/tool call, else the account's active one. */
export function currentProjectId(accountId: string): string {
  const b = bound.getStore();
  if (b && b.accountId === accountId) return b.projectId;
  return readIndex(accountId).active;
}

function requireProject(accountId: string, projectId: string): void {
  if (!getProject(accountId, projectId)) throw new CvProjectError(msgf("no CV project '{id}' (knife_cv_project_list / GET /api/cv/projects)", { id: projectId.slice(0, 40) }), 404);
}

/** Runs `fn` with `projectId` (if given; validated) as the project of every CV/website store call inside it. */
export function withCvProject<T>(accountId: string, projectId: string | null | undefined, fn: () => T): T {
  if (!projectId) return fn();
  requireProject(accountId, projectId);
  return bound.run({ accountId, projectId }, fn);
}

/**
 * Routes: binds `?project=<id>` for the rest of this request (the browser sends the project it shows, so a switch in
 * another tab never redirects its edits). Returns a 404/400 Response for an unknown id, null when bound or absent.
 */
export function bindRequestProject(request: Request, accountId: string): Response | null {
  const projectId = new URL(request.url).searchParams.get("project");
  if (!projectId) return null;
  try {
    requireProject(accountId, projectId);
  } catch (error) {
    if (error instanceof CvProjectError) return Response.json({ error: error.message }, { status: error.status });
    throw error;
  }
  bound.enterWith({ accountId, projectId });
  return null;
}

/* ------------------------------------------------------------------------------------------------ changes */

function newId(index: ProjectIndex, name: string): string {
  const base = name.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 18) || "cv";
  const safeBase = /^[a-z0-9]/.test(base) && base !== MAIN_PROJECT ? base : `cv-${base}`.slice(0, 18);
  for (let n = 1; ; n += 1) {
    const id = n === 1 ? safeBase : `${safeBase}-${n}`;
    if (!index.projects.some((p) => p.id === id)) return id;
  }
}

function cleanName(name: string): string {
  const trimmed = name.trim().replace(/\s+/g, " ");
  if (!trimmed) throw new CvProjectError(msg("Give the project a name."));
  return trimmed.slice(0, 80);
}

/** A new empty project (or a copy of `duplicateOf`: its CV data and photo; never its website connection). Becomes active. */
export function createProject(accountId: string, input: { name: string; duplicateOf?: string }): CvProject {
  const index = readIndex(accountId);
  if (index.projects.length >= MAX_PROJECTS) throw new CvProjectError(msgf("At most {n} CV projects per account.", { n: MAX_PROJECTS }));
  const name = cleanName(input.name);
  const id = newId(index, name);
  const project: CvProject = { id, name, createdAt: new Date().toISOString() };
  const target = projectPaths(accountId, id);
  // Leftovers of a deleted project with the same id must not reappear in the new one.
  for (const path of [target.file, target.snapshots, target.photo, target.site]) if (existsSync(path)) removeAccountPath(accountId, path);
  if (input.duplicateOf) {
    requireProject(accountId, input.duplicateOf);
    const source = projectPaths(accountId, input.duplicateOf);
    if (existsSync(source.file)) {
      const data = JSON.parse(readAccountText(accountId, source.file)) as Record<string, unknown>;
      writeAccountFile(accountId, target.file, JSON.stringify({ ...data, revision: 1 }, null, 2));
    }
    if (existsSync(source.photo)) writeAccountFile(accountId, target.photo, readAccountFile(accountId, source.photo));
  }
  index.projects.push(project);
  index.active = id;
  writeIndex(accountId, index);
  return project;
}

export function renameProject(accountId: string, projectId: string, name: string): CvProject {
  const index = readIndex(accountId);
  const project = index.projects.find((p) => p.id === projectId);
  if (!project) throw new CvProjectError(msgf("no CV project '{id}'", { id: projectId.slice(0, 40) }), 404);
  project.name = cleanName(name);
  writeIndex(accountId, index);
  return project;
}

export function setActiveProject(accountId: string, projectId: string): CvProject {
  const index = readIndex(accountId);
  const project = index.projects.find((p) => p.id === projectId);
  if (!project) throw new CvProjectError(msgf("no CV project '{id}'", { id: projectId.slice(0, 40) }), 404);
  if (index.active !== projectId) {
    index.active = projectId;
    writeIndex(accountId, index);
  }
  return project;
}

/** Deletes a project with its CV, snapshots, photo and website connection. The last project cannot be deleted. */
export function deleteProject(accountId: string, projectId: string): { active: string } {
  const index = readIndex(accountId);
  if (!index.projects.some((p) => p.id === projectId)) throw new CvProjectError(msgf("no CV project '{id}'", { id: projectId.slice(0, 40) }), 404);
  if (index.projects.length === 1) throw new CvProjectError(msg("This is the only CV project: create another one first, or clear this one instead."), 409);
  const paths = projectPaths(accountId, projectId);
  for (const path of [paths.file, paths.snapshots, paths.photo, paths.site]) if (existsSync(path)) removeAccountPath(accountId, path);
  index.projects = index.projects.filter((p) => p.id !== projectId);
  if (index.active === projectId) index.active = index.projects[0].id;
  writeIndex(accountId, index);
  return { active: index.active };
}

/** Tests: the project files an account has on disk (ids). */
export function projectFilesOnDisk(accountId: string): string[] {
  const { cv } = scope(accountId);
  return readdirSync(cv.dir).filter((n) => n.startsWith(`${cv.prefix}p-`) && n.endsWith(".json") && !n.endsWith(".site.json")).map((n) => n.slice(cv.prefix.length + 2, -5));
}
