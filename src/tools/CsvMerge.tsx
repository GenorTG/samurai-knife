"use client";
import { useMemo, useState } from "react";
import { CopyButton, Field, Notice, Panel, Select, TextArea } from "@/components/ui";
import { parseDelimited } from "@/tools/CsvTool";
function encode(rows: string[][], sep: string): string { return rows.map((row) => row.map((cell) => /["\r\n]/.test(cell) || cell.includes(sep) ? `"${cell.replace(/"/g, '""')}"` : cell).join(sep)).join("\n"); }
export default function CsvMerge() {
  const [first, setFirst] = useState("id,name\n1,Ada\n2,Lin"), [second, setSecond] = useState("id,name\n3,Grace\n4,Alan"), [sep, setSep] = useState(",");
  const result = useMemo(() => { const a = parseDelimited(first, sep), b = parseDelimited(second, sep); const same = JSON.stringify(a[0] ?? []) === JSON.stringify(b[0] ?? []); return { same, output: same ? encode([a[0] ?? [], ...a.slice(1), ...b.slice(1)], sep) : "" }; }, [first, second, sep]);
  return <Panel title="CSV merger" right={<CopyButton text={result.output} label="Copy merged CSV" />}><div className="space-y-3"><Field label="Delimiter"><Select className="max-w-48" value={sep} onChange={(e) => setSep(e.target.value)}><option value=",">Comma</option><option value={"\t"}>Tab</option><option value=";">Semicolon</option><option value="|">Pipe</option></Select></Field>
    <div className="grid gap-3 lg:grid-cols-2"><Field label="First table"><TextArea rows={8} value={first} onChange={(e) => setFirst(e.target.value)} /></Field><Field label="Second table"><TextArea rows={8} value={second} onChange={(e) => setSecond(e.target.value)} /></Field></div>
    {result.same ? <Field label="Merged output"><TextArea rows={10} readOnly value={result.output} /></Field> : <Notice tone="error">Header rows differ. Match their column names and order before appending.</Notice>}
    <p className="text-xs text-faint">Appends data rows from the second table and keeps one header; quoted fields are re-escaped.</p></div></Panel>;
}
