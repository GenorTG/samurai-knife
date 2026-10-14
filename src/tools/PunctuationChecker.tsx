"use client";
import { useState } from "react";
import { CopyButton, Field, Notice, Panel, Stat, TextArea, WorkStatus } from "@/components/ui";
import { formatInt } from "@/lib/format";
import { checkPunctuation, FINDINGS_SHOWN_LIMIT, WRITING_INLINE_LIMIT, type PunctuationResult } from "@/lib/writing";
import { punctuationInWorker } from "@/lib/writing-client";
import { useAdaptive } from "@/lib/workers/use-offloaded";
const EMPTY: PunctuationResult = { count: 0, output: "", shown: "" };
export default function PunctuationChecker() {
  const [text, setText] = useState("This sentence has a space before punctuation ,and one after comma.  Another sentence has double spaces!We can spot that.");
  const job = useAdaptive(checkPunctuation, punctuationInWorker, text, text.length <= WRITING_INLINE_LIMIT);
  const { count, output, shown } = job.value ?? EMPTY;
  return <Panel title="Punctuation spacing checker" right={<CopyButton text={job.status === "running" ? "" : output} label="Copy findings" />}><div className="space-y-3"><Field label="Text to check"><TextArea rows={11} value={text} onChange={(e) => setText(e.target.value)} /></Field><WorkStatus running={job.status === "running"} elapsedMs={job.elapsedMs} label="Checking punctuation" cancelLabel="Cancel checking" onCancel={job.cancel} />{job.status === "cancelled" ? <Notice>Checking cancelled. Edit the text to check again.</Notice> : null}{job.status === "error" ? <Notice tone="error">{job.error}</Notice> : null}<Stat label="Potential issues" value={count} />{count ? <Field label="Findings"><TextArea rows={8} readOnly value={shown} /></Field> : <p className="text-sm text-good">No common spacing issues detected.</p>}{count > FINDINGS_SHOWN_LIMIT ? <p className="text-xs text-faint">Showing the first {formatInt(FINDINGS_SHOWN_LIMIT)} of {formatInt(count)} findings. Copy findings uses all of them.</p> : null}<p className="text-xs text-faint">Heuristic punctuation lint only; URLs, abbreviations, code, and language-specific conventions may trigger false positives.</p></div></Panel>;
}
