"use client";
import { useState } from "react";
import { CopyButton, Field, Panel, TextInput } from "@/components/ui";
export default function CssGridPlayground() {
  const [columns, setColumns] = useState(3), [rows, setRows] = useState(2), [gap, setGap] = useState(12), [items, setItems] = useState(6);
  const css = `display: grid;\ngrid-template-columns: repeat(${columns}, minmax(0, 1fr));\ngrid-template-rows: repeat(${rows}, minmax(4rem, auto));\ngap: ${gap}px;`;
  const change = (setter: (value: number) => void, value: string, min: number, max: number) => setter(Math.max(min, Math.min(max, Number(value) || min)));
  return <Panel title="CSS Grid playground" right={<CopyButton text={`.grid {\n  ${css.replace(/\n/g, "\n  ")}\n}`} label="Copy CSS" />}><div className="space-y-3"><div className="grid gap-3 sm:grid-cols-2">
    <Field label="Columns"><TextInput type="number" min={1} max={12} value={columns} onChange={(e) => change(setColumns, e.target.value, 1, 12)} /></Field>
    <Field label="Rows"><TextInput type="number" min={1} max={12} value={rows} onChange={(e) => change(setRows, e.target.value, 1, 12)} /></Field>
    <Field label="Gap (px)"><TextInput type="number" min={0} max={80} value={gap} onChange={(e) => change(setGap, e.target.value, 0, 80)} /></Field>
    <Field label="Items"><TextInput type="number" min={1} max={36} value={items} onChange={(e) => change(setItems, e.target.value, 1, 36)} /></Field></div>
    <div className="grid rounded-lg border border-line bg-raised p-3" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${rows}, minmax(4rem, auto))`, gap }} aria-label="Grid preview">{Array.from({ length: items }, (_, i) => <div key={i} className="grid min-h-16 place-items-center rounded bg-accent/20 font-mono text-sm">{i + 1}</div>)}</div>
    <pre className="overflow-auto rounded-lg border border-line bg-raised p-3 text-sm">{css}</pre>
  </div></Panel>;
}
