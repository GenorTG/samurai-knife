import * as z from "zod/v4";
import { defineTool, type KnifeToolContext, type KnifeToolDefinition } from "./define";
import { createProject, CvProjectError, listProjects, setActiveProject, withCvProject } from "@/lib/cv/projects";
import { loadCv } from "@/lib/cv/store";

/**
 * CV projects (docs/CV-STUDIO.md "Projects"): one account holds several independent CVs (other people, or separate CVs
 * of one person). List, create and switch; deleting a project is left to the user in the CV studio.
 */

function account(ctx: KnifeToolContext | undefined): string {
  if (!ctx?.accountId) throw new Error("no account");
  return ctx.accountId;
}

function rethrow(error: unknown): never {
  if (error instanceof CvProjectError) throw new Error(error.message);
  throw error;
}

export const CV_PROJECT_TOOLS: KnifeToolDefinition[] = [
  defineTool({
    name: "knife_cv_project_list",
    scope: "account",
    effect: "read",
    description:
      "List the account's CV projects (each is a separate CV: its own profile, versions, offers, applications, photo and website). Returns {active, projects:[{id, name, createdAt, owner}]} where owner is the name on that CV. Every other knife_cv_* and knife_site_* tool works on the active project unless you pass projectId.",
    schema: z.object({}).strict(),
    run(_input, ctx) {
      const id = account(ctx);
      try {
        const { active, projects } = listProjects(id);
        return {
          active,
          projects: projects.map((p) => ({ ...p, owner: withCvProject(id, p.id, () => loadCv(id).profile.contact.name) || null })),
        };
      } catch (error) {
        rethrow(error);
      }
    },
  }),
  defineTool({
    name: "knife_cv_project_create",
    scope: "account",
    effect: "write",
    description:
      "Create a new CV project (a separate CV, e.g. for another person or another career direction) and make it the active one the user sees. duplicateOf copies another project's CV and photo as a starting point (never its website connection). Only when the user asks for a separate CV; otherwise keep working in the active project.",
    schema: z.object({ name: z.string().min(1).max(80), duplicateOf: z.string().max(40).optional() }).strict(),
    run({ name, duplicateOf }, ctx) {
      try {
        const project = createProject(account(ctx), { name, duplicateOf });
        return { project, active: project.id };
      } catch (error) {
        rethrow(error);
      }
    },
  }),
  defineTool({
    name: "knife_cv_project_switch",
    scope: "account",
    effect: "write",
    description: "Make another CV project the active one: the CV studio the user has open follows within seconds. Use knife_cv_project_list for ids.",
    schema: z.object({ id: z.string().min(1).max(40) }).strict(),
    run({ id }, ctx) {
      try {
        const project = setActiveProject(account(ctx), id);
        return { project, active: project.id };
      } catch (error) {
        rethrow(error);
      }
    },
  }),
];
