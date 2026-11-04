import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CategoryIcon, categoryTint } from "@/components/category-icons";
import { SetCards } from "@/components/sets/SetCards";
import { ButtonLink } from "@/components/ui";
import { isGuest } from "@/lib/accounts/viewer";
import { getT } from "@/lib/i18n/server";
import { findToolSet, TOOL_SETS, TRADEMARK_NOTE } from "@/lib/toolsets";

/**
 * A tool set's page (docs/TOOLSETS.md). Public in both modes, like the tools' about pages: it reads only src/lib/toolsets.ts,
 * never an account; the tools it links to still need a session.
 */
export async function generateMetadata({ params }: PageProps<"/sets/[id]">): Promise<Metadata> {
  const set = findToolSet((await params).id);
  if (!set) return {};
  const { t } = await getT();
  return { title: t(set.headline), description: t(set.pitch), alternates: { canonical: `/sets/${set.id}` } };
}

// The frame (signed in or the public welcome frame) is decided per request.
export const dynamic = "force-dynamic";

export default async function SetPage({ params }: PageProps<"/sets/[id]">) {
  const { id } = await params;
  const set = findToolSet(id);
  if (!set) notFound();
  const { t } = await getT();
  const guest = await isGuest();
  const others = TOOL_SETS.filter((other) => other.id !== set.id).slice(0, 3).map((other) => other.id);

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 sm:py-10" data-set={set.id}>
      <header>
        <p className="flex items-center gap-2 text-sm font-medium text-muted">
          <span style={categoryTint(set.icon)}>
            <CategoryIcon category={set.icon} size={18} />
          </span>
          {t(set.name)}
        </p>
        <h1 className="mt-3 text-3xl font-semibold leading-tight tracking-tight text-ink sm:text-4xl">{t(set.headline)}</h1>
        <p className="mt-3 max-w-3xl text-[17px] leading-relaxed text-muted">{t(set.pitch)}</p>
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <ButtonLink href={set.start.href} variant="primary" size="lg">{t(set.start.label)}</ButtonLink>
          {guest ? <span className="text-sm text-faint">{t("Free. You only need an account: the button takes you to sign in or sign up.")}</span> : null}
        </div>
      </header>

      {set.replaces.length > 0 ? (
        <section aria-labelledby="set-replaces" className="mt-10">
          <h2 id="set-replaces" className="text-xl font-semibold text-ink">{t("What you can stop paying for")}</h2>
          <div className="mt-3 overflow-x-auto rounded-tool border border-line bg-surface shadow-card">
            <table className="w-full min-w-[32rem] text-left text-sm">
              <thead>
                <tr className="border-b border-line text-xs text-faint">
                  <th scope="col" className="px-4 py-2.5 font-medium">{t("Instead of")}</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">{t("Use here, free")}</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">{t("For")}</th>
                </tr>
              </thead>
              <tbody>
                {set.replaces.map((row) => (
                  <tr key={`${row.paid}-${row.what}`} className="border-b border-line last:border-0">
                    <td className="px-4 py-3 text-muted">{t(row.paid)}</td>
                    <td className="px-4 py-3">
                      <Link href={row.href} className="font-semibold text-accent-soft underline-offset-2 hover:underline">{t(row.ours)}</Link>
                    </td>
                    <td className="px-4 py-3 text-muted">{t(row.what)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <section aria-labelledby="set-tasks" className="mt-10">
        <h2 id="set-tasks" className="text-xl font-semibold text-ink">{t("What do you want to do?")}</h2>
        <ul className="mt-3 grid gap-3 sm:grid-cols-2">
          {set.tasks.map((task) => (
            <li key={task.label}>
              <Link href={task.href} className="flex h-full flex-col rounded-tool border border-line bg-surface p-4 shadow-card transition-colors hover:border-accent/50 hover:bg-raised/50 focus-visible:outline-2 focus-visible:outline-accent">
                <span className="text-[15px] font-semibold text-ink">{t(task.label)}</span>
                <span className="mt-1 text-[13px] leading-relaxed text-muted">{t(task.hint)}</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      {set.limits ? (
        <section aria-labelledby="set-limits" className="mt-10 rounded-tool border border-line bg-surface/60 p-4">
          <h2 id="set-limits" className="font-semibold text-ink">{t("Worth knowing")}</h2>
          <p className="mt-1.5 text-sm leading-relaxed text-muted">{t(set.limits)}</p>
        </section>
      ) : null}

      <section aria-labelledby="set-more" className="mt-12">
        <h2 id="set-more" className="text-xl font-semibold text-ink">{t("More sets")}</h2>
        <div className="mt-3">
          <SetCards only={others} />
        </div>
      </section>

      {set.replaces.length > 0 ? <p className="mt-8 text-xs leading-relaxed text-faint">{t(TRADEMARK_NOTE)}</p> : null}
    </main>
  );
}
