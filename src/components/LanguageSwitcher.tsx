"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition, type KeyboardEvent as ReactKeyboardEvent } from "react";
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

function markDocumentLanguage(code: Locale): void {
  document.documentElement.lang = code;
}

/**
 * The top-bar language menu, on every page (app shell and public pages): a globe and the current language's name (its
 * code on narrow screens), opening a menu that lists every language in its own name, so a reader who cannot read the
 * current one still finds theirs. Choosing one sets the cookie (and, signed in, the account) and re-renders the page.
 */
export function LanguageSwitcher({ className }: { className?: string }) {
  const { locale, t } = useT();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const label = t("Language: {current}", { current: LOCALE_NAMES[locale] });

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      root.current?.querySelector<HTMLButtonElement>("[data-language-switcher]")?.focus();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    root.current?.querySelector<HTMLButtonElement>("[role=menuitemradio][aria-checked=true]")?.focus();
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const choose = async (code: Locale) => {
    setOpen(false);
    if (code === locale) return;
    setBusy(true);
    const ok = await switchLocale(code);
    setBusy(false);
    if (ok) {
      markDocumentLanguage(code);
      startTransition(() => router.refresh());
    }
  };

  const onMenuKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const items = [...(event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=menuitemradio]") ?? [])];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    items[(at + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
  };

  return (
    <div ref={root} className={cx("relative", className)}>
      <button
        autoComplete="off"
        type="button"
        onClick={() => setOpen((value) => !value)}
        disabled={busy || pending}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        title={label}
        data-language-switcher={locale}
        className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-surface px-2 text-xs font-medium text-muted shadow-xs transition-colors hover:border-line-strong hover:text-ink disabled:opacity-60"
      >
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
          <circle cx="12" cy="12" r="9" />
          <path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9s1.3-6.4 3.8-9z" />
        </svg>
        <span className="hidden sm:inline">{LOCALE_NAMES[locale]}</span>
        <span className="font-mono uppercase sm:hidden">{locale}</span>
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden className="max-sm:hidden">
          <path d="M7 10l5 5 5-5" />
        </svg>
      </button>
      {open ? (
        <div
          role="menu"
          aria-label={t("Interface language")}
          onKeyDown={onMenuKey}
          className="absolute right-0 top-full z-50 mt-1.5 min-w-40 rounded-lg border border-line bg-surface p-1 shadow-lg"
        >
          {LOCALES.map((code) => (
            <button
              key={code}
              autoComplete="off"
              type="button"
              role="menuitemradio"
              aria-checked={code === locale}
              lang={code}
              onClick={() => void choose(code)}
              className={cx(
                "flex w-full items-center justify-between gap-3 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-raised focus:bg-raised focus:outline-none",
                code === locale ? "font-medium text-ink" : "text-muted hover:text-ink",
              )}
            >
              <span>{LOCALE_NAMES[code]}</span>
              <span className="font-mono text-xs uppercase text-muted">{code === locale ? "✓" : code}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
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
