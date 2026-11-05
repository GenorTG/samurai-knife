import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { BetaBadge, KindBadge } from "@/components/ToolShell";
import { ShowcaseChoices } from "@/components/showcase/ShowcaseLinks";
import { ButtonLink } from "@/components/ui";
import { isGuest } from "@/lib/accounts/viewer";
import { findTool, resolveAlias } from "@/lib/registry";
import { showcaseFor, showcaseHref, type ShowcaseRuns } from "@/lib/showcase";
import { getT } from "@/lib/i18n/server";
import { msg } from "@/lib/i18n/msg";
import { HOSTED_NOTES, type HostedId } from "@/lib/toolsets";

/**
 * A tool's showcase (docs/SHOWCASE.md): what it is for, what you can do, who it is for, where it runs and what the
 * assistant can do there. Public in both modes, even for signed-out visitors in public mode: it reads only the registry
 * and src/lib/showcase.ts, never an account (the tool page itself still needs a session).
 */
export async function generateMetadata({ params }: PageProps<"/tools/[slug]/about">): Promise<Metadata> {
  const { slug } = await params;
  const tool = findTool(slug);
  const showcase = tool ? showcaseFor(slug) : null;
  if (!tool || !showcase) return {};
  const { t } = await getT();
  const title = t("{tool}: what it is and what it does", { tool: t(tool.name) });
  const description = t(showcase.purpose);
  return {
    title,
    description,
    alternates: { canonical: `/tools/${slug}/about` },
    openGraph: { title, description, ...(showcase.image ? { images: [{ url: showcase.image.src, width: 1280, height: 800 }] } : {}) },
  };
}

// The frame (signed in or the public welcome frame) is decided per request.
export const dynamic = "force-dynamic";

/** Tools that are someone else's open-source software, hosted here. */
const HOSTED: Readonly<Record<string, HostedId>> = { office: "office", artcraft: "craft" };

const RUNS_LABEL: Record<ShowcaseRuns, string> = {
  browser: msg("In your browser"),
  server: msg("On this server"),
  sidecar: msg("In an add-on on this website's server"),
};

export default async function ShowcasePage({ params, searchParams }: PageProps<"/tools/[slug]/about">) {
  const { slug } = await params;
  const alias = resolveAlias(slug);
  if (alias) permanentRedirect(showcaseHref(alias.slug, alias.tab));
  const tool = findTool(slug);
  const showcase = tool ? showcaseFor(slug) : null;
  if (!tool || !showcase) notFound();
  const { t } = await getT();
  const guest = await isGuest();
  const requested = (await searchParams).tab;
  const tab = typeof requested === "string" && tool.tabs?.some((x) => x.id === requested) ? requested : null;
  const hosted = HOSTED[slug] ? HOSTED_NOTES[HOSTED[slug]] : null;
  const openHref = `/tools/${slug}${tab ? `?tab=${encodeURIComponent(tab)}` : ""}`;

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 sm:py-10" data-showcase={slug}>
      <header className="mb-6">
        <p className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-accent">{t("About this tool")}</p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <h1 className="text-3xl font-semibold tracking-tight text-ink">{t(tool.name)}</h1>
          <KindBadge kind={tool.kind} />
          {tool.beta ? <BetaBadge /> : null}
        </div>
        <p className="mt-2 max-w-3xl text-[17px] leading-relaxed text-muted">{t(showcase.purpose)}</p>
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <ButtonLink href={openHref} variant="primary" size="lg">{t("Open the tool")}</ButtonLink>
          {guest ? <span className="text-sm text-faint">{t("You need an account to use it: the button takes you to sign in.")}</span> : null}
        </div>
      </header>

      {showcase.image ? (
        <figure className="mb-8 overflow-hidden rounded-2xl border border-line bg-surface shadow-card">
          {/* eslint-disable-next-line @next/next/no-img-element -- a static, already optimized webp; no image service */}
          <img src={showcase.image.src} width={1280} height={800} alt={t("{tool}: a screenshot of the page", { tool: t(tool.name) })} className="h-auto w-full" />
          {showcase.image.kind === "illustration" ? (
            <figcaption className="border-t border-line px-4 py-2 text-xs text-faint">{t("Illustration made from the real interface, not a live screenshot.")}</figcaption>
          ) : null}
        </figure>
      ) : null}

      <div className="grid gap-6 md:grid-cols-[3fr_2fr]">
        <section aria-labelledby="showcase-can">
          <h2 id="showcase-can" className="text-xl font-semibold text-ink">{t("What you can do")}</h2>
          <ul className="mt-3 list-disc space-y-2 pl-5 text-[15px] leading-relaxed text-muted">
            {showcase.points.map((point) => <li key={point}>{t(point)}</li>)}
          </ul>
          {showcase.apps ? (
            <>
              <h3 className="mt-6 text-base font-semibold text-ink">{t("The apps")}</h3>
              <ul className="mt-2 grid gap-x-6 gap-y-1 text-sm text-muted sm:grid-cols-2">
                {showcase.apps.map((app) => (
                  <li key={app.name}><span className="font-medium text-ink">{app.name}</span> · {t(app.what)}</li>
                ))}
              </ul>
            </>
          ) : null}
        </section>
        <div className="space-y-5">
          <section aria-labelledby="showcase-who" className="rounded-2xl border border-line bg-surface p-4">
            <h2 id="showcase-who" className="font-semibold text-ink">{t("Who it is for")}</h2>
            <p className="mt-1.5 text-sm leading-relaxed text-muted">{t(showcase.audience)}</p>
          </section>
          <section aria-labelledby="showcase-where" className="rounded-2xl border border-line bg-surface p-4">
            <h2 id="showcase-where" className="font-semibold text-ink">{t("Where it runs")}</h2>
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {showcase.runs.map((runs) => (
                <li key={runs} className="rounded-full border border-line-strong px-2.5 py-0.5 text-xs text-ink">{t(RUNS_LABEL[runs])}</li>
              ))}
            </ul>
            <p className="mt-2 text-sm leading-relaxed text-muted">{t(showcase.data)}</p>
          </section>
          <section aria-labelledby="showcase-ai" className="rounded-2xl border border-line bg-surface p-4">
            <h2 id="showcase-ai" className="font-semibold text-ink">{t("The AI assistant here")}</h2>
            <p className="mt-1.5 text-sm leading-relaxed text-muted">{t(showcase.assistant)}</p>
          </section>
        </div>
      </div>

      {hosted ? (
        <section aria-label={t("Whose software this is")} data-hosted-note={slug} className="mt-6 rounded-2xl border border-line bg-surface p-4">
          <h2 className="font-semibold text-ink">{t("Whose software this is")}</h2>
          <p className="mt-1.5 text-sm leading-relaxed text-muted">
            {t(hosted.text)}{" "}
            <a href={hosted.source} target="_blank" rel="noopener noreferrer" className="text-accent-soft underline underline-offset-2">{t("Source code")}</a>
          </p>
        </section>
      ) : null}

      <ShowcaseChoices slug={slug} />
    </main>
  );
}
