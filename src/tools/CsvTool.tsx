"use client";

import { useMemo, useState } from "react";
import { Button, CopyButton, Dropzone, Field, Notice, Panel, Select, Stat, StatGrid, TextArea, WorkStatus } from "@/components/ui";
import { CSV_CONVERT_INLINE_LIMIT, convertCsv, JSON_PANE_LIMIT, type CsvConvertInput } from "@/lib/csv-convert";
import { convertCsvInWorker } from "@/lib/csv-convert-client";
import { cx, downloadText, formatInt, readAsText } from "@/lib/format";
import { useAdaptive } from "@/lib/workers/use-offloaded";
import { useT } from "@/lib/i18n/react";

/** The parser lives in `lib/delimited` (pure, shared with the workers); other tools still import it from here. */
export { parseDelimited } from "@/lib/delimited";

export default function CsvTool() {
  const { t } = useT();
  const [text, setText] = useState("");
  const [delimiter, setDelimiter] = useState(",");
  const [hasHeader, setHasHeader] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const input = useMemo<CsvConvertInput>(() => ({ text, delimiter, hasHeader }), [delimiter, hasHeader, text]);
  const job = useAdaptive(convertCsv, convertCsvInWorker, input, text.length <= CSV_CONVERT_INLINE_LIMIT);
  const result = job.value;
  const json = result?.json ?? "";
  const jsonShown = json.length > JSON_PANE_LIMIT ? json.slice(0, JSON_PANE_LIMIT) : json;
  const running = job.status === "running";

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel
          title={t("Input")}
          right={
            <div className="flex gap-1.5">
              <Button size="sm" variant="ghost" onClick={() => setText("")}>{t("Clear")}</Button>
            </div>
          }
        >
          <div className="space-y-3">
            <div className="flex flex-wrap items-end gap-2">
              <Field label={t("Delimiter")} className="w-32">
                <Select value={delimiter} onChange={(e) => setDelimiter(e.target.value)}>
                  <option value=",">{t("Comma ,")}</option>
                  <option value=";">{t("Semicolon ;")}</option>
                  <option value="&#9;">{t("Tab ⇥")}</option>
                  <option value="|">{t("Pipe |")}</option>
                </Select>
              </Field>
              <Button
                size="sm"
                variant={hasHeader ? "primary" : "subtle"}
                className="mb-1"
                onClick={() => setHasHeader((v) => !v)}
              >
                {hasHeader ? t("Header row") : t("No header")}
              </Button>
            </div>
            <TextArea
              rows={12}
              spellCheck={false}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={t("name,role,city\nGenor,owner,Warsaw")}
            />
            <Dropzone
              accept=".csv,.tsv,.txt,text/csv"
              hint={t("CSV / TSV up to a few MB — parsed in the browser")}
              onFiles={(files) => {
                const file = files[0];
                setError(null);
                if (file.size > 8 * 1024 * 1024) {
                  setError(t("That file is over 8 MB — this tool is for quick looks, not pipelines."));
                  return;
                }
                void readAsText(file)
                  .then(setText)
                  .catch((exc: unknown) => setError(exc instanceof Error ? exc.message : t("Read failed.")));
              }}
            />
            {error ? <Notice tone="error">{error}</Notice> : null}
          </div>
        </Panel>

        <Panel
          title="JSON"
          right={
            <div className="flex gap-1.5">
              <CopyButton text={running ? "" : json} />
              <Button
                size="sm"
                variant="subtle"
                disabled={!json || running}
                onClick={() => downloadText(json, "rows.json", "application/json")}
              >
                {t("Save .json")}
              </Button>
            </div>
          }
        >
          <div className="space-y-3">
            <WorkStatus running={running} elapsedMs={job.elapsedMs} label={t("Converting CSV")} cancelLabel={t("Cancel conversion")} onCancel={job.cancel} />
            {job.status === "cancelled" ? <Notice>{t("Conversion cancelled. Edit the CSV or options to convert again.")}</Notice> : null}
            {job.status === "error" ? <Notice tone="error">{job.error}</Notice> : null}
            {result?.parsed ? (
              <StatGrid>
                <Stat label={t("Rows")} value={result.dataRows} />
                <Stat label={t("Columns")} value={result.columns} />
                <Stat label={t("Cells")} value={result.cells} />
              </StatGrid>
            ) : null}
            <pre className="sk-input max-h-[46vh] overflow-auto px-3 py-2.5 font-mono text-[12px] leading-relaxed break-words">
              {jsonShown || <span className="text-faint">{t("JSON appears here.")}</span>}
            </pre>
            {json.length > JSON_PANE_LIMIT ? <p className="text-xs text-faint">{t("Showing the first {jsonPaneLimit} of {json} characters. Copy and Save .json use the whole JSON.", { jsonPaneLimit: formatInt(JSON_PANE_LIMIT), json: formatInt(json.length) })}</p> : null}
          </div>
        </Panel>
      </div>

      {result?.parsed ? (
        <Panel title={t("Preview")} bodyClassName="p-0">
          <div className="max-h-[40vh] overflow-auto">
            <table className="w-full border-collapse text-left text-[13px]">
              <thead className="sticky top-0 bg-raised">
                <tr>
                  {result.header.map((header, index) => (
                    <th
                      key={`${header}-${index}`}
                      className="border-b border-line px-3 py-2 font-mono text-[11px] tracking-wide text-faint uppercase"
                    >
                      {header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.previewRows.map((row, rowIndex) => (
                  <tr key={rowIndex} className="odd:bg-surface/60">
                    {Array.from({ length: result.columns }, (_, cellIndex) => (
                      <td
                        key={cellIndex}
                        className={cx(
                          "border-b border-line/60 px-3 py-1.5 font-mono text-[12px] text-ink",
                          (row[cellIndex] ?? "").trim() === "" && "text-faint",
                        )}
                      >
                        {row[cellIndex] ?? ""}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {result.dataRows > 200 ? (
            <p className="border-t border-line px-4 py-2 text-xs text-faint">
              {t("Showing first 200 of {dataRows} rows.", { dataRows: result.dataRows })}
            </p>
          ) : null}
        </Panel>
      ) : null}
    </div>
  );
}
