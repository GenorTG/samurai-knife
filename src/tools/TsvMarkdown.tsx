"use client";

import { useMemo, useState } from "react";
import { CopyButton, Field, Panel, Select, TextArea } from "@/components/ui";
import { toMarkdownTable } from "@/lib/markdown-table";
import { parseDelimited } from "@/tools/CsvTool";
import { useT } from "@/lib/i18n/react";

export default function TsvMarkdown() {
  const { t } = useT();
  const [text, setText] = useState("Name\tRole\nAda\tEngineer\nLin\tResearcher");
  const [delimiter, setDelimiter] = useState("\t");
  const [header, setHeader] = useState(true);
  const output = useMemo(() => {
    return toMarkdownTable(parseDelimited(text, delimiter), header);
  }, [delimiter, header, text]);
  return <Panel title={t("Delimited data to Markdown")} right={<CopyButton text={output} label={t("Copy table")} />}>
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2"><Field label={t("Table delimiter")}><Select value={delimiter} onChange={(e) => setDelimiter(e.target.value)}><option value={"\t"}>{t("Tab")}</option><option value=",">{t("Comma")}</option><option value=";">{t("Semicolon")}</option><option value="|">{t("Pipe")}</option></Select></Field><label className="flex items-center gap-2 self-end pb-2 text-sm"><input type="checkbox" checked={header} onChange={(e) => setHeader(e.target.checked)} /> {" "}{t("First row is header")}</label></div>
      <Field label={t("Delimited table")}><TextArea rows={9} value={text} onChange={(e) => setText(e.target.value)} /></Field>
      <Field label={t("Markdown table")}><TextArea rows={9} readOnly value={output} /></Field>
    </div>
  </Panel>;
}
