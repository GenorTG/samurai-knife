"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { cx } from "@/lib/format";
import { LOCALE_NAMES, LOCALES, type Locale } from "@/lib/i18n/core";
import { useT } from "@/lib/i18n/react";

/** Sets the interface language for this device and (signed in) the account, then re-renders the page in it. */
export async function switchLocale(locale: Locale): Promise<boolean> {
  try {
    const res = await fetch("/api/locale", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ locale }),
    });
    await res.text();
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * The top-bar switch between the interface languages (two today: one click flips). Shows the current language's code;
 * the label names both in their own language so either reader finds it.
 */
export function LanguageSwitcher({ className }: { className?: string }) {
  const { locale, t } = useT();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const next = LOCALES[(LOCALES.indexOf(locale) + 1) % LOCALES.length];
  const label = t("Language: {current}. Switch to {next}", { current: LOCALE_NAMES[locale], next: LOCALE_NAMES[next] });

  const flip = async () => {
    setBusy(true);
    const ok = await switchLocale(next);
    setBusy(false);
    if (ok) {
      document.documentElement.lang = next;
      startTransition(() => router.refresh());
    }
  };

  return (
    <button
      autoComplete="off"
      type="button"
      onClick={flip}
      disabled={busy || pending}
      aria-label={label}
      title={label}
      data-language-switcher={locale}
      className={cx(
        "inline-flex h-8 min-w-8 items-center justify-center rounded-lg border border-line bg-surface px-1.5 font-mono text-xs font-semibold text-muted uppercase shadow-xs transition-colors hover:border-line-strong hover:text-ink disabled:opacity-60",
        className,
      )}
    >
      {locale}
    </button>
  );
}

/** Account page / settings: both languages as a radio group. */
export function LanguageChoice() {
  const { locale, t } = useT();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <div role="radiogroup" aria-label={t("Interface language")} className="inline-flex rounded-lg border border-line bg-surface p-0.5">
      {LOCALES.map((code) => (
        <button
          key={code}
          autoComplete="off"
          type="button"
          role="radio"
          aria-checked={code === locale}
          disabled={pending}
          onClick={async () => {
            if (code === locale) return;
            if (await switchLocale(code)) {
              document.documentElement.lang = code;
              startTransition(() => router.refresh());
            }
          }}
          className={cx(
            "rounded-md px-3 py-1.5 text-sm transition-colors",
            code === locale ? "bg-accent/15 font-medium text-ink" : "text-muted hover:text-ink",
          )}
        >
          {LOCALE_NAMES[code]}
        </button>
      ))}
    </div>
  );
}
