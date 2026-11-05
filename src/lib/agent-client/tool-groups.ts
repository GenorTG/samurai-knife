import type { FunctionToolDef, TranscriptMessage } from "./types";

/**
 * On-demand tool groups. Every tool definition is re-sent on EVERY model round (about 32k characters for the CV tools
 * alone), so a group stays out of the request until a turn needs it: preloaded on its own page and while one of the
 * last GROUP_TURNS turns used it, otherwise the model calls `load_tools {group}` once. The instructions of an active group
 * go with it (system-prompt.ts). MCP and the HTTP tool endpoint are unaffected (they list everything).
 */

export interface ToolGroup {
  id: string;
  /** Tool-name prefixes that belong to the group. */
  prefixes: readonly string[];
  /** Pages on which the group is preloaded, matched against pathname + search. */
  pagePattern: RegExp;
  summary: string;
  /** false = only preloaded on its page, never offered by load_tools (its tools cannot run anywhere else). */
  loadable?: boolean;
}

export const TOOL_GROUPS: readonly ToolGroup[] = [
  { id: "goals", prefixes: ["knife_goal_"], pagePattern: /(?!)/, summary: "saved tasks for multi-step work" },
  { id: "sql", prefixes: ["knife_sql_"], pagePattern: /^\/tools\/sql-lab(?:[/?]|$)/, summary: "SQL: compile a JSON query spec for 14 dialects, transpile between dialects, validate, format, DDL to schema, check SQL against a schema" },
  { id: "cv", prefixes: ["knife_cv_"], pagePattern: /^\/tools\/cv-studio(?:[/?]|$)/, summary: "CV builder: the bilingual (PL/EN) master CV (read, edit, undo, audit), job offers matched against it, per-job CV versions with an ATS check, applications, projects from GitHub" },
  { id: "site", prefixes: ["knife_site_", "knife_vision_"], pagePattern: /^\/tools\/cv-studio\?(?:.*&)?tab=website(?:&|$)/, summary: "the user's website: audit scores, screenshots, repo files, changes as a pull request" },
  { id: "workflows", prefixes: ["knife_workflow_"], pagePattern: /^\/tools\/workflows(?:[/?]|$)/, summary: "Workflows (automations): node catalog, build, edit, run, run results" },
  { id: "docs", prefixes: ["knife_doc_"], pagePattern: /^\/tools\/office(?:[/?]|$)/, summary: "Office documents: list, read as text (or a version), create, folders, move, versions" },
  // Tutor tools, preloaded on the course page only (MCP clients get them anyway).
  { id: "learn", prefixes: ["knife_learn_"], pagePattern: /^\/tools\/db-course(?:[/?]|$)/, summary: "Database course tutor: lessons, the learner's last query/error, SQL in the course sandbox", loadable: false },
  { id: "nosql", prefixes: ["knife_mongo_", "knife_chroma_", "knife_redis_"], pagePattern: /(?!)/ /* no page of its own since the NoSQL lab was removed (2026-10-25): load_tools only */, summary: "NoSQL and vector: MongoDB, Chroma and Redis operation specs to client code, validation and explanation" },
  // Browser-side (office-live-tools.ts); besides being loaded, each tool is offered only while an editor of its type is connected.
  { id: "office_live", prefixes: ["doc_live_"], pagePattern: /^\/tools\/office(?:[/?]|$)/, summary: "live edits in the document open in the office editor", loadable: false },
  // Browser-side (craft-live-tools.ts); offered only while a Craft app with an agent API is connected.
  { id: "craft_live", prefixes: ["craft_"], pagePattern: /^\/tools\/artcraft(?:[/?]|$)/, summary: "read and drive the Craft app open on the page (commands, UI, screenshots, files)", loadable: false },
];

export const LOAD_TOOLS_NAME = "load_tools";

export function groupOf(toolName: string): ToolGroup | null {
  return TOOL_GROUPS.find((g) => g.prefixes.some((p) => toolName.startsWith(p))) ?? null;
}

/** A loaded group stays this many turns after its last use (the running one included), then needs load_tools again. */
export const GROUP_TURNS = 3;

/** Add the groups of the page the user is on (a run may navigate: call again after that). `location` = pathname + search. */
export function addPageGroups(active: Set<string>, location: string): void {
  for (const g of TOOL_GROUPS) if (g.pagePattern.test(location)) active.add(g.id);
}

/** Groups available at the start of a run: the page's own, plus any group the last GROUP_TURNS turns used. */
export function initialGroups(location: string, transcript: readonly TranscriptMessage[]): Set<string> {
  const active = new Set<string>();
  addPageGroups(active, location);
  let turns = 0;
  for (let i = transcript.length - 1; i >= 0 && turns < GROUP_TURNS; i -= 1) {
    const m = transcript[i];
    if (m.role === "user") turns += 1;
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
      description: `Make a group of specialist tools and their instructions available (one call, then use them right away; they stay while you keep using them). Groups: ${loadable().map((g) => `${g.id} = ${g.summary}`).join("; ")}. Each tool's own page (sql-lab, cv-studio, office) has its group already loaded.`,
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
  return { ok: true, content: JSON.stringify({ ok: true, group: group.id, tools: names, note: already ? "Already loaded." : "Loaded: call these tools now (they are available from the next step; their instructions are in your system prompt then, follow them)." }) };
}
