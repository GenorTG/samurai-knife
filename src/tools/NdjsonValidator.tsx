"use client";

import { useState } from "react";
import { CopyButton, Field, Notice, Panel, Stat, StatGrid, TextArea, WorkStatus } from "@/components/ui";
import { formatInt } from "@/lib/format";
import { NDJSON_INLINE_LIMIT, NDJSON_SHOWN_ERRORS, validateNdjson } from "@/lib/ndjson";
import { validateNdjsonInWorker } from "@/lib/ndjson-client";
import { useAdaptive } from "@/lib/workers/use-offloaded";

export default function NdjsonValidator() {
  const [input, setInput] = useState('{"id":1,"name":"Ada"}\n{"id":2,"name":"Lin"}\n');
  const job = useAdaptive(validateNdjson, validateNdjsonInWorker, input, input.length <= NDJSON_INLINE_LIMIT);
  const stale = job.status === "cancelled" || job.status === "error";
  const pending = job.status !== "done" && !stale;
  const result = stale || pending ? null : job.value;
  const errorText = result?.errorText ?? "";
  const invalid = result?.invalid ?? 0;
  return <Panel title="NDJSON validator" right={<CopyButton text={errorText} label="Copy errors" />}>
    <div className="space-y-3">
      <Field label="One JSON value per line"><TextArea rows={14} spellCheck={false} value={input} onChange={(e) => setInput(e.target.value)} /></Field>
      <WorkStatus running={job.status === "running"} elapsedMs={job.elapsedMs} label="Validating records" cancelLabel="Cancel validation" onCancel={job.cancel} />
      {job.status === "cancelled" ? <Notice>Validation cancelled. Edit the text to validate again.</Notice> : null}
      {job.status === "error" ? <Notice tone="error">{job.error}</Notice> : null}
      <StatGrid><Stat label="Valid records" value={result ? result.valid : "…"} /><Stat label="Invalid records" value={result ? invalid : "…"} /></StatGrid>
      {pending ? <Notice>Validating the records…</Notice> : result ? invalid ? <Notice tone="error">
        <span className="block whitespace-pre-wrap">{result.shownText}</span>
        {result.shownText !== errorText ? <span className="mt-2 block text-xs">Showing the first {NDJSON_SHOWN_ERRORS} of {formatInt(invalid)} errors. Copy errors copies all of them.</span> : null}
      </Notice> : <Notice tone="good">Every non-empty line is valid JSON. Blank lines are ignored.</Notice> : null}
      <p className="text-xs text-faint">This checks JSON syntax per line; it does not impose a common schema across records.</p>
    </div>
  </Panel>;
}
