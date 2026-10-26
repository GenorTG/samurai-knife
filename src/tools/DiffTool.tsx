"use client";

import { useMemo, useState } from "react";
import { Button, CopyButton, Field, Notice, Panel, Select, TextArea, WorkStatus } from "@/components/ui";
import { cx } from "@/lib/format";
import { downloadText, formatInt } from "@/lib/format";
import { diffSummary, MAX_DIFF_LINES, type MarkedWord } from "@/lib/diff";
import { computeDiffView, countLines, DIFF_INLINE_CHARS, DIFF_INLINE_LINES, DIFF_PAGE_BUDGET, DIFF_PATCH_PREVIEW, expandRow, rowsWithin, type DiffViewInput, type DiffViewResult } from "@/lib/diff-view";
import { diffInWorker } from "@/lib/diff-view-client";
import { useAdaptive } from "@/lib/workers/use-offloaded";
import { useT } from "@/lib/i18n/react";

/**
 * Line diff. Myers' O(ND) edit script over lines, then a word-level pass
 * inside changed pairs so the reader sees *what* changed, not just that it
 * did. The algorithm lives in `lib/diff` so the MCP surface can call the same
 * code; this file is only the view.
 */

type View = "side" | "patch";

function renderMarked(words: MarkedWord[]): React.ReactNode[] {
  return words.map((entry, index) =>
    entry.mark
      ? <span key={index} className="rounded bg-danger/25 px-0.5 text-danger-soft">{entry.word}</span>
      : <span key={index}>{entry.word}</span>,
  );
}

export default function DiffTool() {
  const { t } = useT();
  const [leftText, setLeftText] = useState("shared setup\nold implementation\nkeep this line\nfinal line");
  const [rightText, setRightText] = useState("shared setup\nnew implementation, refined\nkeep this line\nappended line");
  const [view, setView] = useState<View>("side");

  const input = useMemo<DiffViewInput>(() => ({ left: leftText, right: rightText }), [leftText, rightText]);
  // Over the line cap the "diff" is just a refusal (two splits), so that stays inline too; Myers only runs for <= MAX_DIFF_LINES.
  const small = useMemo(() => {
    const lines = Math.max(countLines(leftText), countLines(rightText));
    return lines > MAX_DIFF_LINES || (lines <= DIFF_INLINE_LINES && leftText.length + rightText.length <= DIFF_INLINE_CHARS);
  }, [leftText, rightText]);
  const job = useAdaptive(computeDiffView, diffInWorker, input, small);
  const result = job.value;
  const [paging, setPaging] = useState<{ of: DiffViewResult | null; pages: number }>({ of: null, pages: 1 });
  const pages = paging.of === result ? paging.pages : 1;
  const shownRows = result ? rowsWithin(result.rows, pages * DIFF_PAGE_BUDGET) : 0;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title={t("Left")}>
          <Field label={t("Before")}>
            <TextArea
              rows={14}
              spellCheck={false}
              value={leftText}
              onChange={(e) => setLeftText(e.target.value)}
            />
          </Field>
        </Panel>
        <Panel title={t("Right")}>
          <Field label={t("After")}>
            <TextArea
              rows={14}
              spellCheck={false}
              value={rightText}
              onChange={(e) => setRightText(e.target.value)}
            />
          </Field>
        </Panel>
      </div>

      <WorkStatus running={job.status === "running"} elapsedMs={job.elapsedMs} label={t("Computing diff")} cancelLabel={t("Cancel diff")} onCancel={job.cancel} />
      {job.status === "cancelled" ? <Notice>{t("Diff cancelled. Edit either side to compare again.")}</Notice> : null}
      {job.status === "error" ? <Notice tone="error">{job.error}</Notice> : null}
      {result && !result.ok ? <Notice tone="error">{result.error}</Notice> : null}

      {result?.ok ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={view}
              onChange={(e) => setView(e.target.value as View)}
              className="w-40"
            >
              <option value="side">{t("Side by side")}</option>
              <option value="patch">{t("Unified patch")}</option>
            </Select>
            <span className="font-mono text-[11px] text-faint">
              {diffSummary(result)}
            </span>
            <div className="ml-auto flex gap-1.5">
              <CopyButton text={result.patch} label={t("Copy patch")} />
              <Button
                size="sm"
                variant="subtle"
                onClick={() => downloadText(result.patch, "changes.diff")}
              >
                {t("Download .diff")}
              </Button>
            </div>
          </div>

          {view === "side" ? (
            <Panel title={t("Side by side")}>
              <div className="max-h-[70vh] overflow-auto">
                <table className="w-full border-collapse text-left text-[12.5px] font-mono">
                  <tbody>
                    {result.rows.slice(0, shownRows).map(expandRow).map((row, rowIndex) => (
                      <tr
                        key={rowIndex}
                        className={cx(
                          "odd:bg-surface/60",
                          row.kind === "change" && "bg-danger/6",
                          row.kind === "ins" && "bg-success/6",
                        )}
                      >
                        <td className="w-1/2 border-r border-line/60 px-2 py-1 break-all whitespace-pre-wrap">
                          {row.left.length ? renderMarked(row.left) : <span className="text-faint">·</span>}
                        </td>
                        <td className="px-2 py-1 break-all whitespace-pre-wrap">
                          {row.right.length ? renderMarked(row.right) : <span className="text-faint">·</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {shownRows < result.rows.length ? (
                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <p className="text-xs text-faint">{t("Showing the first {shownRows} of {rows} rows. Copy patch and Download .diff include all of them.", { shownRows: formatInt(shownRows), rows: formatInt(result.rows.length) })}</p>
                  <Button size="sm" variant="subtle" onClick={() => setPaging({ of: result, pages: pages + 1 })}>{t("Show more rows")}</Button>
                  <Button size="sm" variant="ghost" onClick={() => setPaging({ of: result, pages: Infinity })}>{t("Show all rows (can be slow)")}</Button>
                </div>
              ) : null}
            </Panel>
          ) : (
            <Panel title={t("Unified patch")}>
              <pre className="max-h-[70vh] overflow-auto px-3 py-2.5 font-mono text-[12px] leading-relaxed whitespace-pre-wrap break-words">
                {result.patch === "" ? <span className="text-faint">{t("No differences: the two texts are identical, so the patch is empty.")}</span> : result.patch.length > DIFF_PATCH_PREVIEW ? result.patch.slice(0, DIFF_PATCH_PREVIEW) : result.patch}
              </pre>
              {result.patch.length > DIFF_PATCH_PREVIEW ? <p className="mt-2 text-xs text-faint">{t("Showing the first {diffPatchPreview} of {patch} characters. Copy patch and Download .diff use the whole patch.", { diffPatchPreview: formatInt(DIFF_PATCH_PREVIEW), patch: formatInt(result.patch.length) })}</p> : null}
            </Panel>
          )}
        </>
      ) : null}
    </div>
  );
}
