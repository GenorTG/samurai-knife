"use client";
import { useMemo, useState } from "react";
import { CopyButton, Field, Notice, Panel, TextArea, TextInput } from "@/components/ui";
export default function FixedWidthParser() {
  // The sample lines are padded to exactly the default widths (7 + 9 + 2), so the first thing a user sees parses cleanly.
  const [input, setInput] = useState("Ada    London   UK\nLin    Shanghai CN\nGrace  Sao PauloBR"), [widthsText, setWidthsText] = useState("7,9,2");
  const widths = widthsText.split(/[ ,]+/).filter(Boolean).map(Number);
  const valid = widths.length > 0 && widths.every((n) => Number.isInteger(n) && n > 0) && widths.reduce((a, b) => a + b, 0) <= 1000;
  const rows = useMemo(() => valid ? input.split(/\r?\n/).map((line) => { let start = 0; return widths.map((width) => { const value = line.slice(start, start + width).trimEnd(); start += width; return value; }); }) : [], [input, valid, widths]);
  const output = rows.map((row) => row.join("\t")).join("\n");
  return <Panel title="Fixed-width table parser" right={<CopyButton text={output} label="Copy TSV" />}><div className="space-y-3"><Field label="Column widths (characters, comma or space separated)"><TextInput value={widthsText} onChange={(e) => setWidthsText(e.target.value)} /></Field>
    <Field label="Fixed-width lines"><TextArea rows={10} className="whitespace-pre" value={input} onChange={(e) => setInput(e.target.value)} /></Field>
    {!valid ? <Notice tone="error">Enter positive integer widths totaling at most 1000 characters.</Notice> : <><Notice tone="info">{widths.length} columns; {input.split(/\r?\n/).length} lines.</Notice><Field label="Parsed output (TSV)"><TextArea rows={9} readOnly value={output} /></Field></>}
    <p className="text-xs text-faint">Width counts Unicode code units, not terminal display columns; pad short lines with empty cells.</p></div></Panel>;
}
