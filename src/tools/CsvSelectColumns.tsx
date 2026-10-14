"use client";
import { useMemo, useState } from "react";
import { CopyButton, Field, Panel, Select, TextArea } from "@/components/ui";
import { parseDelimited } from "@/tools/CsvTool";
function encode(rows: string[][], sep: string): string { return rows.map((row) => row.map((cell) => /["\r\n]/.test(cell) || cell.includes(sep) ? `"${cell.replace(/"/g, '""')}"` : cell).join(sep)).join("\n"); }
export default function CsvSelectColumns() {
  const [input, setInput] = useState("name,role,city\nAda,Engineer,London\nLin,Researcher,Shanghai"), [sep, setSep] = useState(","), [selected, setSelected] = useState<number[]>([]);
  const rows = useMemo(() => parseDelimited(input, sep), [input, sep]); const columns = rows[0] ?? [];
  const active = selected.length ? selected : columns.map((_, i) => i);
  const lastOne = active.length === 1;
  const output = encode(rows.map((row) => active.map((i) => row[i] ?? "")), sep);
  return <Panel title="CSV column selector" right={<CopyButton text={output} label="Copy selected data" />}><div className="space-y-3">
    <Field label="Input table"><TextArea rows={8} value={input} onChange={(e) => setInput(e.target.value)} /></Field>
    <Field label="Delimiter"><Select className="max-w-48" value={sep} onChange={(e) => setSep(e.target.value)}><option value=",">Comma</option><option value={"\t"}>Tab</option><option value=";">Semicolon</option><option value="|">Pipe</option></Select></Field>
    <fieldset className="space-y-2 rounded-lg border border-line p-3"><legend className="px-1 text-sm text-muted">Choose columns (source order)</legend><div className="flex flex-wrap gap-3">{columns.map((name, i) => <label key={i} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!selected.length || selected.includes(i)} disabled={lastOne && active[0] === i} onChange={() => setSelected((old) => { const all = old.length ? old : columns.map((_, n) => n); return all.includes(i) ? all.filter((n) => n !== i) : [...all, i].sort((a, b) => a - b); })} />{name || `Column ${i + 1}`}</label>)}</div>{lastOne ? <p className="text-xs text-faint">At least one column must stay selected.</p> : null}</fieldset>
    <Field label="Selected output"><TextArea rows={8} readOnly value={output} /></Field><p className="text-xs text-faint">The first row supplies column labels. Quoted fields are parsed and re-escaped.</p>
  </div></Panel>;
}
