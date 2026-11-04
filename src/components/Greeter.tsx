"use client";

import type { ReactNode } from "react";
import { GithubButton } from "@/components/account/GithubButton";
import { SetCards } from "@/components/sets/SetCards";
import { ButtonLink } from "@/components/ui";
import { useT } from "@/lib/i18n/react";
import { msg } from "@/lib/i18n/msg";
import { TRADEMARK_NOTE } from "@/lib/toolsets";

/**
 * First screen for a signed-out visitor on the public server (`/`): says straight out what this replaces and that it is
 * free, then the tool sets (public pages), how to get in, and how it treats your data. Plain words: the reader is not
 * assumed to know what a browser tool or a provider is.
 */

/** The hero's comparison: the paid products people know, and what they use here instead. */
const INSTEAD: { paid: string; ours: string; what: string }[] = [
  { paid: "Microsoft Word, Excel, PowerPoint", ours: "Euro-Office", what: msg("documents, spreadsheets, slides") },
  { paid: "Adobe Photoshop", ours: "PhotoCraft", what: msg("photo editing") },
  { paid: "Adobe Premiere Pro", ours: "FilmCraft", what: msg("video editing") },
  { paid: "Adobe Illustrator", ours: "VectorCraft", what: msg("logos and graphics") },
  { paid: "Adobe Acrobat", ours: msg("PDF tools"), what: msg("editing and merging PDFs") },
  { paid: msg("Paid CV websites"), ours: msg("CV builder"), what: msg("a ready CV in PDF or Word") },
];

const PROMISES: { title: string; text: string }[] = [
  { title: msg("Free, with no catch"), text: msg("No card, no trial that runs out, no ads, no tracking. You get 1 GB of space for your files.") },
  { title: msg("Nothing to install"), text: msg("Everything opens in your browser, on any computer. Sign in and your work is there.") },
  { title: msg("Your files stay yours"), text: msg("Only you can see what you save, it is encrypted on the server, and you can delete it at any time. Many tools do not send your files anywhere at all.") },
];

const STEPS: { title: string; text: string }[] = [
  { title: msg("Choose a username and a password"), text: msg("Or sign up in one click with GitHub, if you use it.") },
  { title: msg("Confirm your email address"), text: msg("Open the link we send you. That is all: no card and no waiting.") },
  { title: msg("We show you around"), text: msg("A short guide asks what you came for and takes you straight there.") },
];

function CallToAction({ github, size = "lg" }: { github: boolean; size?: "md" | "lg" }) {
  const { t } = useT();
  return (
    <div className="flex flex-wrap items-center gap-3">
      <ButtonLink href="/register" variant="primary" size={size}>
        {t("Create a free account")}
      </ButtonLink>
      <ButtonLink href="/login" size={size}>
        {t("Log in")}
      </ButtonLink>
      {github ? (
        <span className="w-56">
          <GithubButton label={t("Sign up with GitHub")} />
        </span>
      ) : null}
    </div>
  );
}

function Section({ id, eyebrow, title, children }: { id?: string; eyebrow: string; title: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={id ? `${id}-title` : undefined} className="mt-16 sm:mt-20">
      <p className="font-mono text-xs uppercase tracking-[0.18em] text-accent-soft">{eyebrow}</p>
      <h2 id={id ? `${id}-title` : undefined} className="mt-2 text-2xl font-semibold tracking-tight text-ink sm:text-3xl">
        {title}
      </h2>
      <div className="mt-6">{children}</div>
    </section>
  );
}

export function Greeter({ github }: { github: boolean }) {
  const { t } = useT();
  return (
    <div className="mx-auto w-full max-w-6xl">
      <section aria-labelledby="greeter-title" className="grid items-center gap-10 pt-4 sm:pt-10 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        <div>
          <p className="inline-flex items-center gap-2 rounded-full border border-line bg-surface/70 px-3 py-1 text-xs text-muted shadow-xs">
            <span className="size-1.5 rounded-full bg-good" aria-hidden />
            {t("Free · nothing to install · no ads")}
          </p>
          <h1 id="greeter-title" className="mt-5 text-4xl font-semibold leading-[1.08] tracking-tight text-ink sm:text-5xl">
            {t("Stop paying for")}{" "}
            <span className="bg-linear-to-r from-accent via-accent-soft to-ai bg-clip-text text-transparent">{t("Microsoft 365 and Adobe.")}</span>
          </h1>
          <p className="mt-5 max-w-xl text-[17px] leading-relaxed text-muted">
            {t("Write documents and spreadsheets, edit photos and video, work with PDFs and make your CV, all in your browser. Free, on any computer, with nothing to install.")}
          </p>
          <div className="mt-8">
            <CallToAction github={github} />
          </div>
          <p className="mt-4 text-sm text-faint">{t("You only need an email address. No card, no trial that runs out.")}</p>
        </div>

        <div className="rounded-tool border border-line bg-surface shadow-pop" data-greeter-instead>
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-line text-xs text-faint">
                <th scope="col" className="px-4 py-3 font-medium">{t("Instead of paying for")}</th>
                <th scope="col" className="px-4 py-3 font-medium">{t("Use here, free")}</th>
              </tr>
            </thead>
            <tbody>
              {INSTEAD.map((row) => (
                <tr key={row.ours} className="border-b border-line last:border-0">
                  <td className="px-4 py-3 text-muted">{t(row.paid)}</td>
                  <td className="px-4 py-3">
                    <span className="block font-semibold text-ink">{t(row.ours)}</span>
                    <span className="block text-xs text-faint">{t(row.what)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <Section id="features" eyebrow={t("What's inside")} title={t("Choose what you need")}>
        <SetCards />
      </Section>

      <Section id="account" eyebrow={t("Getting started")} title={t("Three steps, about two minutes")}>
        <ol className="grid gap-3 md:grid-cols-3">
          {STEPS.map((step, i) => (
            <li key={step.title} className="flex gap-4 rounded-tool border border-line bg-surface/60 p-5">
              <span className="grid size-8 shrink-0 place-items-center rounded-full border border-accent/40 text-sm font-semibold text-accent-soft">{i + 1}</span>
              <div>
                <h3 className="text-[15px] font-semibold tracking-tight text-ink">{t(step.title)}</h3>
                <p className="mt-1 text-sm leading-relaxed text-muted">{t(step.text)}</p>
              </div>
            </li>
          ))}
        </ol>
      </Section>

      <Section id="privacy" eyebrow={t("Why you can trust it")} title={t("No small print")}>
        <ul className="grid gap-4 md:grid-cols-3">
          {PROMISES.map((promise) => (
            <li key={promise.title} className="rounded-tool border border-line bg-surface/60 p-5">
              <h3 className="text-[15px] font-semibold tracking-tight text-ink">{t(promise.title)}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-muted">{t(promise.text)}</p>
            </li>
          ))}
        </ul>
      </Section>

      <section aria-labelledby="greeter-cta" className="mt-16 rounded-tool border border-line bg-surface px-6 py-10 text-center shadow-card sm:mt-20 sm:px-10">
        <h2 id="greeter-cta" className="text-2xl font-semibold tracking-tight text-ink sm:text-3xl">{t("Try it now. It costs nothing.")}</h2>
        <p className="mx-auto mt-3 max-w-lg text-[15px] text-muted">{t("Create an account, confirm your email address, and everything above is yours.")}</p>
        <div className="mt-7 flex justify-center">
          <CallToAction github={github} size="md" />
        </div>
      </section>

      <p className="mt-8 text-xs leading-relaxed text-faint">{t(TRADEMARK_NOTE)}</p>
    </div>
  );
}
