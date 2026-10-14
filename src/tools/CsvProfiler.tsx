"use client";

import { useMemo, useState } from "react";
import { Field, Notice, Panel, Select, Stat, StatGrid, TextArea, WorkStatus } from "@/components/ui";
import { CSV_PROFILE_INLINE_LIMIT, profileCsv, type CsvProfileInput } from "@/lib/csv-profile";
import { profileCsvInWorker } from "@/lib/csv-profile-client";
import { useAdaptive } from "@/lib/workers/use-offloaded";

export default function CsvProfiler() {
  const [text, setText] = useState("name,age,active,joined\nAda,36,true,2024-01-15\nLin,29,false,2025-03-02\nAda,36,true,");
  const [delimiter, setDelimiter] = useState(",");
  const input = useMemo<CsvProfileInput>(() => ({ text, delimiter }), [delimiter, text]);
  const job = useAdaptive(profileCsv, profileCsvInWorker, input, text.length <= CSV_PROFILE_INLINE_LIMIT);
  const profiles = job.value?.profiles ?? [];
  return <Panel title="CSV column profiler">
    <div className="space-y-3">
      <Field label="CSV / TSV sample"><TextArea rows={8} value={text} onChange={(e) => setText(e.target.value)} /></Field>
      <WorkStatus running={job.status === "running"} elapsedMs={job.elapsedMs} label="Profiling columns" cancelLabel="Cancel profiling" onCancel={job.cancel} />
      {job.status === "cancelled" ? <Notice>Profiling cancelled. Edit the sample or delimiter to profile again.</Notice> : null}
      {job.status === "error" ? <Notice tone="error">{job.error}</Notice> : null}
      <Field label="Delimiter"><Select className="max-w-48" value={delimiter} onChange={(e) => setDelimiter(e.target.value)}><option value=",">Comma</option><option value={"\t"}>Tab</option><option value=";">Semicolon</option><option value="|">Pipe</option></Select></Field>
      <StatGrid><Stat label="Data rows" value={profiles[0]?.rows ?? 0} /><Stat label="Columns" value={profiles.length} /><Stat label="Total missing" value={profiles.reduce((sum, item) => sum + item.missing, 0)} /><Stat label="Headers" value="First row" /></StatGrid>
      <div className="overflow-x-auto rounded-lg border border-line"><table className="w-full text-left text-sm"><thead className="bg-raised text-faint"><tr>{["Column", "Type guess", "Missing", "Unique"].map((x) => <th key={x} className="px-3 py-2">{x}</th>)}</tr></thead><tbody>{profiles.map((item, index) => <tr key={`${item.name}-${index}`} className="border-t border-line"><td className="px-3 py-2 font-mono">{item.name}</td><td className="px-3 py-2">{item.type}</td><td className="px-3 py-2 tabular-nums">{item.missing}</td><td className="px-3 py-2 tabular-nums">{item.unique}</td></tr>)}</tbody></table></div>
      <p className="text-xs text-faint">Type guesses are heuristic and use non-empty cells only. The first row is treated as the header.</p>
    </div>
  </Panel>;
}
