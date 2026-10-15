import type { FunctionToolDef, TranscriptMessage } from "./types";

/**
 * On-demand tool groups. Every tool definition is re-sent on EVERY model round (about 22k characters for the
 * database tools alone), so the database groups stay out of the request until a turn needs them:
 * preloaded on their own lab pages and whenever the conversation already used them, otherwise the model calls
 * `load_tools {group}` once. Loading appends to the end of the tool list so the cached request prefix before it is kept.
 * MCP and the HTTP tool endpoint are unaffected (they list everything).
 */

export interface ToolGroup {
  id: string;
  /** Tool-name prefixes that belong to the group. */
  prefixes: readonly string[];
  /** Lab pages on which the group is preloaded. */
  pagePattern: RegExp;
  summary: string;
  /** false = only preloaded on its page, never offered by load_tools (its tools cannot run anywhere else). */
  loadable?: boolean;
}

export const TOOL_GROUPS: readonly ToolGroup[] = [
  { id: "sql", prefixes: ["knife_sql_"], pagePattern: /^\/tools\/sql-lab(\/|$)/, summary: "SQL: compile a JSON query spec for 14 dialects, transpile between dialects, validate, format, DDL to schema, check SQL against a schema" },
  { id: "cv", prefixes: ["knife_cv_"], pagePattern: /^\/tools\/cv-studio(\/|$)/, summary: "CV studio: read/edit the bilingual (PL/EN) master CV profile, undo, audit wording and translations, save job offers, match them against the profile, create per-job CV versions with per-offer rewording and an ATS check, track applications, add projects from GitHub links" },
  { id: "docs", prefixes: ["knife_doc_"], pagePattern: /^\/tools\/office(\/|$)/, summary: "Office documents: list the user's docx/xlsx/pptx/odt/ods/odp library, read a document as text, create a new document with content" },
  // Tutor tools, preloaded on the course page only (MCP clients get them anyway).
  { id: "learn", prefixes: ["knife_learn_"], pagePattern: /^\/tools\/db-course(\/|$)/, summary: "Database course tutor: lessons, the learner's last query/error, SQL in the course sandbox", loadable: false },
  { id: "nosql", prefixes: ["knife_mongo_", "knife_chroma_", "knife_redis_"], pagePattern: /^\/tools\/nosql-lab(\/|$)/, summary: "NoSQL and vector: MongoDB, Chroma and Redis operation specs to client code, validation and explanation" },
  // Browser-side (office-live-tools.ts); besides being loaded, each tool is offered only while an editor of its type is connected.
  { id: "office_live", prefixes: ["doc_live_"], pagePattern: /^\/tools\/office(\/|$)/, summary: "live edits in the document open in the office editor", loadable: false },
];

export const LOAD_TOOLS_NAME = "load_tools";

export function groupOf(toolName: string): ToolGroup | null {
  return TOOL_GROUPS.find((g) => g.prefixes.some((p) => toolName.startsWith(p))) ?? null;
}

/** Groups available at the start of a run: the lab page's own, plus any group the conversation already used. */
export function initialGroups(pathname: string, transcript: readonly TranscriptMessage[]): Set<string> {
  const active = new Set<string>();
  for (const g of TOOL_GROUPS) if (g.pagePattern.test(pathname)) active.add(g.id);
  for (const m of transcript) {
    if (m.role !== "assistant" || !m.tool_calls) continue;
    for (const call of m.tool_calls) {
      const g = groupOf(call.function.name);
      if (g) active.add(g.id);
      else if (call.function.name === LOAD_TOOLS_NAME) {
        try {
          const wanted = (JSON.parse(call.function.arguments) as { group?: unknown }).group;
          if (TOOL_GROUPS.some((t) => t.id === wanted)) active.add(wanted as string);
        } catch {
          /* malformed arguments: the call failed, nothing to restore */
        }
      }
    }
  }
  return active;
}

const loadable = (): ToolGroup[] => TOOL_GROUPS.filter((g) => g.loadable !== false);

export function loadToolsDef(): FunctionToolDef {
  return {
    type: "function",
    function: {
      name: LOAD_TOOLS_NAME,
      description: `Make a group of specialist tools available for the rest of this conversation (one call, then use them right away). Groups: ${loadable().map((g) => `${g.id} = ${g.summary}`).join("; ")}. Not needed on the sql-lab / nosql-lab / cv-studio / office pages (already loaded).`,
      parameters: {
        type: "object",
        properties: { group: { type: "string", enum: loadable().map((g) => g.id), description: "Which group to load." } },
        required: ["group"],
        additionalProperties: false,
      },
    },
  };
}

/**
 * The tools to send this round: everything except groups that are not loaded, and tools the page cannot run right now
 * (`available`, e.g. doc_live_* without a connected editor).
 */
export function visibleTools(all: readonly FunctionToolDef[], active: ReadonlySet<string>, available: (name: string) => boolean = () => true): FunctionToolDef[] {
  return all.filter((d) => {
    const g = groupOf(d.function.name);
    return (!g || active.has(g.id)) && available(d.function.name);
  });
}

export function runLoadTools(args: Record<string, unknown>, active: Set<string>, all: readonly FunctionToolDef[]): { ok: boolean; content: string } {
  const id = typeof args.group === "string" ? args.group : "";
  const group = loadable().find((g) => g.id === id);
  if (!group) return { ok: false, content: JSON.stringify({ ok: false, error: `Unknown group "${id}". Groups: ${loadable().map((g) => g.id).join(", ")}.` }) };
  const names = all.map((d) => d.function.name).filter((n) => groupOf(n)?.id === group.id);
  const already = active.has(group.id);
  active.add(group.id);
  return { ok: true, content: JSON.stringify({ ok: true, group: group.id, tools: names, note: already ? "Already loaded." : "Loaded: call these tools now (they are available from the next step)." }) };
}
