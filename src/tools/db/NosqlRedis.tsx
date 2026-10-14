"use client";

import { useId, useMemo, useState } from "react";
import { Field, Notice, Panel, Select, TextArea, TextInput } from "@/components/ui";
import { cliToken } from "@/lib/nosql/common";
import * as redis from "@/lib/nosql/redis";
import { PITFALLS, syntaxOf } from "@/lib/nosql/redis-grammar";
import { CheckBox, FormGroup, NosqlWorkbench, isRecord, orderKeys, parseJsonSpec, specToText, type ParsedSpec, type StoreAdapter } from "./nosql-workbench";

function parse(text: string): ParsedSpec {
  const json = parseJsonSpec(text);
  if (json.spec !== undefined) return json;
  const lines = redis.parseCommandLines(text);
  if (lines.spec) return { spec: lines.spec, issues: [], converted: true };
  return json;
}

const adapter: StoreAdapter = {
  id: "redis",
  name: "Redis",
  noun: "Redis command list",
  tools: { compile: "knife_redis_compile", validate: "knife_redis_validate" },
  parse,
  compile: redis.compile,
  validate: redis.validate,
  explain: redis.explain,
  examples: redis.REDIS_EXAMPLES,
};

const KEY_ORDER = ["mode", "connection", "ops"];

/** The ops as redis-cli lines, or null when an argument cannot be written on a command line. */
function opsToLines(ops: unknown): string | null {
  if (!Array.isArray(ops)) return null;
  const lines: string[] = [];
  for (const op of ops) {
    if (!isRecord(op) || typeof op.command !== "string") return null;
    const args = Array.isArray(op.args) ? op.args : [];
    if (!args.every((a) => typeof a === "string" || typeof a === "number")) return null;
    lines.push([...op.command.trim().split(/\s+/), ...args.map(String)].map(cliToken).join(" "));
  }
  return lines.join("\n");
}

function RedisForm({ spec, setSpec }: { spec: Record<string, unknown>; setSpec: (spec: Record<string, unknown>) => void }) {
  const write = (patch: Record<string, unknown>) => setSpec(orderKeys({ ...spec, ...patch }, KEY_ORDER));
  const connection = isRecord(spec.connection) ? spec.connection : {};
  const writeConnection = (patch: Record<string, unknown>) => {
    const next = Object.fromEntries(Object.entries({ ...connection, ...patch }).filter(([, value]) => value !== undefined && value !== "" && value !== false));
    write({ connection: Object.keys(next).length ? next : undefined });
  };
  const external = opsToLines(spec.ops);
  const [draft, setDraft] = useState(external ?? "");
  const [seen, setSeen] = useState(external);
  const [error, setError] = useState<string | null>(null);
  if (external !== seen) {
    setSeen(external);
    const mine = redis.parseCommandLines(draft);
    if (external !== null && !(mine.spec && opsToLines(mine.spec.ops) === external)) {
      setDraft(external);
      setError(null);
    }
  }
  const errorId = useId();
  const mode = typeof spec.mode === "string" ? spec.mode : "sequential";
  return (
    <>
      {external === null ? (
        <Notice tone="warn">Some arguments in the spec are not plain strings or numbers, so they cannot be shown as command lines. Edit the JSON below.</Notice>
      ) : (
        <Field label="Commands (one redis-cli command per line)" hint='Same quoting as redis-cli: SET greeting "hello world" EX 60. Lines starting with # are ignored.'>
          <TextArea
            rows={7}
            spellCheck={false}
            value={draft}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            onChange={(event) => {
              const text = event.target.value;
              setDraft(text);
              const parsed = redis.parseCommandLines(text);
              if (parsed.spec) {
                setError(null);
                setSeen(opsToLines(parsed.spec.ops));
                write({ ops: parsed.spec.ops });
              } else setError(parsed.issues.map((i) => `${i.path}: ${i.message}`).join(" "));
            }}
          />
          {error ? (
            <span id={errorId} role="alert" className="block text-xs text-danger">
              Commands: {error} The spec keeps its previous commands until this parses.
            </span>
          ) : null}
        </Field>
      )}
      <Field label="How to run them" hint="Pipeline = one round trip. Transaction = MULTI/EXEC, all-or-nothing, nothing in between.">
        <Select value={mode} onChange={(event) => write({ mode: event.target.value === "sequential" ? undefined : event.target.value })}>
          <option value="sequential">One after another</option>
          <option value="pipeline">Pipeline (one round trip)</option>
          <option value="transaction">Transaction (MULTI / EXEC)</option>
        </Select>
      </Field>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Host">
          <TextInput value={typeof connection.host === "string" ? connection.host : ""} onChange={(event) => writeConnection({ host: event.target.value })} placeholder="localhost" />
        </Field>
        <Field label="Port">
          <TextInput type="number" min={1} max={65535} inputMode="numeric" value={typeof connection.port === "number" ? String(connection.port) : ""} onChange={(event) => writeConnection({ port: event.target.value === "" ? undefined : Number(event.target.value) })} placeholder="6379" />
        </Field>
        <Field label="Database number">
          <TextInput type="number" min={0} max={15} inputMode="numeric" value={typeof connection.db === "number" ? String(connection.db) : ""} onChange={(event) => writeConnection({ db: event.target.value === "" ? undefined : Number(event.target.value) })} placeholder="0" />
        </Field>
      </div>
      <CheckBox label="Use TLS (rediss://)" checked={connection.tls === true} onChange={(checked) => writeConnection({ tls: checked || undefined })} />
    </>
  );
}

/** Shown before the first search: the commands most people look up. */
const COMMON = ["SET", "GET", "DEL", "EXPIRE", "TTL", "INCR", "HSET", "HGETALL", "LPUSH", "SADD", "ZADD", "XADD", "PUBLISH", "SCAN"];

function CommandReference() {
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState("all");
  const groups = useMemo(() => [...new Set(redis.REDIS_COMMANDS.map((c) => c.group))].sort(), []);
  const matches = useMemo(() => {
    const q = query.trim().toUpperCase();
    if (!q && group === "all") return COMMON.flatMap((name) => redis.REDIS_COMMANDS.filter((c) => c.name === name));
    const rank = (name: string, summary: string) => (name === q ? 0 : name.startsWith(q) ? 1 : name.includes(q) ? 2 : summary.toUpperCase().includes(q) ? 3 : 4);
    return redis.REDIS_COMMANDS.filter((c) => (group === "all" || c.group === group) && (!q || rank(c.name, c.summary) < 4))
      .map((c) => ({ c, r: q ? rank(c.name, c.summary) : 0 }))
      .sort((a, b) => a.r - b.r)
      .map(({ c }) => c)
      .slice(0, 12);
  }, [query, group]);
  return (
    <Panel title="Command reference" bodyClassName="space-y-3">
      <p className="text-xs text-faint">{redis.REDIS_COMMAND_COUNT} commands with syntax, cost and pitfalls, from the official Redis command reference.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Look up a command">
          <TextInput value={query} onChange={(event) => setQuery(event.target.value)} placeholder="SET, expire, sorted set…" />
        </Field>
        <Field label="Command group">
          <Select value={group} onChange={(event) => setGroup(event.target.value)}>
            <option value="all">All groups</option>
            {groups.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <output aria-label="Matching commands" data-agent-region="command-reference" className="block space-y-2">
        {matches.length === 0 ? <span className="text-sm text-faint">No command matches.</span> : null}
        {matches.map((cmd) => {
          const pitfall = PITFALLS[cmd.name] ?? PITFALLS[cmd.name.split(" ")[0]];
          return (
            <dl key={cmd.name} className="min-w-0 space-y-1 rounded-lg border border-line px-3 py-2 text-[13px]">
              <dt className="font-mono font-semibold break-words text-ink">{cmd.name}</dt>
              <dd className="font-mono text-[12px] break-words text-muted">{syntaxOf(cmd)}</dd>
              <dd className="text-ink">{cmd.summary}</dd>
              <dd className="text-faint">
                Group {cmd.group} · since {cmd.since} · {cmd.complexity || "complexity not documented"}
                {cmd.deprecated ? ` · deprecated since ${cmd.deprecated}` : ""}
              </dd>
              {pitfall ? <dd className="text-warn">Watch out: {pitfall.message}</dd> : null}
            </dl>
          );
        })}
      </output>
    </Panel>
  );
}

const INITIAL = specToText(redis.REDIS_EXAMPLES[0].spec);

export default function NosqlRedis() {
  return (
    <NosqlWorkbench
      adapter={adapter}
      initialText={INITIAL}
      renderForm={({ spec, setSpec }) => (
        <FormGroup title="Describe the commands">
          <RedisForm spec={spec} setSpec={setSpec} />
        </FormGroup>
      )}
      extra={<CommandReference />}
    />
  );
}
