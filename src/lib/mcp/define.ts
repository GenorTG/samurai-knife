import * as z from "zod/v4";

/**
 * What a tool may touch, declared by every tool (no default: a new tool must pick one).
 * - `pure`: input in, result out; no account data, no host resources.
 * - `account`: reads or writes the calling account's own data (CV, documents, course progress, its own tabs).
 * - `admin`: reaches what belongs to the server owner (the host's `gh` login, git repos on the host's disk). Offered and
 *   callable only for admins (every account in private mode, `role: "admin"` in public mode).
 */
export type KnifeToolScope = "pure" | "account" | "admin";

/** Who is calling: the resolved account (session or MCP key) and whether it is an admin (`isAdmin`, accounts/authz.ts). */
export interface KnifeToolContext {
  accountId: string;
  admin: boolean;
}

export interface KnifeToolDefinition {
  name: string;
  scope: KnifeToolScope;
  description: string;
  schema: z.ZodType;
  execute(input: unknown, ctx?: KnifeToolContext): Promise<unknown>;
}

export const ADMIN_TOOL_MESSAGE = "needs an administrator on this server (it uses the server owner's own GitHub login or files)";

export class KnifeToolForbiddenError extends Error {
  readonly code = "admin_required";
  constructor(name: string) {
    super(`${name} ${ADMIN_TOOL_MESSAGE}.`);
    this.name = "KnifeToolForbiddenError";
  }
}

/** May this caller see and call the tool? Unknown scopes are refused (default deny). */
export function toolAllowed(tool: Pick<KnifeToolDefinition, "scope">, ctx: KnifeToolContext | undefined): boolean {
  switch (tool.scope) {
    case "pure":
      return true;
    case "account":
      return Boolean(ctx?.accountId);
    case "admin":
      return Boolean(ctx?.accountId) && ctx?.admin === true;
    default:
      return false;
  }
}

export function defineTool<Schema extends z.ZodType>(options: {
  name: string;
  scope: KnifeToolScope;
  description: string;
  schema: Schema;
  run(input: z.output<Schema>, ctx?: KnifeToolContext): unknown | Promise<unknown>;
}): KnifeToolDefinition {
  return {
    name: options.name,
    scope: options.scope,
    description: options.description,
    schema: options.schema,
    async execute(input, ctx) {
      // Second check behind the routes' filter: a tool never runs outside its scope, whoever dispatches it.
      if (!toolAllowed(options, ctx)) {
        if (options.scope === "admin" && ctx?.accountId) throw new KnifeToolForbiddenError(options.name);
        throw new Error(`${options.name} needs an account context.`);
      }
      const parsed = options.schema.safeParse(input);
      if (!parsed.success) {
        throw new Error(parsed.error.issues.map((issue) => issue.message).join("; "));
      }
      return options.run(parsed.data, ctx);
    },
  };
}
