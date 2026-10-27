import * as z from "zod/v4";
import { withCvProject } from "@/lib/cv/projects";
import type { KnifeToolDefinition } from "./define";

const PROJECT_ARG = z
  .string()
  .max(40)
  .optional()
  .describe("CV project id (knife_cv_project_list). Omit for the active project, the one the user sees.");

/**
 * Every CV and website tool takes an optional `projectId` (docs/CV-STUDIO.md "Projects"): the call runs with that project
 * bound (src/lib/cv/projects.ts withCvProject), without one on the account's active project. Object schemas only.
 */
export function withProjectArg(tools: KnifeToolDefinition[]): KnifeToolDefinition[] {
  return tools.map((tool) => {
    const schema = tool.schema as unknown as z.ZodObject;
    if (typeof schema.extend !== "function" || !("shape" in schema)) return tool;
    const extended = schema.extend({ projectId: PROJECT_ARG });
    return {
      ...tool,
      schema: extended,
      async execute(input, ctx) {
        const { projectId, ...rest } = (input ?? {}) as { projectId?: string };
        if (!ctx?.accountId || !projectId) return tool.execute(rest, ctx);
        return withCvProject(ctx.accountId, projectId, () => tool.execute(rest, ctx));
      },
    };
  });
}
