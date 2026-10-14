"use client";

import { useMemo, useState } from "react";
import { CopyButton, Field, Panel, Stat, StatGrid, TextArea } from "@/components/ui";

function normalizeFrame(line: string): string {
  const trimmed = line.trim();
  const js = trimmed.match(/^at\s+(.*?)\s+\((.*?):(\d+):(\d+)\)$/);
  if (js) return `at ${js[1]} — ${js[2]}:${js[3]}:${js[4]}`;
  // A frame without a function name is only a location: it stays "at file:line:col" (it used to print "at file — line:col",
  // which reads as if the file were the function).
  if (/^at\s+.+?:\d+:\d+$/.test(trimmed)) return trimmed.replace(/^at\s+/, "at ");
  const py = trimmed.match(/^File "(.*?)", line (\d+), in (.*)$/);
  if (py) return `at ${py[3]} — ${py[1]}:${py[2]}`;
  return trimmed;
}
export default function StacktraceFormatter() {
  const [input, setInput] = useState("TypeError: example\n    at render (src/app.ts:42:7)\n    at process (src/run.ts:12:3)\n\nTraceback (most recent call last):\n  File \"worker.py\", line 18, in run\n    raise ValueError()");
  const result = useMemo(() => input.split(/\r?\n/).map(normalizeFrame).filter(Boolean), [input]);
  const output = [...new Set(result)].join("\n");
  return <Panel title="Stack trace formatter" right={<CopyButton text={output} />}>
    <div className="space-y-3"><Field label="Pasted exception or traceback"><TextArea rows={14} spellCheck={false} value={input} onChange={(e) => setInput(e.target.value)} /></Field>
      <StatGrid><Stat label="Non-empty lines" value={result.length} /><Stat label="Unique lines" value={new Set(result).size} /></StatGrid>
      <Field label="Normalized output"><TextArea rows={14} readOnly value={output} /></Field>
      <p className="text-xs text-faint">Recognizes common JavaScript V8 and Python frame formats; unknown lines are preserved. Duplicate normalized lines are removed.</p>
    </div>
  </Panel>;
}
