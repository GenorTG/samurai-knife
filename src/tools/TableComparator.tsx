"use client";
import { useMemo, useState } from "react";
import { CopyButton, Field, Panel, Select, Stat, TextArea } from "@/components/ui";
import { parseDelimited } from "@/tools/CsvTool";
export default function TableComparator() {
  const [left, setLeft] = useState("id,name\n1,Ada\n2,Lin\n3,Grace"), [right, setRight] = useState("id,name\n1,Ada\n2,Linus\n4,Grace"), [sep, setSep] = useState(",");
  const result = useMemo(() => {
    const a = parseDelimited(left, sep), b = parseDelimited(right, sep), rows = Math.max(a.length, b.length), cols = Math.max(...a.map((r) => r.length), ...b.map((r) => r.length), 0);
    const diffs: string[] = [];
    for (let row = 0; row < rows; row += 1) for (let col = 0; col < cols; col += 1) {
      const x = a[row]?.[col] ?? "(missing)", y = b[row]?.[col] ?? "(missing)";
      if (x !== y) diffs.push(`row ${row + 1}, ${a[0]?.[col] || `column ${col + 1}`}: left=${JSON.stringify(x)}; right=${JSON.stringify(y)}`);
    }
    return diffs;
  }, [left, right, sep]);
  return <Panel title="Cell-by-cell table comparator" right={<CopyButton text={result.join("\n")} label="Copy differences" />}><div className="space-y-3"><Field label="Delimiter"><Select className="max-w-48" value={sep} onChange={(e) => setSep(e.target.value)}><option value=",">Comma</option><option value={"\t"}>Tab</option><option value=";">Semicolon</option><option value="|">Pipe</option></Select></Field>
    <div className="grid gap-3 lg:grid-cols-2"><Field label="Left table"><TextArea rows={9} value={left} onChange={(e) => setLeft(e.target.value)} /></Field><Field label="Right table"><TextArea rows={9} value={right} onChange={(e) => setRight(e.target.value)} /></Field></div>
    <Stat label="Different cells" value={result.length} />{result.length ? <Field label="Differences"><TextArea rows={9} readOnly value={result.slice(0, 500).join("\n")} /></Field> : <p className="text-sm text-good">Tables match exactly.</p>}
    <p className="text-xs text-faint">Compares parsed cell positions including the header row; rows or columns absent from one side are reported as missing.</p></div></Panel>;
}
