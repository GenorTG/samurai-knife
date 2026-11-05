"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { CategoryIcon, categoryTint } from "@/components/category-icons";
import { Button, ButtonLink } from "@/components/ui";
import { cx } from "@/lib/format";
import { useT } from "@/lib/i18n/react";
import { msg } from "@/lib/i18n/msg";
import { LOCALES, type Locale } from "@/lib/i18n/core";
import { canonicalSlug } from "@/lib/registry";
import { useToolPreferences } from "@/lib/tool-preferences";
import { TOOL_SETS, type ToolSet } from "@/lib/toolsets";

const LANGUAGE_NAME: Record<Locale, string> = { pl: "Polski", en: "English" };

const FACTS: { title: string; text: string }[] = [
  { title: msg("Nothing to install"), text: msg("Everything opens here, in this browser tab. It works on any computer: sign in and your work is there.") },
  { title: msg("It is free"), text: msg("No subscription, no card, no trial that runs out. You get 1 GB of space for your files.") },
  { title: msg("Your files are yours"), text: msg("Other users cannot see what you save in your account. We do not read it or sell it, and you can download or delete it at any time.") },
  { title: msg("Stuck? Help is close"), text: msg("Every tool has an \"About this tool\" page. If you add an AI model in your account settings, the assistant in the corner can also do the work with you. It is optional: everything works without it.") },
];

/** Marks the wizard as done for this account; a failure only means it may be offered once more. */
async function finish(): Promise<void> {
  try {
    await fetch("/api/account/welcome", { method: "PUT", headers: { "Content-Type": "application/json" }, body: "{}" });
  } catch {
    /* offline: nothing lost */
  }
}

/** Slug of a set's first task, to pin it. */
function slugOf(set: ToolSet): string | null {
  const match = /^\/tools\/([a-z0-9-]+)/.exec(set.start.href);
  return match ? canonicalSlug(match[1]) : null;
}

/**
 * The first-run wizard: language, what you came for, four plain facts, and your shortcuts. One decision per screen, big
 * targets, Back on every step and "Skip" always there. What you pick is pinned to Favorites (this browser).
 */
export function WelcomeWizard() {
  const { t, locale } = useT();
  const router = useRouter();
  const { favorites, toggleFavorite } = useToolPreferences();
  const [step, setStep] = useState(0);
  const [picked, setPicked] = useState<string[]>([]);
  const heading = useRef<HTMLHeadingElement>(null);
  const STEPS = 4;

  // A screen reader and a keyboard user land on the new question, not on a button that disappeared.
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) heading.current?.focus();
    opened.current = true;
  }, [step]);

  const go = (next: number) => {
    setStep(next);
  };
  const chooseLanguage = async (next: Locale) => {
    if (next !== locale) {
      await fetch("/api/locale", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ locale: next }) }).catch(() => undefined);
      router.refresh();
    }
    go(1);
  };
  const toggle = (id: string) => setPicked((now) => (now.includes(id) ? now.filter((x) => x !== id) : [...now, id]));
  const chosen = TOOL_SETS.filter((set) => picked.includes(set.id));
  const toFinish = () => {
    for (const set of chosen) {
      const slug = slugOf(set);
      if (slug && !favorites.includes(slug)) toggleFavorite(slug);
    }
    void finish();
    go(3);
  };
  const skip = async () => {
    await finish();
    router.push("/");
    router.refresh();
  };
  const titleClass = "text-2xl font-semibold tracking-tight text-ink outline-none sm:text-3xl";

  return (
    <div data-welcome-step={step}>
      <div className="mb-6 flex items-center justify-between gap-4">
        <ol className="flex flex-1 gap-1.5" aria-label={t("Step {step} of {total}", { step: step + 1, total: STEPS })}>
          {Array.from({ length: STEPS }, (_, i) => (
            <li key={i} className={cx("h-1.5 flex-1 rounded-full", i <= step ? "bg-accent" : "bg-raised")} />
          ))}
        </ol>
        {step < 3 ? (
          <button type="button" autoComplete="off" onClick={() => void skip()} className="shrink-0 rounded-md px-2 py-1 text-sm text-muted underline underline-offset-2 hover:text-ink">
            {t("Skip for now")}
          </button>
        ) : null}
      </div>

      {step === 0 ? (
        <section>
          <h1 ref={heading} tabIndex={-1} className={titleClass}>{t("Welcome to Smart Knife!")}</h1>
          <p className="mt-2 text-[15px] leading-relaxed text-muted">{t("Four short steps, and you will know where everything is. First: which language do you prefer?")}</p>
          <div className="mt-6 grid gap-3 sm:grid-cols-2">
            {LOCALES.map((option) => (
              <button
                key={option}
                type="button"
                autoComplete="off"
                onClick={() => void chooseLanguage(option)}
                data-welcome-language={option}
                className={cx("rounded-tool border p-5 text-left text-lg font-semibold text-ink transition-colors hover:border-accent/50 focus-visible:outline-2 focus-visible:outline-accent", option === locale ? "border-accent bg-accent/10" : "border-line bg-surface")}
              >
                {LANGUAGE_NAME[option]}
              </button>
            ))}
          </div>
        </section>
      ) : null}

      {step === 1 ? (
        <section>
          <h1 ref={heading} tabIndex={-1} className={titleClass}>{t("What did you come here for?")}</h1>
          <p className="mt-2 text-[15px] leading-relaxed text-muted">{t("Pick as many as you like. We will put them within easy reach. Nothing else gets hidden, and you can change this at any time.")}</p>
          <ul className="mt-6 grid gap-3 sm:grid-cols-2">
            {TOOL_SETS.map((set) => {
              const on = picked.includes(set.id);
              return (
                <li key={set.id}>
                  <button
                    type="button"
                    autoComplete="off"
                    aria-pressed={on}
                    onClick={() => toggle(set.id)}
                    data-welcome-set={set.id}
                    className={cx("flex h-full w-full items-start gap-3 rounded-tool border p-4 text-left transition-colors focus-visible:outline-2 focus-visible:outline-accent", on ? "border-accent bg-accent/10" : "border-line bg-surface hover:border-accent/50")}
                  >
                    <span className="mt-0.5" style={categoryTint(set.icon)}>
                      <CategoryIcon category={set.icon} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[15px] font-semibold text-ink">{t(set.name)}</span>
                      <span className="mt-0.5 block text-[13px] leading-relaxed text-muted">{t(set.headline)}</span>
                    </span>
                    <span aria-hidden className={cx("grid size-5 shrink-0 place-items-center rounded-md border text-xs", on ? "border-accent bg-accent text-accent-fg" : "border-line-strong")}>{on ? "✓" : ""}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="mt-6 flex gap-3">
            <Button size="lg" onClick={() => go(0)}>{t("Back")}</Button>
            <Button size="lg" variant="primary" onClick={() => go(2)}>{t("Next")}</Button>
          </div>
        </section>
      ) : null}

      {step === 2 ? (
        <section>
          <h1 ref={heading} tabIndex={-1} className={titleClass}>{t("Four things worth knowing")}</h1>
          <ul className="mt-6 grid gap-3">
            {FACTS.map((fact) => (
              <li key={fact.title} className="rounded-tool border border-line bg-surface p-4">
                <h2 className="text-[15px] font-semibold text-ink">{t(fact.title)}</h2>
                <p className="mt-1 text-sm leading-relaxed text-muted">{t(fact.text)}</p>
              </li>
            ))}
          </ul>
          <div className="mt-6 flex gap-3">
            <Button size="lg" onClick={() => go(1)}>{t("Back")}</Button>
            <Button size="lg" variant="primary" onClick={toFinish}>{t("Next")}</Button>
          </div>
        </section>
      ) : null}

      {step === 3 ? (
        <section>
          <h1 ref={heading} tabIndex={-1} className={titleClass}>{t("All set! Where do you want to start?")}</h1>
          {chosen.length > 0 ? (
            <>
              <p className="mt-2 text-[15px] leading-relaxed text-muted">{t("Your choices are now pinned at the top of the menu on the left.")}</p>
              <ul className="mt-6 grid gap-3">
                {chosen.map((set) => (
                  <li key={set.id}>
                    <ButtonLink href={set.start.href} variant="primary" size="lg" className="w-full justify-center">{t(set.start.label)}</ButtonLink>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="mt-2 text-[15px] leading-relaxed text-muted">{t("The home page lists every job you can do here, in plain words.")}</p>
          )}
          <p className="mt-6">
            <Link href="/" onClick={() => router.refresh()} className="text-[15px] text-accent-soft underline underline-offset-2" data-welcome-home>
              {t("Go to the home page")}
            </Link>
          </p>
        </section>
      ) : null}
    </div>
  );
}
