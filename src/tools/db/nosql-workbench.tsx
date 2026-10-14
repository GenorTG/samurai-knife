"use client";

/**
 * Shared UI of the NoSQL lab tabs (MongoDB, Chroma, Redis): a JSON spec editor with a form for the common
 * operations, generated code per client library, problems with plain-language fixes, a step-by-step
 * explanation, an examples gallery and an "ask the assistant" hand-off. Each tab supplies a `StoreAdapter`
 * (pure functions from src/lib/nosql/*) and its own form.
 *
 * Agent friendliness: every control has a visible label, results live in <pre>/<output>/<ol> blocks with
 * data-agent-region, errors are role="alert" text, downloads go through downloadBlob.
 */
import { useId, useMemo, useState, type ReactNode } from "react";
import { Button, CopyButton, Field, Notice, Panel, TextArea } from "@/components/ui";
import { openAssistant } from "@/lib/agent-client/bridge";
import { copyText, cx, downloadBlob } from "@/lib/format";
import {
  lineColumn,
  parseJsonLossless,
  stringifyLossless,
  type CompileOptions,
  type CompileResult,
  type NosqlIssue,
  type Snippet,
} from "@/lib/nosql/common";

/* ------------------------------------------------------------------- adapter */

export interface ParsedSpec {
  spec?: unknown;
  issues: NosqlIssue[];
  /** text was not plain JSON but was understood (mongosh syntax, redis-cli lines) */
  converted?: boolean;
}

export interface StoreAdapter {
  id: "mongo" | "chroma" | "redis";
  /** Display name: "MongoDB" */
  name: string;
  /** What the spec describes, for labels and the assistant prompt: "MongoDB operation" */
  noun: string;
  /** Knife tools the assistant should use for this store. */
  tools: { compile: string; validate: string; explain?: string };
  parse(text: string): ParsedSpec;
  compile(spec: unknown, options?: CompileOptions): CompileResult;
  validate(spec: unknown): { ok: boolean; issues: NosqlIssue[] };
  explain(spec: unknown): string[];
  examples: { id: string; title: string; description: string; spec: unknown }[];
}

export function parseJsonSpec(text: string): ParsedSpec {
  const parsed = parseJsonLossless(text);
  if (parsed.ok) return { spec: parsed.value, issues: [] };
  const where = lineColumn(text, parsed.offset);
  return { issues: [{ severity: "error", path: "(spec)", message: `Not valid JSON: ${parsed.message} (line ${where.line}, column ${where.column}).`, fix: "Fix the JSON, or load an example to start from a working spec." }] };
}

export function specToText(spec: unknown): string {
  return stringifyLossless(spec, 2);
}

/* ------------------------------------------------------------- small helpers */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Returns a copy of `obj` without undefined values, keys ordered by `order` (unknown keys keep their place at the end). */
export function orderKeys(obj: Record<string, unknown>, order: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of order) if (obj[key] !== undefined) out[key] = obj[key];
  for (const key of Object.keys(obj)) if (!(key in out) && obj[key] !== undefined) out[key] = obj[key];
  return out;
}

function compactOrPretty(value: unknown): string {
  const flat = stringifyLossless(value, 0);
  return flat.length <= 64 ? flat : stringifyLossless(value, 2);
}

function slug(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function fileNameFor(snippet: Snippet): string {
  const ext = snippet.language === "python" ? "py" : snippet.language === "shell" ? "txt" : snippet.language === "json" ? "json" : snippet.label.startsWith("mongosh") ? "js" : "mjs";
  return `${slug(snippet.label) || "snippet"}.${ext}`;
}

const SEVERITY_LABEL = { error: "Error", warning: "Warning", info: "Tip" } as const;
const SEVERITY_CLASS = {
  error: "border-danger/40 bg-danger/10 text-danger",
  warning: "border-warn/40 bg-warn/10 text-warn",
  info: "border-line-strong bg-raised/60 text-muted",
} as const;

export function buildAssistantPrompt(adapter: StoreAdapter, specText: string, issues: NosqlIssue[]): string {
  const problems = issues.filter((i) => i.severity !== "info").map((i) => `- ${i.severity} at ${i.path}: ${i.message}${i.fix ? ` (${i.fix})` : ""}`);
  return [
    `I'm on the NoSQL lab, ${adapter.name} tab. This is my ${adapter.noun} spec:`,
    "",
    "```json",
    specText.trim() || "(empty)",
    "```",
    "",
    problems.length ? `The page reports:\n${problems.join("\n")}` : "The page reports no errors or warnings.",
    "",
    `Please check it with ${adapter.tools.validate}, explain in plain words what it does, fix anything wrong, and use ${adapter.tools.compile} for the final code. Then put the corrected spec into the "${adapter.name} spec (JSON)" editor on this page.`,
  ].join("\n");
}

/* ----------------------------------------------------------------- form bits */

/** A text area bound to one JSON value of the spec; keeps its own draft while the JSON is incomplete. */
export function JsonField({ label, hint, value, onValue, rows = 3 }: { label: string; hint?: ReactNode; value: unknown; onValue: (value: unknown) => void; rows?: number }) {
  const external = value === undefined ? "" : stringifyLossless(value, 0);
  const [draft, setDraft] = useState(() => (value === undefined ? "" : compactOrPretty(value)));
  const [seen, setSeen] = useState(external);
  const [error, setError] = useState<string | null>(null);
  // adjust state during render when the spec changed from outside (editor, example, other form field)
  if (external !== seen) {
    setSeen(external);
    const mine = draft.trim() ? parseJsonLossless(draft) : null;
    const draftValue = mine && mine.ok ? stringifyLossless(mine.value, 0) : draft.trim() ? null : "";
    if (draftValue !== external) {
      setDraft(value === undefined ? "" : compactOrPretty(value));
      setError(null);
    }
  }
  const errorId = useId();
  return (
    <Field label={label} hint={hint}>
      <TextArea
        rows={rows}
        spellCheck={false}
        value={draft}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        onChange={(event) => {
          const text = event.target.value;
          setDraft(text);
          if (!text.trim()) {
            setError(null);
            setSeen("");
            onValue(undefined);
            return;
          }
          const parsed = parseJsonLossless(text);
          if (parsed.ok) {
            setError(null);
            setSeen(stringifyLossless(parsed.value, 0));
            onValue(parsed.value);
          } else setError(parsed.message);
        }}
      />
      {error ? (
        <span id={errorId} role="alert" className="block text-xs text-danger">
          {label}: not valid JSON yet ({error}). The spec keeps its previous value until this parses.
        </span>
      ) : null}
    </Field>
  );
}

/** Small boxed section of related form fields. */
export function FormGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="min-w-0 space-y-3 rounded-lg border border-line p-3">
      <legend className="px-1 text-xs font-semibold text-muted">{title}</legend>
      {children}
    </fieldset>
  );
}

export function CheckBox({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-sm text-ink">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="size-4 accent-[var(--color-accent)]" />
      {label}
    </label>
  );
}

/* ------------------------------------------------------------------ workbench */

export function NosqlWorkbench({
  adapter,
  initialText,
  renderForm,
  extra,
}: {
  adapter: StoreAdapter;
  initialText: string;
  /** The quick form, shown while the editor text parses to an object: reads that spec, writes a new one. */
  renderForm: (props: { spec: Record<string, unknown>; setSpec: (spec: Record<string, unknown>) => void }) => ReactNode;
  extra?: ReactNode;
}) {
  const [text, setText] = useState(initialText);
  const [compact, setCompact] = useState(false);
  const [shown, setShown] = useState<string>("all");
  const [explainOpen, setExplainOpen] = useState(true);

  const parsed = useMemo(() => adapter.parse(text), [adapter, text]);
  const result = useMemo(() => {
    if (parsed.spec === undefined) return null;
    return adapter.compile(parsed.spec, { compact });
  }, [adapter, parsed.spec, compact]);
  const steps = useMemo(() => (parsed.spec === undefined ? [] : adapter.explain(parsed.spec)), [adapter, parsed.spec]);

  const issues = useMemo<NosqlIssue[]>(() => {
    if (!text.trim()) return [{ severity: "error", path: "(spec)", message: "The spec is empty.", fix: "Write a JSON spec or load an example." }];
    const own = parsed.issues;
    if (!result) return own;
    const seen = new Set<string>();
    return [...own, ...result.issues].filter((i) => {
      const key = `${i.severity}|${i.path}|${i.message}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [parsed.issues, result, text]);

  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");
  const tips = issues.filter((i) => i.severity === "info" && i.path !== "(spec)");
  const formSpec = parsed.spec !== undefined && isRecord(parsed.spec) ? parsed.spec : null;
  const snippets = result?.snippets ?? [];
  const visible = shown === "all" ? snippets : snippets.filter((s) => s.label === shown);
  const specId = useId();

  return (
    <div className="flex flex-col gap-4 lg:grid lg:grid-cols-2 lg:items-start">
      {/* below lg the wrappers dissolve and `order` puts the results right after the editor; lg shows two columns */}
      <div className="contents min-w-0 lg:block lg:space-y-4">
        <Panel title={`${adapter.name} form`} className="order-1 lg:order-none" bodyClassName="space-y-3">
          {formSpec ? (
            renderForm({ spec: formSpec, setSpec: (next) => setText(specToText(next)) })
          ) : (
            <Notice>The form needs a spec it can read: fix the JSON below, or load an example.</Notice>
          )}
        </Panel>

        <Panel
          className="order-2 lg:order-none"
          title={`${adapter.name} spec (JSON)`}
          right={
            <div className="flex flex-wrap gap-1.5">
              <CopyButton text={text} label="Copy spec" />
              <Button size="sm" variant="subtle" disabled={!text.trim()} onClick={() => downloadBlob(new Blob([text], { type: "application/json" }), `${adapter.id}-spec.json`)}>
                Save spec as .json
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setText("")}>
                Clear spec
              </Button>
            </div>
          }
          bodyClassName="space-y-3"
        >
          <Field label={`${adapter.name} spec (JSON)`} hint={adapter.id === "redis" ? "JSON, or redis-cli lines, one command per line." : adapter.id === "mongo" ? "JSON in Extended JSON form; mongosh syntax like ObjectId(\"…\") is converted for you." : "JSON. Both Python and JavaScript code are generated from it."}>
            <TextArea id={specId} rows={14} spellCheck={false} value={text} onChange={(event) => setText(event.target.value)} placeholder={'{ "op": "find", "collection": "users", "filter": {} }'} />
          </Field>
          {parsed.converted && parsed.spec !== undefined ? (
            <div className="flex flex-wrap items-center gap-2">
              <Notice tone="info">Read your text as {adapter.id === "redis" ? "redis-cli lines" : "mongosh syntax"} and converted it.</Notice>
              <Button size="sm" variant="subtle" onClick={() => setText(specToText(parsed.spec))}>
                Replace editor text with JSON
              </Button>
            </div>
          ) : null}
        </Panel>

        <Panel title="Examples" className="order-4 lg:order-none" bodyClassName="space-y-2">
          <p className="text-xs text-faint">Pick one to start from a working spec; it replaces the editor text.</p>
          <ul className="grid gap-2 sm:grid-cols-2" aria-label={`${adapter.name} examples`}>
            {adapter.examples.map((example) => (
              <li key={example.id} className="min-w-0">
                <button
                  autoComplete="off"
                  type="button"
                  aria-label={`Load example: ${example.title}`}
                  onClick={() => setText(specToText(example.spec))}
                  className="h-full w-full cursor-pointer rounded-lg border border-line bg-surface px-3 py-2 text-left transition-colors hover:border-faint hover:bg-raised"
                >
                  <span className="block text-[13px] font-medium break-words text-ink">{example.title}</span>
                  <span className="block text-xs break-words text-faint">{example.description}</span>
                </button>
              </li>
            ))}
          </ul>
        </Panel>
        {extra ? <div className="order-5 min-w-0 lg:order-none">{extra}</div> : null}
      </div>

      <div className="order-3 min-w-0 space-y-4 lg:order-none">
        <Panel
          title="Problems"
          right={
            <Button size="sm" variant="subtle" onClick={() => openAssistant(buildAssistantPrompt(adapter, text, issues))}>
              Ask the assistant about this spec
            </Button>
          }
          bodyClassName="space-y-3"
        >
          <div data-agent-region="problems" className="space-y-3">
            {errors.length ? (
              <div role="alert" className="space-y-2">
                <p className="text-sm font-semibold text-danger">
                  {errors.length} error{errors.length === 1 ? "" : "s"}: no code is generated until they are fixed.
                </p>
                <IssueList issues={errors} />
              </div>
            ) : (
              <Notice tone="good">{result?.ok ? `The ${adapter.noun} is valid.` : "Waiting for a spec."}</Notice>
            )}
            {warnings.length ? (
              <div className="space-y-2">
                <p className="text-sm font-semibold text-warn">
                  {warnings.length} warning{warnings.length === 1 ? "" : "s"}
                </p>
                <IssueList issues={warnings} />
              </div>
            ) : null}
            {tips.length ? (
              <details>
                <summary className="cursor-pointer text-sm text-muted">
                  {tips.length} tip{tips.length === 1 ? "" : "s"}
                </summary>
                <div className="mt-2">
                  <IssueList issues={tips} />
                </div>
              </details>
            ) : null}
          </div>
        </Panel>

        <Panel
          title="Generated code"
          right={
            <div className="flex flex-wrap items-center gap-2">
              <CheckBox label="Compact (no wrapping)" checked={compact} onChange={setCompact} />
            </div>
          }
          bodyClassName="space-y-3"
        >
          {snippets.length > 1 ? (
            <div role="group" aria-label="Show code for" className="flex flex-wrap gap-1.5">
              {["all", ...snippets.map((s) => s.label)].map((label) => (
                <Button key={label} size="sm" variant={shown === label ? "primary" : "subtle"} aria-pressed={shown === label} onClick={() => setShown(label)}>
                  {label === "all" ? "All" : label}
                </Button>
              ))}
            </div>
          ) : null}
          {snippets.length === 0 ? (
            <Notice>{errors.length ? "Fix the errors above to see the code." : "Code appears here."}</Notice>
          ) : (
            <div data-agent-region="generated-code" className="space-y-3">
              {visible.map((snippet) => (
                <SnippetBlock key={snippet.label} snippet={snippet} />
              ))}
            </div>
          )}
        </Panel>

        <Panel
          title="What this does"
          right={
            <Button size="sm" variant="ghost" aria-expanded={explainOpen} onClick={() => setExplainOpen((v) => !v)}>
              {explainOpen ? "Hide steps" : "Show steps"}
            </Button>
          }
        >
          {explainOpen ? (
            steps.length ? (
              <ol data-agent-region="explanation" className="list-decimal space-y-1.5 pl-5 text-[13px] leading-relaxed break-words text-ink">
                {steps.map((step, index) => (
                  <li key={index}>{step}</li>
                ))}
              </ol>
            ) : (
              <p className="text-sm text-faint">Steps appear once the spec has no structural errors.</p>
            )
          ) : null}
        </Panel>
      </div>
    </div>
  );
}

function IssueList({ issues }: { issues: NosqlIssue[] }) {
  return (
    <ul className="space-y-2">
      {issues.map((issue, index) => (
        <li key={`${issue.path}-${index}`} className={cx("rounded-lg border px-3 py-2 text-[13px] leading-relaxed break-words", SEVERITY_CLASS[issue.severity])}>
          <span className="font-semibold">{SEVERITY_LABEL[issue.severity]}</span> <code className="rounded bg-surface/70 px-1 font-mono text-[12px] break-all">{issue.path}</code>: {issue.message}
          {issue.fix ? <span className="mt-0.5 block text-ink/80">How to fix: {issue.fix}</span> : null}
        </li>
      ))}
    </ul>
  );
}

/** CopyButton with an accessible name that says what is copied (several of them sit on one page). */
function NamedCopy({ text, name }: { text: string; name: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      size="sm"
      variant={done ? "primary" : "subtle"}
      aria-label={`Copy ${name}`}
      disabled={!text}
      onClick={async () => {
        if (await copyText(text)) {
          setDone(true);
          setTimeout(() => setDone(false), 1400);
        }
      }}
    >
      {done ? "Copied" : "Copy"}
    </Button>
  );
}

function SnippetBlock({ snippet }: { snippet: Snippet }) {
  return (
    <section aria-label={`${snippet.label} code`} className="min-w-0 space-y-1.5">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="min-w-0 text-[13px] font-semibold break-words text-ink">{snippet.label}</h3>
        <div className="flex flex-wrap gap-1.5">
          <NamedCopy text={snippet.code} name={snippet.label} />
          <Button size="sm" variant="subtle" aria-label={`Save ${snippet.label} as file`} onClick={() => downloadBlob(new Blob([snippet.code], { type: "text/plain;charset=utf-8" }), fileNameFor(snippet))}>
            Save as file
          </Button>
        </div>
      </header>
      <pre aria-label={`${snippet.label} code`} data-language={snippet.language} className="sk-input max-h-[46vh] overflow-auto px-3 py-2.5 font-mono text-[12px] leading-relaxed whitespace-pre">
        {snippet.code}
      </pre>
    </section>
  );
}
