"use client";

import { useMemo, useState } from "react";
import { CopyButton, Field, Notice, Panel, TextArea, WorkStatus } from "@/components/ui";
import { evaluateJsonPath, JSON_PATH_INLINE_LIMIT, JSON_PATH_SHOWN, type JsonPathInput } from "@/lib/json-path";
import { evaluateJsonPathInWorker } from "@/lib/json-path-client";
import { useAdaptive } from "@/lib/workers/use-offloaded";

export default function JsonPathExplorer() {
  const [json, setJson] = useState('{"users":[{"name":"Ada","active":true},{"name":"Lin","active":false}]}');
  const [query, setQuery] = useState("$.users[*].name");
  const request = useMemo<JsonPathInput>(() => ({ json, query }), [json, query]);
  const job = useAdaptive(evaluateJsonPath, evaluateJsonPathInWorker, request, json.length <= JSON_PATH_INLINE_LIMIT);
  const stale = job.status === "cancelled" || job.status === "error";
  const pending = job.status !== "done" && !stale;
  const result = stale || pending ? null : job.value;
  const count = result?.count ?? 0;
  return <Panel title="JSONPath explorer" right={<CopyButton text={result?.copyText ?? ""} label="Copy matches" />}>
    <div className="space-y-3"><Field label="JSONPath query"><TextArea rows={2} value={query} onChange={(e) => setQuery(e.target.value)} /></Field><Field label="JSON document"><TextArea rows={10} spellCheck={false} value={json} onChange={(e) => setJson(e.target.value)} /></Field>
      <WorkStatus running={job.status === "running"} elapsedMs={job.elapsedMs} label="Running the query" cancelLabel="Cancel query" onCancel={job.cancel} />
      {job.status === "cancelled" ? <Notice>Query cancelled. Edit the document or the query to run it again.</Notice> : null}
      {job.status === "error" ? <Notice tone="error">{job.error}</Notice> : null}
      {pending ? <Notice>Running the query…</Notice> : result?.error ? <Notice tone="error">{result.error}</Notice> : result ? <Notice tone="good">{count} match{count === 1 ? "" : "es"}.</Notice> : null}
      <div className="space-y-2">{result?.shown.map((match, index) => <div key={`${match.path}-${index}`} className="rounded-lg border border-line bg-raised p-3"><div className="font-mono text-xs text-faint">{match.path || "$ (root)"}</div><pre className="mt-1 overflow-x-auto whitespace-pre-wrap text-sm">{match.pretty}</pre></div>)}</div>
      {count > JSON_PATH_SHOWN && <p className="text-xs text-faint">Showing first {JSON_PATH_SHOWN} matches.</p>}
      <p className="text-xs text-faint">Supports root $, dotted properties, quoted bracket keys, array indexes, and single-level wildcards. Filters, slices, unions, and recursive descent are intentionally not supported.</p>
    </div>
  </Panel>;
}
