"use client";

import { useEffect, useState } from "react";
import { fetchUsage } from "@/lib/agent-client/api";
import { cacheShare, formatTokens, type UsageBucket, type UsageSummary } from "@/lib/usage";
import { useT } from "@/lib/i18n/react";

/** Token counters from the server ledger: what this account's model rounds cost today, this week and in total. */

function row(label: string, b: UsageBucket) {
  const avg = b.requests > 0 ? `${(b.ms / b.requests / 1000).toFixed(1)} s` : "–";
  return (
    <tr key={label} className="border-t border-line">
      <th scope="row" className="py-1 pr-2 text-left font-medium text-muted">{label}</th>
      <td className="px-1 py-1 text-right tabular-nums">{b.requests}</td>
      <td className="px-1 py-1 text-right tabular-nums">{formatTokens(b.promptTokens)}</td>
      <td className="px-1 py-1 text-right tabular-nums">{b.cachedTokens > 0 ? `${cacheShare(b)}%` : "–"}</td>
      <td className="px-1 py-1 text-right tabular-nums">{formatTokens(b.completionTokens)}</td>
      <td className="px-1 py-1 text-right tabular-nums">{avg}</td>
      <td className="py-1 pl-1 text-right tabular-nums">{b.errors}</td>
    </tr>
  );
}

export function UsagePanel() {
  const { t } = useT();
  const [summary, setSummary] = useState<UsageSummary | null | "loading">("loading");

  useEffect(() => {
    let live = true;
    void fetchUsage().then((s) => {
      if (live) setSummary(s);
    });
    return () => {
      live = false;
    };
  }, []);

  return (
    <section aria-label={t("Token usage")} className="space-y-2">
      {summary === "loading" ? <p className="text-xs text-faint">{t("Loading…")}</p> : null}
      {summary === null ? <p role="alert" className="text-xs text-danger">{t("Could not load usage.")}</p> : null}
      {summary && summary !== "loading" ? (
        <>
          <table className="w-full table-fixed text-xs text-ink">
            <colgroup>
              <col className="w-[22%]" />
            </colgroup>
            <thead>
              <tr className="text-[11px] text-faint">
                <th scope="col" className="text-left font-normal">
                  <span className="sr-only">{t("Period")}</span>
                </th>
                <th scope="col" className="px-1 text-right font-normal">{t("Rounds")}</th>
                <th scope="col" className="px-1 text-right font-normal">{t("In")}</th>
                <th scope="col" className="px-1 text-right font-normal">{t("Cached")}</th>
                <th scope="col" className="px-1 text-right font-normal">{t("Out")}</th>
                <th scope="col" className="px-1 text-right font-normal">{t("Avg")}</th>
                <th scope="col" className="pl-1 text-right font-normal">{t("Err")}</th>
              </tr>
            </thead>
            <tbody>
              {row("Today", summary.today)}
              {row("7 days", summary.last7Days)}
              {row(t("All time"), summary.total)}
            </tbody>
          </table>
          {summary.models.length > 0 ? (
            <p className="text-[11px] break-words text-faint">
              {summary.models.map((m) => `${m.model}: ${m.bucket.requests} rounds, ${formatTokens(m.bucket.promptTokens + m.bucket.completionTokens)} tokens`).join(" · ")}
            </p>
          ) : null}
          <p className="text-[11px] text-faint">{t("Counts come from the provider; a provider that reports nothing is estimated (shown with “~” per turn). Prompts and answers are never stored here.")}</p>
        </>
      ) : null}
    </section>
  );
}
