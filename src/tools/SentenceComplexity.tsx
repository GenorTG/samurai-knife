"use client";
import { useState } from "react";
import { Field, Notice, Panel, Stat, StatGrid, TextArea, WorkStatus } from "@/components/ui";
import { formatInt } from "@/lib/format";
import { analyzeSentences, WRITING_INLINE_LIMIT, type SentencesResult } from "@/lib/writing";
import { sentencesInWorker } from "@/lib/writing-client";
import { useAdaptive } from "@/lib/workers/use-offloaded";
const EMPTY: SentencesResult = { total: 0, rows: [], clipped: false, average: 0, long: 0 };
export default function SentenceComplexity() {
  const [text, setText] = useState("Short sentences help. A longer sentence can include several words and clauses, which may make it harder to scan quickly. Sentence length is only one part of readability.");
  const job = useAdaptive(analyzeSentences, sentencesInWorker, text, text.length <= WRITING_INLINE_LIMIT);
  const result = job.value ?? EMPTY;
  return <Panel title="Sentence complexity analyzer"><div className="space-y-3"><Field label="Text"><TextArea rows={10} value={text} onChange={(e) => setText(e.target.value)} /></Field><WorkStatus running={job.status === "running"} elapsedMs={job.elapsedMs} label="Analyzing sentences" cancelLabel="Cancel analysis" onCancel={job.cancel} />{job.status === "cancelled" ? <Notice>Analysis cancelled. Edit the text to analyze again.</Notice> : null}{job.status === "error" ? <Notice tone="error">{job.error}</Notice> : null}<StatGrid><Stat label="Sentences" value={result.total} /><Stat label="Average words / sentence" value={result.average.toFixed(1)} /><Stat label="Over 25 words" value={result.long} /></StatGrid><div className="max-h-72 space-y-2 overflow-auto">{result.rows.map((row) => <div key={row.index} className="rounded-lg border border-line p-3"><div className="mb-1 text-xs text-faint">Sentence {row.index} · {row.words} {row.words === 1 ? "word" : "words"}{row.words > 25 ? " · long" : ""}</div><p className="text-sm leading-relaxed">{row.text}</p></div>)}</div>{result.rows.length < result.total || result.clipped ? <p className="text-xs text-faint">Showing the first {formatInt(result.rows.length)} of {formatInt(result.total)} sentences{result.clipped ? " (the last one is shortened)" : ""}. The statistics cover all of them.</p> : null}<p className="text-xs text-faint">Sentence boundaries use punctuation heuristics. Word count helps locate long sentences but does not judge syntax or meaning.</p></div></Panel>;
}
