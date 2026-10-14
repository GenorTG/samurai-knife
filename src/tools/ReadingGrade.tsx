"use client";
import { useState } from "react";
import { Field, Notice, Panel, Stat, StatGrid, TextArea, WorkStatus } from "@/components/ui";
import { gradeText, WRITING_INLINE_LIMIT } from "@/lib/writing";
import { gradeInWorker } from "@/lib/writing-client";
import { useAdaptive } from "@/lib/workers/use-offloaded";
export default function ReadingGrade() {
  const [text, setText] = useState("Readable writing uses clear words and varied sentences. This sample shows a rough estimate, not a definitive judgment about the reader.");
  const job = useAdaptive(gradeText, gradeInWorker, text, text.length <= WRITING_INLINE_LIMIT);
  const result = job.value;
  return <Panel title="Reading-grade estimator"><div className="space-y-3"><Field label="English prose"><TextArea rows={10} value={text} onChange={(e) => setText(e.target.value)} /></Field><WorkStatus running={job.status === "running"} elapsedMs={job.elapsedMs} label="Analyzing text" cancelLabel="Cancel analysis" onCancel={job.cancel} />{job.status === "cancelled" ? <Notice>Analysis cancelled. Edit the text to analyze again.</Notice> : null}{job.status === "error" ? <Notice tone="error">{job.error}</Notice> : null}{result ? <><StatGrid><Stat label="Flesch reading ease" value={result.flesch.toFixed(1)} /><Stat label="Flesch–Kincaid grade" value={result.fk.toFixed(1)} /><Stat label="Gunning Fog index" value={result.fog.toFixed(1)} /></StatGrid><StatGrid><Stat label="Words" value={result.count} /><Stat label="Sentences (estimated)" value={result.sentenceCount} /><Stat label="Syllables (estimated)" value={result.syllableCount} /></StatGrid></> : job.status === "done" ? <Notice>Enter English prose to calculate readability estimates.</Notice> : null}<p className="text-xs text-faint">English-only heuristics. Syllable and sentence detection are approximate; scores are not a measure of writing quality or an accessibility guarantee.</p></div></Panel>;
}
