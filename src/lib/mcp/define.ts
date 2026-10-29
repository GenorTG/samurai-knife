import * as z from "zod/v4";
import { msgf } from "@/lib/i18n/msg";

/**
 * What a tool may touch, declared by every tool (no default: a new tool must pick one).
 * - `pure`: input in, result out; no account data, no host resources.
 * - `account`: reads or writes the calling account's own data (CV, documents, course progress, its own tabs).
 * - `admin`: reaches what belongs to the server owner (the host's `gh` login, git repos on the host's disk). Offered and
 *   callable only for admins (every account in private mode, `role: "admin"` in public mode).
 */
export type KnifeToolScope = "pure" | "account" | "admin";

/**
 * What a call DOES, declared by every tool (no default: a new tool must pick one). The assistant's approval policy
 * (`src/lib/agent-client/server-tool-policy.ts`) and the MCP tool annotations are derived from it, so a prompt-injected
 * model cannot quietly delete, write or send data out (docs/MCP.md "Tool effects").
 * - `read`: returns information; changes nothing anywhere (pure computations, reading the account's data or its repo).
 * - `write`: changes the account's data or its connected repository (work branch / pull request); recoverable.
 * - `destructive`: deletes or replaces the account's data outright (always confirmed by the widget unless trust is None).
 * - `outbound`: the server sends a request to an address taken from the arguments (`urlArgs`): fetching a page, auditing a
 *   site. Shown with its destination; after untrusted content in the same turn, a host the user did not name is confirmed.
 */
export type KnifeToolEffect = "read" | "write" | "destructive" | "outbound";

export const KNIFE_TOOL_EFFECTS: readonly KnifeToolEffect[] = ["read", "write", "destructive", "outbound"];

/** An argument condition that makes an otherwise `write` call destructive (e.g. `overwrite: true`, a non-empty `delete`). */
export interface DestructiveWhen {
  arg: string;
  when: "true" | "nonEmpty";
}

/** The effect metadata the browser and MCP clients get with each tool (no schema, no code). */
export interface KnifeToolEffectInfo {
  effect: KnifeToolEffect;
  /** Arguments holding a destination URL (outbound tools; also shown in the approval). */
  urlArgs?: string[];
  destructiveWhen?: DestructiveWhen[];
  /** The result carries third-party text inside the untrusted-content envelope (src/lib/security/untrusted.ts). */
  untrustedOutput?: boolean;
  /**
   * A write whose result leaves the account: commits or pull requests on the user's (possibly public) repository. After
   * third-party text was read in the conversation the widget confirms it in every trust mode but None (a publishing
   * channel for injected text or the user's data), and MCP clients see `openWorldHint`.
   */
  publishes?: boolean;
}

/** Who is calling: the resolved account (session or MCP key) and whether it is an admin (`isAdmin`, accounts/authz.ts). */
export interface KnifeToolContext {
  accountId: string;
  admin: boolean;
  /**
   * Who called: the in-page assistant (`/api/agent/tool`, results go to the account's ACTIVE model) or an MCP client
   * (its own model; image blocks allowed). Unset = MCP. Only tools whose answer depends on the reader look at it
   * (knife_site_screenshot: an image for a model that sees, a description for one that does not).
   */
  surface?: "assistant" | "mcp";
  /** A read-only MCP key (docs/MCP.md "Key scopes"): only tools whose effect is "read" are listed and callable. */
  readOnly?: boolean;
}

export interface KnifeToolDefinition extends KnifeToolEffectInfo {
  name: string;
  scope: KnifeToolScope;
  description: string;
  schema: z.ZodType;
  execute(input: unknown, ctx?: KnifeToolContext): Promise<unknown>;
}

export const ADMIN_TOOL_MESSAGE = "needs an administrator on this server (it uses the server owner's own GitHub login or files)";

/** An MCP image content block (base64 `data`): the client shows the image to its model as an image, not as text. */
export interface KnifeImageBlock {
  type: "image";
  data: string;
  mimeType: string;
}

/**
 * A result that carries image blocks after its JSON text (knife_craft_file_read on a picture). MCP-only tools return it;
 * the MCP server sends `value` as the text block, then `images`. No TypeScript parameter properties (type stripping).
 */
export class KnifeRichResult {
  readonly value: unknown;
  readonly images: KnifeImageBlock[];
  constructor(value: unknown, images: KnifeImageBlock[]) {
    this.value = value;
    this.images = images;
  }
}

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

/** Effect metadata only: what `/api/agent/tools` sends the widget alongside the OpenAI definitions. */
export function effectInfo(tool: KnifeToolEffectInfo): KnifeToolEffectInfo {
  return {
    effect: tool.effect,
    ...(tool.urlArgs?.length ? { urlArgs: [...tool.urlArgs] } : {}),
    ...(tool.destructiveWhen?.length ? { destructiveWhen: tool.destructiveWhen.map((d) => ({ ...d })) } : {}),
    ...(tool.untrustedOutput ? { untrustedOutput: true } : {}),
    ...(tool.publishes ? { publishes: true } : {}),
  };
}

export function defineTool<Schema extends z.ZodType>(options: {
  name: string;
  scope: KnifeToolScope;
  effect: KnifeToolEffect;
  urlArgs?: string[];
  destructiveWhen?: DestructiveWhen[];
  untrustedOutput?: boolean;
  publishes?: boolean;
  description: string;
  schema: Schema;
  run(input: z.output<Schema>, ctx?: KnifeToolContext): unknown | Promise<unknown>;
}): KnifeToolDefinition {
  // Fail at module load, not at call time: an outbound tool must name where it goes, and only outbound tools do.
  if (!KNIFE_TOOL_EFFECTS.includes(options.effect)) throw new Error(msgf("{name}: unknown effect {effect}", { name: options.name, effect: String(options.effect) }));
  if ((options.effect === "outbound") !== Boolean(options.urlArgs?.length)) throw new Error(msgf("{name}: urlArgs are required for, and only for, outbound tools", { name: options.name }));
  if (options.publishes && options.effect !== "write") throw new Error(msgf("{name}: only write tools can publish", { name: options.name }));
  return {
    name: options.name,
    scope: options.scope,
    ...effectInfo(options),
    description: options.description,
    schema: options.schema,
    async execute(input, ctx) {
      // Second check behind the routes' filter: a tool never runs outside its scope, whoever dispatches it.
      if (!toolAllowed(options, ctx)) {
        if (options.scope === "admin" && ctx?.accountId) throw new KnifeToolForbiddenError(options.name);
        throw new Error(msgf("{name} needs an account context.", { name: options.name }));
      }
      const parsed = options.schema.safeParse(input);
      if (!parsed.success) {
        throw new Error(parsed.error.issues.map((issue) => issue.message).join("; "));
      }
      return options.run(parsed.data, ctx);
    },
  };
}
