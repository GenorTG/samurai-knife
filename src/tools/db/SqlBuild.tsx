"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ZodError } from "zod/v4";
import { Button, CopyButton, Field, Notice, Panel, Select, TextArea, TextInput } from "@/components/ui";
import { downloadText } from "@/lib/format";
import { openAssistant } from "@/lib/agent-client/bridge";
import { callSql } from "@/lib/sql/client";
import { describeSchema, useStoredDialect, useStoredSchema } from "@/lib/sql/schema-store";
import { BLANK_SPECS, SPEC_EXAMPLES } from "@/lib/sql/spec-examples";
import { querySpecSchema, type QuerySpec, type SelectSpec, type SqlIssue } from "@/lib/sql/types";
import { CreateTableForm, COLUMNS_LIST, DeleteForm, InsertForm, SelectForm, TABLES_LIST, UpdateForm } from "./build/forms";
import { CurrentSchemaRegion, DialectSelect, IssueList } from "./sql-shared";

const OPS: { id: QuerySpec["op"]; label: string }[] = [
  { id: "select", label: "SELECT (read rows)" },
  { id: "insert", label: "INSERT (add rows)" },
  { id: "update", label: "UPDATE (change rows)" },
  { id: "delete", label: "DELETE (remove rows)" },
  { id: "create_table", label: "CREATE TABLE" },
];

const stringify = (spec: QuerySpec) => JSON.stringify(spec, null, 2);

/** Readable problems from a failed spec parse: for the union, report the branch that matches the chosen `op`. */
function specProblems(error: ZodError, op: unknown): string[] {
  const out: string[] = [];
  const visit = (issues: ZodError["issues"]) => {
    for (const issue of issues) {
      if (issue.code === "invalid_union" && "errors" in issue) {
        const branches = issue.errors as ZodError["issues"][];
        const matching = branches.find((b) => !b.some((i) => i.path[0] === "op" && (i.code === "invalid_value" || i.code === "invalid_type"))) ?? branches[0];
        if (matching) visit(matching);
        continue;
      }
      const where = issue.path.length ? `${issue.path.join(".")}: ` : "";
      out.push(`${where}${issue.message}`);
    }
  };
  visit(error.issues);
  if (out.length === 0) out.push(`Unknown or missing "op" (got ${JSON.stringify(op)}).`);
  return [...new Set(out)].slice(0, 6);
}

export default function SqlBuild() {
  const [dialect, setDialect] = useStoredDialect("postgres");
  const [spec, setSpec] = useState<QuerySpec>(SPEC_EXAMPLES[0].spec);
  const [jsonText, setJsonText] = useState(() => stringify(SPEC_EXAMPLES[0].spec));
  const [jsonProblems, setJsonProblems] = useState<string[]>([]);
  const [pretty, setPretty] = useState(true);
  const [compiled, setCompiled] = useState<{ sql: string; params: string[]; issues?: SqlIssue[] } | null>(null);
  const [compileError, setCompileError] = useState<string | null>(null);
  const [task, setTask] = useState("");
  const stored = useStoredSchema();
  const ticket = useRef(0);

  const update = (next: QuerySpec) => {
    setSpec(next);
    setJsonText(stringify(next));
    setJsonProblems([]);
  };

  const onJson = (text: string) => {
    setJsonText(text);
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch (e) {
      setJsonProblems([`Not valid JSON: ${e instanceof Error ? e.message : String(e)}`]);
      return;
    }
    const parsed = querySpecSchema.safeParse(data);
    if (!parsed.success) {
      setJsonProblems(specProblems(parsed.error, (data as { op?: unknown } | null)?.op));
      return;
    }
    setJsonProblems([]);
    setSpec(parsed.data);
  };

  const formProblems = useMemo(() => {
    const parsed = querySpecSchema.safeParse(spec);
    return parsed.success ? [] : specProblems(parsed.error, spec.op);
  }, [spec]);

  useEffect(() => {
    const mine = (ticket.current += 1);
    if (formProblems.length) return;
    const timer = setTimeout(async () => {
      const response = await callSql("compile", { spec, dialect, pretty });
      if (mine !== ticket.current) return;
      if (response.ok) {
        setCompiled(response.data);
        setCompileError(null);
      } else {
        setCompiled(null);
        setCompileError(response.error);
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [spec, dialect, pretty, formProblems]);

  // Names offered for completion: tables used by this query when known, otherwise every table in the stored schema.
  const { tableNames, columnNames } = useMemo(() => {
    const tables = stored?.schema.tables ?? [];
    const used = new Map<string, string>();
    const note = (ref: unknown) => {
      if (typeof ref === "string") used.set(ref.toLowerCase(), ref);
      else if (ref && typeof ref === "object" && "name" in ref) {
        const r = ref as { name: string; as?: string };
        used.set((r.as ?? r.name).toLowerCase(), r.name);
      }
    };
    if (spec.op === "select") {
      const s = spec as SelectSpec;
      note(s.from);
      s.joins?.forEach((j) => note(j.table));
    } else if (spec.op === "create_table") {
      // new table: offer every existing table for references
    } else {
      note(spec.table);
    }
    const scoped = tables.filter((t) => [...used.values()].some((name) => name.toLowerCase() === t.name.toLowerCase()));
    const pool = scoped.length ? scoped : tables;
    const aliasOf = (tableName: string) => [...used.entries()].find(([, name]) => name.toLowerCase() === tableName.toLowerCase())?.[0];
    const cols = new Set<string>();
    for (const t of pool) {
      for (const c of t.columns) {
        cols.add(c.name);
        cols.add(`${aliasOf(t.name) ?? t.name}.${c.name}`);
      }
    }
    return { tableNames: tables.map((t) => t.name), columnNames: [...cols] };
  }, [stored, spec]);

  const askAssistant = () => {
    const schemaText = stored ? describeSchema(stored.schema) : "(no schema stored; ask me for it)";
    const prompt = `Current SQL schema (${dialect} dialect):\n${schemaText}\n\nBuild a QuerySpec for my request and compile it for ${dialect} with the SQL compile tool, then show me the SQL and parameters.\nMy request: ${task.trim() || "(ask me what the query should do)"}`;
    openAssistant(prompt);
  };

  // An incomplete spec is never sent to the engine; whatever was compiled before is hidden, not discarded mid-render.
  const result = formProblems.length ? null : compiled;
  const resultError = formProblems.length ? null : compileError;
  const problems = [...jsonProblems, ...(jsonProblems.length ? [] : formProblems)];

  return (
    <div className="space-y-4">
      <datalist id={TABLES_LIST}>{tableNames.map((n) => <option key={n} value={n} />)}</datalist>
      <datalist id={COLUMNS_LIST}>{columnNames.map((n) => <option key={n} value={n} />)}</datalist>

      <Panel title="Start from an example">
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Example queries">
          {SPEC_EXAMPLES.map((example) => (
            <Button key={example.id} size="sm" onClick={() => update(example.spec)}>{example.label}</Button>
          ))}
        </div>
        <p className="mt-2 text-xs text-faint">Examples use the sample shop schema (Schema tab → Sample: shop → Use as current schema) for name completion.</p>
      </Panel>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Panel title="Query form" bodyClassName="space-y-4">
          <Field label="Statement type">
            <Select aria-label="Statement type" className="max-w-72" value={spec.op} onChange={(e) => update(BLANK_SPECS[e.target.value as QuerySpec["op"]])}>
              {OPS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </Select>
          </Field>
          {spec.op === "select" ? <SelectForm spec={spec as SelectSpec} onChange={update} /> : null}
          {spec.op === "insert" ? <InsertForm spec={spec} onChange={update} /> : null}
          {spec.op === "update" ? <UpdateForm spec={spec} onChange={update} /> : null}
          {spec.op === "delete" ? <DeleteForm spec={spec} onChange={update} /> : null}
          {spec.op === "create_table" ? <CreateTableForm spec={spec} onChange={update} /> : null}
        </Panel>

        <div className="min-w-0 space-y-4">
          <Panel
            title="Compiled SQL"
            right={
              <div className="flex gap-1.5">
                <CopyButton text={result?.sql ?? ""} label="Copy SQL" />
                <Button size="sm" disabled={!result} onClick={() => downloadText(`${result?.sql ?? ""}\n`, `query-${dialect}.sql`, "application/sql")}>Download .sql</Button>
              </div>
            }
          >
            <div className="space-y-3">
              <div className="flex flex-wrap items-end gap-3">
                <Field label="Dialect" className="w-64 max-w-full">
                  <DialectSelect label="Dialect" value={dialect} onChange={setDialect} />
                </Field>
                <label className="flex h-10 cursor-pointer items-center gap-2 text-sm text-muted">
                  <input type="checkbox" checked={pretty} onChange={(e) => setPretty(e.target.checked)} className="size-4 accent-[var(--c-accent)]" />
                  Pretty-print
                </label>
              </div>
              <pre aria-label="Compiled SQL" data-agent-region="compiled-sql" className="sk-input max-h-[50vh] min-h-32 overflow-auto px-3 py-2.5 font-mono text-[13px] leading-relaxed whitespace-pre-wrap break-words">
                {result?.sql || <span className="text-faint">{resultError ? "This spec could not be compiled; see the message below." : "Fill in the form (or edit the JSON) and the SQL appears here."}</span>}
              </pre>
              {result ? (
                <div data-agent-region="compiled-params">
                  <h3 className="sk-label">Parameters (binding order)</h3>
                  {result.params.length ? (
                    <ol className="mt-1 list-inside list-decimal font-mono text-[13px] text-ink">
                      {result.params.map((p, i) => <li key={`${p}-${i}`}>{p}</li>)}
                    </ol>
                  ) : (
                    <p className="text-sm text-faint">No parameters: every value is a literal.</p>
                  )}
                </div>
              ) : null}
              {result?.issues?.length ? <IssueList issues={result.issues} /> : null}
              {problems.length ? (
                <div role="alert">
                  <Notice tone="warn">
                    The query is not complete yet:
                    {problems.map((p) => <span key={p} className="block font-mono text-xs">• {p}</span>)}
                  </Notice>
                </div>
              ) : null}
              {resultError ? <div role="alert"><Notice tone="error">{resultError}</Notice></div> : null}
            </div>
          </Panel>

          <Panel title="Query spec (JSON)" right={<CopyButton text={jsonText} label="Copy spec JSON" />}>
            <Field label="QuerySpec JSON" hint="Edits here update the form, and form edits rewrite this JSON. Strings in values are literals; use {&quot;col&quot;: …} for columns and {&quot;param&quot;: …} for parameters.">
              <TextArea aria-label="QuerySpec JSON" rows={16} spellCheck={false} value={jsonText} onChange={(e) => onJson(e.target.value)} />
            </Field>
          </Panel>
        </div>
      </div>

      <Panel title="Ask the assistant">
        <div className="space-y-3">
          <CurrentSchemaRegion />
          <Field label="What should the query do?" hint="Opens the assistant with your current schema and this request; it builds a QuerySpec and compiles it.">
            <TextInput value={task} onChange={(e) => setTask(e.target.value)} placeholder="e.g. monthly revenue per country for paid orders" />
          </Field>
          <Button variant="primary" onClick={askAssistant}>Ask the assistant to build this query</Button>
        </div>
      </Panel>
    </div>
  );
}
