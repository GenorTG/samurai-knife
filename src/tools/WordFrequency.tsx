"use client";

import { useMemo, useState } from "react";
import { CopyButton, Field, Notice, NumberField, Panel, Select, Stat, TextArea, WorkStatus } from "@/components/ui";
import { countWords, TOP_WORDS, WORDS_INLINE_LIMIT, type WordsInput } from "@/lib/words";
import { countWordsInWorker } from "@/lib/words-client";
import { useAdaptive } from "@/lib/workers/use-offloaded";

export default function WordFrequency() {
  const [text, setText] = useState("Words are counted locally. Repeated words rise to the top; words are compared without case by default.");
  const [minimum, setMinimum] = useState(1);
  const [order, setOrder] = useState<"count" | "alpha">("count");
  const input = useMemo<WordsInput>(() => ({ text, minimum, order }), [minimum, order, text]);
  const job = useAdaptive(countWords, countWordsInWorker, input, text.length <= WORDS_INLINE_LIMIT);
  const result = job.value;
  const top = result?.top ?? [];
  const total = result?.total ?? 0;
  const unique = result?.unique ?? 0;
  const output = result?.tsv ?? "";
  return <Panel title="Word frequency" right={<CopyButton text={output} label="Copy TSV" />}>
    <div className="space-y-3">
      <Field label="Text to analyze"><TextArea rows={8} value={text} onChange={(e) => setText(e.target.value)} /></Field>
      <WorkStatus running={job.status === "running"} elapsedMs={job.elapsedMs} label="Counting words" cancelLabel="Cancel counting" onCancel={job.cancel} />
      {job.status === "cancelled" ? <Notice>Counting cancelled. Edit the text or options to count again.</Notice> : null}
      {job.status === "error" ? <Notice tone="error">{job.error}</Notice> : null}
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Minimum characters"><NumberField min={1} max={100} integer value={minimum} onValueChange={setMinimum} /></Field>
        <Field label="Sort order"><Select value={order} onChange={(e) => setOrder(e.target.value as "count" | "alpha")}><option value="count">Frequency</option><option value="alpha">Alphabetical</option></Select></Field>
        <Stat label="Words / unique" value={result ? `${total} / ${unique}` : "…"} />
      </div>
      <div className="max-h-72 overflow-auto rounded-lg border border-line">
        <table className="w-full text-left text-sm"><thead className="sticky top-0 bg-raised text-faint"><tr><th className="px-3 py-2">Word</th><th className="px-3 py-2 text-right">Count</th><th className="px-3 py-2 text-right">Share</th></tr></thead>
          <tbody>{top.map(([word, count]) => <tr className="border-t border-line" key={word}><td className="px-3 py-1.5 font-mono">{word}</td><td className="px-3 py-1.5 text-right tabular-nums">{count}</td><td className="px-3 py-1.5 text-right tabular-nums">{total ? (count / total * 100).toFixed(1) : "0.0"}%</td></tr>)}</tbody>
        </table>
      </div>
      {unique > TOP_WORDS && <p className="text-xs text-faint">Showing first {TOP_WORDS} of {unique} unique words.</p>}
    </div>
  </Panel>;
}
