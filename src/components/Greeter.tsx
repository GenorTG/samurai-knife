"use client";

import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import { GithubButton } from "@/components/account/GithubButton";
import { ButtonLink } from "@/components/ui";
import { TOOLS } from "@/lib/registry";
import { useT } from "@/lib/i18n/react";
import { msg } from "@/lib/i18n/msg";

/**
 * First screen for a signed-out visitor on the public server (`/`): what the app does, why it is safe to use, and the way
 * in (register / log in). Server-rendered, no client state. Every tool needs an account: the feature cards go through the
 * login (`/login?next=`) and land on the tool afterwards.
 */

const ICONS = {
  cv: "M7 3h10a1 1 0 011 1v16a1 1 0 01-1 1H7a1 1 0 01-1-1V4a1 1 0 011-1zM12 8.5a2 2 0 100-4 2 2 0 000 4zM9 11.5c.6-1 1.7-1.5 3-1.5s2.4.5 3 1.5M9 15h6M9 18h4",
  office: "M7 3h7l5 5v13H7zM14 3v5h5M10 12h6M10 15.5h6M10 19h3.5",
  site: "M3 5h18v14H3zM3 9h18M6.5 7h.01M9 7h.01M8 13l-2 2 2 2M16 13l2 2-2 2M13 12l-2 6",
  learn: "M3 9l9-4 9 4-9 4zM7 11v4.5c0 1.4 2.2 2.5 5 2.5s5-1.1 5-2.5V11M21 9v5",
  ai: "M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8zM18 15l.9 2.1L21 18l-2.1.9L18 21l-.9-2.1L15 18l2.1-.9z",
  tools: "M14.5 5.5l4 4M4 20l6.5-6.5M9 4.5l10.5 10.5-3 3L6 7.5zM4 20h4",
  browser: "M4 5h16v14H4zM4 9h16M8 13h8M8 16h5",
  lock: "M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 017 0v3M12 15v2",
  key: "M14.5 9.5a4 4 0 11-1.2-2.8 4 4 0 011.2 2.8zM13.3 12.3L20 19M17 16l2-2M15.5 14.5l1.5-1.5",
} as const;

function Icon({ name, size = 20 }: { name: keyof typeof ICONS; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={ICONS[name]} />
    </svg>
  );
}

/** Hue on the shared accent (same trick as category tiles), so it follows the theme. */
function tint(hue: number): CSSProperties {
  return { color: `oklch(from var(--c-accent) l c ${hue})` };
}

function IconTile({ name, hue }: { name: keyof typeof ICONS; hue: number }) {
  return (
    <span className="grid size-10 shrink-0 place-items-center rounded-xl border border-line bg-raised/70" style={tint(hue)}>
      <Icon name={name} />
    </span>
  );
}

const FEATURES: { icon: keyof typeof ICONS; hue: number; title: string; href: string; text: string }[] = [
  {
    icon: "cv",
    hue: 25,
    title: msg("CV studio"),
    href: "/tools/cv-studio",
    text: msg("One bilingual PL/EN CV profile. Save job offers, get a tailored version for each one with an ATS check, and track every application."),
  },
  {
    icon: "office",
    hue: 200,
    title: msg("Office documents"),
    href: "/tools/office",
    text: "A private library of Word, Excel and PowerPoint files with folders, versions and trash, edited in a full office editor in the browser.",
  },
  {
    icon: "site",
    hue: 155,
    title: msg("Website studio"),
    href: "/tools/site-studio",
    text: msg("Connect your site's GitHub repository, audit SEO, copy and Lighthouse scores, and ship the fixes as pull requests you review."),
  },
  {
    icon: "learn",
    hue: 290,
    title: msg("Database course"),
    href: "/tools/db-course",
    text: "SQL and PostGIS in short lessons, run against a real PostgreSQL database with instant checks and hints when you get stuck.",
  },
  {
    icon: "ai",
    hue: 330,
    title: msg("An assistant that uses the tools"),
    href: "/tools/mcp-connect",
    text: msg("The chat assistant opens tools, fills fields and works through a task with you on the model you pick; you approve the risky steps. Your own agents (Claude, Cursor…) connect over MCP."),
  },
  {
    icon: "tools",
    hue: 80,
    title: msg("The everyday toolbox"),
    href: "/tools/json",
    text: "PDF editing and OCR, image export, JSON, CSV, SQL, regex, JWT, colours, cron and more. Small, sharp and fast.",
  },
];

const PROMISES: { icon: keyof typeof ICONS; title: string; text: string }[] = [
  { icon: "browser", title: msg("Browser first"), text: msg("Most tools work on your files inside this tab. Nothing is uploaded unless a tool says it needs the server.") },
  { icon: "lock", title: msg("Private per account"), text: msg("Your CV, documents and drafts belong to your account only and are encrypted at rest on the server.") },
  { icon: "key", title: msg("Your model, your key"), text: msg("Use any OpenAI-compatible provider. The key stays on the server and never reaches the page.") },
];

const STEPS: { title: string; text: string }[] = [
  { title: msg("Pick a username"), text: msg("Register with an email address and a password, or in one click with GitHub.") },
  { title: msg("Confirm your email"), text: msg("Open the link we send you. Nothing else: no card, no trial clock, no approval queue.") },
  { title: msg("Use everything"), text: msg("All the tools, the studios, the assistant and your own MCP key, with 1 GB of private storage.") },
];

const MEMBER = [
  msg("Every browser tool: PDF, images, JSON, CSV, text, dev helpers"),
  "CV studio, office library, website studio, database course",
  msg("Server tools: searchable PDFs (OCR), SQL checks"),
  msg("The AI assistant and a personal MCP key for your agents"),
  msg("Drafts saved to your account, encrypted at rest"),
];

function Check({ on }: { on: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden className={on ? "mt-0.5 shrink-0 text-accent-soft" : "mt-0.5 shrink-0 text-faint"}>
      <path d="M3.5 8.5l3 3 6-7" />
    </svg>
  );
}

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
  // Counted in tabs (what a visitor sees as a tool), not in suites.
  const count = (tools: typeof TOOLS) => tools.reduce((sum, tool) => sum + (tool.tabs?.length ?? 1), 0);
  const toolCount = count(TOOLS);
  const browserCount = count(TOOLS.filter((tool) => tool.kind === "client"));

  return (
    <div className="mx-auto w-full max-w-6xl">
      {/* Hero */}
      <section aria-labelledby="greeter-title" className="grid items-center gap-10 pt-4 sm:pt-10 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <div>
          <p className="inline-flex items-center gap-2 rounded-full border border-line bg-surface/70 px-3 py-1 font-mono text-xs text-muted shadow-xs">
            <span className="size-1.5 rounded-full bg-good" aria-hidden />
            {t("Free · self-hosted · no ads, no tracking")}
          </p>
          <h1 id="greeter-title" className="mt-5 text-4xl font-semibold leading-[1.08] tracking-tight text-ink sm:text-5xl">
            {t("Every small tool you reach for,")}{" "}
            <span className="bg-linear-to-r from-accent via-accent-soft to-ai bg-clip-text text-transparent">{t("in one sharp place.")}</span>
          </h1>
          <p className="mt-5 max-w-xl text-[17px] leading-relaxed text-muted">
            {t("{toolCount} hand-made tools for documents, data, code and your job search, plus an AI assistant that can drive all of them. Most run right in your browser, so your files stay on your machine.", { toolCount })}
          </p>
          <div className="mt-8">
            <CallToAction github={github} />
          </div>
          <p className="mt-4 text-sm text-faint">{t("Only an email confirmation. No card, no trial clock.")}</p>
        </div>

        {/* A still life of the app, not a screenshot: the assistant at work on a CV. */}
        <div aria-hidden className="relative">
          <div className="absolute -inset-6 -z-10 rounded-[2rem] bg-[radial-gradient(closest-side,var(--glow-ai),transparent),radial-gradient(closest-side_at_70%_30%,var(--glow),transparent)] blur-2xl" />
          <div className="rounded-tool border border-line bg-surface shadow-pop">
            <div className="flex items-center gap-2 border-b border-line px-4 py-3">
              <span className="size-2.5 rounded-full bg-danger/70" />
              <span className="size-2.5 rounded-full bg-warn/70" />
              <span className="size-2.5 rounded-full bg-good/70" />
              <span className="ml-3 font-mono text-xs text-faint">{t("/tools/cv-studio")}</span>
            </div>
            <div className="space-y-3 p-4 text-sm">
              <div className="ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-md bg-raised px-3.5 py-2 text-ink">
                {t("Tailor my CV for the AI engineer offer I saved and check it against their ATS.")}
              </div>
              <div className="w-fit max-w-[90%] space-y-2 rounded-2xl rounded-bl-md border border-ai/30 bg-ai/5 px-3.5 py-2.5 text-muted">
                <p className="text-ink">{t("Done. I made a version for that offer:")}</p>
                <ul className="space-y-1">
                  {[t("Opened CV studio, offer “AI engineer”"), t("Moved LLM projects to the top"), "ATS check: 2 fixable gaps, 0 missing skills"].map((line) => (
                    <li key={line} className="flex gap-2">
                      <Check on />
                      <span>{t(line)}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="grid grid-cols-3 gap-2 pt-1">
                {[
                  [String(toolCount), "tools"],
                  [String(browserCount), "in your browser"],
                  ["1 GB", "private storage"],
                ].map(([value, label]) => (
                  <div key={label} className="rounded-lg border border-line bg-field px-3 py-2">
                    <div className="font-mono text-base font-semibold tabular-nums text-ink">{value}</div>
                    <div className="text-xs text-faint">{label}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      <Section id="features" eyebrow={t("What's inside")} title={t("Big studios and small sharp tools")}>
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((feature) => (
            <li key={feature.title}>
              <Link
                href={`/login?next=${encodeURIComponent(feature.href)}`}
                className="group flex h-full flex-col gap-3 rounded-tool border border-line bg-surface p-5 shadow-card transition-colors hover:border-line-strong hover:bg-raised/40"
              >
                <IconTile name={feature.icon} hue={feature.hue} />
                <h3 className="text-[15px] font-semibold tracking-tight text-ink">{t(feature.title)}</h3>
                <p className="text-sm leading-relaxed text-muted">{t(feature.text)}</p>
              </Link>
            </li>
          ))}
        </ul>
      </Section>

      <Section id="privacy" eyebrow={t("How it treats your data")} title={t("Built to keep your things yours")}>
        <ul className="grid gap-4 md:grid-cols-3">
          {PROMISES.map((promise) => (
            <li key={promise.title} className="flex gap-4 rounded-tool border border-line bg-surface/60 p-5">
              <span className="mt-0.5 text-accent-soft">
                <Icon name={promise.icon} size={22} />
              </span>
              <div>
                <h3 className="text-[15px] font-semibold tracking-tight text-ink">{t(promise.title)}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-muted">{t(promise.text)}</p>
              </div>
            </li>
          ))}
        </ul>
      </Section>

      <Section id="account" eyebrow={t("Getting in")} title={t("Three steps to your own toolbox")}>
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
          <ol className="grid gap-3">
            {STEPS.map((step, i) => (
              <li key={step.title} className="flex gap-4 rounded-tool border border-line bg-surface/60 p-5">
                <span className="grid size-8 shrink-0 place-items-center rounded-full border border-accent/40 font-mono text-sm font-semibold text-accent-soft">
                  {i + 1}
                </span>
                <div>
                  <h3 className="text-[15px] font-semibold tracking-tight text-ink">{t(step.title)}</h3>
                  <p className="mt-1 text-sm leading-relaxed text-muted">{t(step.text)}</p>
                </div>
              </li>
            ))}
          </ol>
          <div className="rounded-tool border border-accent/40 bg-surface p-5 shadow-card ring-1 ring-accent/10">
            <h3 className="text-[15px] font-semibold text-ink">{t("What your free account includes")}</h3>
            <ul className="mt-3 space-y-2 text-sm text-muted">
              {MEMBER.map((line) => (
                <li key={line} className="flex gap-2">
                  <Check on />
                  <span>{t(line)}</span>
                </li>
              ))}
            </ul>
            <div className="mt-5">
              <ButtonLink href="/register" variant="primary">
                {t("Register now")}
              </ButtonLink>
            </div>
          </div>
        </div>
      </Section>

      <section aria-labelledby="greeter-cta" className="mt-16 rounded-tool border border-line bg-surface px-6 py-10 text-center shadow-card sm:mt-20 sm:px-10">
        <h2 id="greeter-cta" className="text-2xl font-semibold tracking-tight text-ink sm:text-3xl">
          {t("Your toolbox is one email away.")}
        </h2>
        <p className="mx-auto mt-3 max-w-lg text-[15px] text-muted">{t("Pick a username, confirm your address, and everything above is yours.")}</p>
        <div className="mt-7 flex justify-center">
          <CallToAction github={github} size="md" />
        </div>
      </section>
    </div>
  );
}
