"use client";

import { useMemo, useState } from "react";
import { CopyButton, Field, NumberField, Panel, Stat, TextArea } from "@/components/ui";
import { textWidth, wrapText } from "@/lib/line-wrap";
import { useT } from "@/lib/i18n/react";

export default function LineWrapPreview() {
  const { t } = useT();
  const [text, setText] = useState(t("Paste prose or code here to preview a fixed column width.\n\nExisting blank lines and paragraph boundaries are preserved."));
  const [width, setWidth] = useState(80);
  const output = useMemo(() => wrapText(text, width), [text, width]);
  const longest = output.split("\n").reduce((max, line) => Math.max(max, textWidth(line)), 0);
  return <Panel title={t("Line wrap preview")} right={<CopyButton text={output} label={t("Copy wrapped text")} />}>
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-[1fr_9rem]">
        <Field label={t("Column width")}><NumberField min={10} max={240} integer fallback={80} value={width} onValueChange={setWidth} /></Field>
        <Stat label={t("Longest output line")} value={`${longest} / ${width}`} />
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <Field label={t("Text to wrap")}><TextArea rows={15} value={text} onChange={(e) => setText(e.target.value)} /></Field>
        <Field label={t("Wrapped output")}><TextArea rows={15} readOnly value={output} /></Field>
      </div>
      <p className="text-xs text-faint">{t("Indentation and spacing inside a line that fits are kept. Words longer than the selected width are split (never inside a character). Existing hard line breaks remain hard breaks.")}</p>
    </div>
  </Panel>;
}
