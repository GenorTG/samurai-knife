"use client";

import { useMemo, useState } from "react";
import { CopyButton, Field, Panel, Stat, StatGrid, TextArea } from "@/components/ui";

const CANDIDATES = [",", "\t", ";", "|"] as const;
const LABELS: Record<string, string> = { ",": "Comma", "\t": "Tab", ";": "Semicolon", "|": "Pipe" };
function fields(line: string, delimiter: string): number {
  let count = 1, quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] === '"') {
      if (quoted && line[i + 1] === '"') i += 1;
      else quoted = !quoted;
    } else if (line[i] === delimiter && !quoted) count += 1;
  }
  return count;
}

export default function DelimiterDetector() {
  const [input, setInput] = useState('name;city;note\n"Ada Lovelace";London;"analyst; mathematician"\nGrace;New York;engineer');
  const result = useMemo(() => {
    const lines = input.split(/\r?\n/).filter((line) => line.trim()).slice(0, 100);
    const scores = CANDIDATES.map((delimiter) => {
      const widths = lines.map((line) => fields(line, delimiter));
      const modal = new Map<number, number>();
      widths.forEach((width) => modal.set(width, (modal.get(width) ?? 0) + 1));
      const consistent = Math.max(0, ...modal.values());
      const columns = Math.max(...widths, 0);
      return { delimiter, columns, consistent, rows: lines.length, score: columns > 1 ? consistent * columns : 0 };
    }).sort((a, b) => b.score - a.score || b.columns - a.columns);
    return { lines, scores, best: scores[0] };
  }, [input]);
  const report = result.scores.map(({ delimiter, columns, consistent, rows }) => `${LABELS[delimiter]}\t${columns} columns\t${consistent}/${rows} consistent rows`).join("\n");
  return <Panel title="Delimiter detector" right={<CopyButton text={result.best?.delimiter ?? ""} label="Copy delimiter" />}>
    <div className="space-y-3">
      <Field label="Paste a sample (up to 100 non-empty lines)"><TextArea rows={9} value={input} onChange={(e) => setInput(e.target.value)} /></Field>
      <StatGrid><Stat label="Best guess" value={result.best && result.best.score ? LABELS[result.best.delimiter] : "No clear match"} /><Stat label="Columns" value={result.best?.columns ?? 0} /><Stat label="Consistent rows" value={`${result.best?.consistent ?? 0} / ${result.best?.rows ?? 0}`} /></StatGrid>
      <Field label="Candidate scores"><TextArea readOnly rows={4} value={report} /></Field>
      <p className="text-xs text-faint">Heuristic only: quoted delimiters are ignored; ties and irregular files may need manual review.</p>
    </div>
  </Panel>;
}
