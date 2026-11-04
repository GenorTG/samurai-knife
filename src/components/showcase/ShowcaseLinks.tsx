"use client";

import Link from "next/link";
import { entryHref, useShowcasePrefs } from "@/lib/showcase-prefs";
import { useT } from "@/lib/i18n/react";

/** A home-page card link: the tool's showcase first, or the tool when the user chose that (docs/SHOWCASE.md). */
export function ToolEntryLink({ slug, tab, className, children }: { slug: string; tab?: string; className?: string; children: React.ReactNode }) {
  const { prefs } = useShowcasePrefs();
  return (
    <Link href={entryHref(prefs, slug, tab)} className={className}>
      {children}
    </Link>
  );
}

/** The two choices on a showcase page: skip this tool's showcase from now on, or open every tool straight away. */
export function ShowcaseChoices({ slug }: { slug: string }) {
  const { t } = useT();
  const { prefs, ready, setDirect, setSkip } = useShowcasePrefs();
  const box = "mt-0.5 h-4 w-4 shrink-0 accent-[var(--c-accent)]";
  return (
    <fieldset className="mt-4 space-y-2 text-sm text-muted" disabled={!ready}>
      <legend className="sr-only">{t("How tools open")}</legend>
      <label className="flex items-start gap-2">
        <input type="checkbox" className={box} checked={prefs.skip.includes(slug)} onChange={(e) => setSkip(slug, e.target.checked)} />
        <span>{t("Don't show this page again for this tool")}</span>
      </label>
      <label className="flex items-start gap-2">
        <input type="checkbox" className={box} checked={prefs.direct} onChange={(e) => setDirect(e.target.checked)} />
        <span>{t("Open tools straight away (skip these pages)")}</span>
      </label>
      <p className="text-xs text-faint">{t("Kept in this browser only. Every tool page links back here with \"About this tool\".")}</p>
    </fieldset>
  );
}
