"use client";
import { useMemo, useState } from "react";
import { Field, Panel, Select, TextArea } from "@/components/ui";
import { type PivotAggregation, pivotTable } from "@/lib/csv-pivot";
import { parseDelimited } from "@/tools/CsvTool";
export default function CsvPivot() {
  const [input, setInput] = useState("team,quarter,sales\nNorth,Q1,12\nNorth,Q2,18\nSouth,Q1,8\nSouth,Q2,14\nNorth,Q1,3"), [sep, setSep] = useState(",");
  const [ri, setRi] = useState(0), [ci, setCi] = useState(1), [vi, setVi] = useState(2), [agg, setAgg] = useState<PivotAggregation>("sum");
  const data = useMemo(() => {
    const rows = parseDelimited(input, sep);
    return { headers: rows[0] ?? [], ...pivotTable(rows, ri, ci, vi, agg) };
  }, [agg, ci, input, ri, sep, vi]);
  const picker = (label: string, value: number, set: (n: number) => void) => <Field label={label}><Select value={value} onChange={(e) => set(Number(e.target.value))}>{data.headers.map((name, i) => <option key={i} value={i}>{name || `Column ${i + 1}`}</option>)}</Select></Field>;
  return <Panel title="CSV pivot previewer"><div className="space-y-3"><Field label="Source table"><TextArea rows={7} value={input} onChange={(e) => setInput(e.target.value)} /></Field>
    <Field label="Delimiter"><Select className="max-w-48" value={sep} onChange={(e) => setSep(e.target.value)}><option value=",">Comma</option><option value={"\t"}>Tab</option><option value=";">Semicolon</option></Select></Field>
    <div className="grid gap-3 sm:grid-cols-2">{picker("Row groups", ri, setRi)}{picker("Column groups", ci, setCi)}{picker("Values", vi, setVi)}<Field label="Aggregation"><Select value={agg} onChange={(e) => setAgg(e.target.value as "sum" | "count" | "average")}><option value="sum">Sum</option><option value="count">Count numeric cells</option><option value="average">Average</option></Select></Field></div>
    <div className="overflow-auto rounded-lg border border-line"><table className="min-w-full text-left text-sm"><thead className="bg-raised"><tr><th className="px-3 py-2">{data.headers[ri] || "Rows"} / {data.headers[ci] || "Columns"}</th>{data.colKeys.map((c, i) => <th key={i} className="px-3 py-2">{c || "(blank)"}</th>)}</tr></thead><tbody>{data.rowKeys.map((r, i) => <tr key={i} className="border-t border-line"><th className="px-3 py-2">{r || "(blank)"}</th>{data.cells[i]?.map((value, j) => <td key={j} className="px-3 py-2 tabular-nums">{value}</td>)}</tr>)}</tbody></table></div>
    <p className="text-xs text-faint">First row is the header; sum/average ignore non-numeric cells.</p></div></Panel>;
}
