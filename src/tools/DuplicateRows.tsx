"use client";

import { useMemo, useState } from "react";
import { CopyButton, Field, Panel, Select, Stat, TextArea } from "@/components/ui";
import { parseDelimited } from "@/tools/CsvTool";
import { useT } from "@/lib/i18n/react";

export default function DuplicateRows() {
  const { t } = useT();
  const [text, setText] = useState("id,name\n1,Ada\n2,Lin\n1,Ada\n3,Grace\n2,Lin");
  const [delimiter, setDelimiter] = useState(",");
  const [ignoreCase, setIgnoreCase] = useState(false);
  const duplicates = useMemo(() => {
    const rows = parseDelimited(text, delimiter);
    const seen = new Set<string>();
    const found: { line: number; row: string[]; key: string }[] = [];
    rows.forEach((row, index) => {
      const normalized = row.map((cell) => ignoreCase ? cell.toLocaleLowerCase() : cell);
      const key = JSON.stringify(normalized);
      if (seen.has(key)) found.push({ line: index + 1, row, key });
      else seen.add(key);
    });
    return found;
  }, [delimiter, ignoreCase, text]);
  const output = duplicates.map(({ line, row }) => `${line}: ${row.join(" | ")}`).join("\n");
  return <Panel title={t("Duplicate rows")} right={<CopyButton text={output} label={t("Copy matches")} />}>
    <div className="space-y-3">
      <Field label={t("Delimited data")}><TextArea rows={10} value={text} onChange={(e) => setText(e.target.value)} /></Field>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label={t("Delimiter")}><Select value={delimiter} onChange={(e) => setDelimiter(e.target.value)}><option value=",">{t("Comma")}</option><option value={"\t"}>{t("Tab")}</option><option value=";">{t("Semicolon")}</option><option value="|">{t("Pipe")}</option></Select></Field>
        <label className="flex items-center gap-2 self-end pb-2 text-sm"><input type="checkbox" checked={ignoreCase} onChange={(e) => setIgnoreCase(e.target.checked)} /> {" "}{t("Ignore case")}</label>
        <Stat label={t("Repeated rows")} value={duplicates.length} />
      </div>
      <Field label={t("Repeated records (line numbers refer to parsed data rows)")}><TextArea rows={7} readOnly value={output || "No duplicate rows found."} /></Field>
      <p className="text-xs text-faint">{t("Quoted fields and escaped quotes are parsed. The header row is treated like any other row.")}</p>
    </div>
  </Panel>;
}
