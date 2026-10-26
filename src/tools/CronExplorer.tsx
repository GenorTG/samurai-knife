"use client";

import { useMemo, useState } from "react";
import { Button, Field, Notice, Panel, Stat, StatGrid, TextInput } from "@/components/ui";
import { findNextCronRuns, parseCron } from "@/lib/cron";
import { useT } from "@/lib/i18n/react";
import { msg } from "@/lib/i18n/msg";

const PRESETS = [
  { label: msg("Every 15 minutes"), value: "*/15 * * * *" },
  { label: msg("Weekdays, 9 to 5"), value: "*/5 9-17 * * 1-5" },
  { label: msg("Midnight daily"), value: "0 0 * * *" },
  { label: msg("First day of month"), value: "0 9 1 * *" },
];

const FIELD_LABELS = [msg("Minute"), msg("Hour"), msg("Day of month"), msg("Month"), msg("Day of week")] as const;

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

export default function CronExplorer() {
  const { t } = useT();
  const [expression, setExpression] = useState("*/15 * * * *");
  const [preview, setPreview] = useState<{ expression: string; dates: Date[]; zone: string } | null>(null);
  const parsed = useMemo(() => parseCron(expression), [expression]);
  const fields = expression.trim().split(/\s+/);

  const inspectNextRuns = () => {
    if (!parsed.ok) return;
    const dates = findNextCronRuns(parsed.value, 10);
    setPreview({
      expression: expression.trim(),
      dates,
      zone: Intl.DateTimeFormat().resolvedOptions().timeZone || "local time",
    });
  };

  const currentPreview = preview?.expression === expression.trim() ? preview : null;

  return (
    <div className="space-y-4">
      <Panel title={t("Cron expression")}>
        <div className="space-y-4">
          <Field label={t("Five-field schedule")} hint={t("minute hour day-of-month month day-of-week · numeric values, lists, ranges and steps")}>
            <TextInput value={expression} spellCheck={false} onChange={(event) => setExpression(event.target.value)} className="font-mono text-base" />
          </Field>
          <div className="flex flex-wrap gap-1.5">
            {PRESETS.map((preset) => <Button key={preset.value} size="sm" variant="ghost" onClick={() => { setExpression(preset.value); setPreview(null); }}>{t(preset.label)}</Button>)}
          </div>
          {parsed.ok ? (
            <StatGrid>
              {FIELD_LABELS.map((label, index) => <Stat key={label} label={label} value={fields[index] ?? "*"} />)}
            </StatGrid>
          ) : <Notice tone="error">{parsed.error}</Notice>}
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="primary" disabled={!parsed.ok} onClick={inspectNextRuns}>{t("Preview next 10 runs")}</Button>
            <p className="text-xs text-faint">{t("Uses your browser’s local timezone; search is capped at one year.")}</p>
          </div>
        </div>
      </Panel>

      <Panel title={t("Next runs")} right={currentPreview ? <span className="font-mono text-[11px] text-faint">{currentPreview.zone}</span> : undefined}>
        {currentPreview ? currentPreview.dates.length ? (
          <ol className="divide-y divide-line rounded-lg border border-line">
            {currentPreview.dates.map((date, index) => <li key={`${date.getTime()}-${index}`} className="flex items-center gap-3 px-3 py-2.5 text-sm">
              <span className="w-7 shrink-0 font-mono text-xs text-faint">{String(index + 1).padStart(2, "0")}</span>
              <time className="font-mono text-ink">{formatDate(date)}</time>
            </li>)}
          </ol>
        ) : <Notice>{t("No matching run was found in the next year.")}</Notice> : <p className="text-sm text-faint">{t("Validate the expression, then preview its next scheduled times.")}</p>}
      </Panel>

      <Panel title={t("Supported syntax")}>
        <div className="grid gap-3 text-sm text-muted sm:grid-cols-2">
          <p><code className="text-ink">*</code> {" "}{t("any value ·")}{" "} <code className="text-ink">*/n</code> {" "}{t("every n values ·")}{" "} <code className="text-ink">a-b</code> {" "}{t("inclusive range")}</p>
          <p><code className="text-ink">a,b</code> {" "}{t("value list ·")}{" "} <code className="text-ink">a-b/n</code> {" "}{t("stepped range · weekday 0 or 7 is Sunday")}</p>
          <p className="sm:col-span-2">{t("When both day-of-month and day-of-week are restricted, either field may match. Month and weekday names are not supported; use numbers.")}</p>
        </div>
      </Panel>
    </div>
  );
}
