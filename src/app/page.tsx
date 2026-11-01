import { KindBadge } from "@/components/ToolShell";
import { Greeter } from "@/components/Greeter";
import { Launcher } from "@/components/Launcher";
import { isGuest } from "@/lib/accounts/viewer";
import { loadApp } from "@/lib/github-app/config";
import { TOOLS } from "@/lib/registry";
import { getT } from "@/lib/i18n/server";
import { msg } from "@/lib/i18n/msg";
import Link from "next/link";

// Signed in or not is decided per request (public mode); a prerendered page would show one answer to everybody.
export const dynamic = "force-dynamic";

export default async function Home() {
  const { t } = await getT();
  const serverCount = TOOLS.filter((tool) => tool.kind === "server").length;

  // Public mode, no session: the welcome page (the public frame has its own header and footer). Every tool needs an account.
  if (await isGuest()) {
    return (
      <main className="w-full px-4 py-6 sm:px-6 sm:py-10 xl:px-8">
        <Greeter github={!!loadApp()} />
      </main>
    );
  }

  return (
    <main className="w-full px-4 py-6 sm:px-6 sm:py-10 xl:px-8">
      <header className="mb-10 rounded-3xl border border-line bg-gradient-to-br from-surface via-surface to-raised p-6 shadow-card sm:p-9">
        <div className="flex flex-wrap items-end justify-between gap-5">
          <div className="max-w-3xl">
            <p className="mb-3 text-xs font-semibold uppercase tracking-[0.16em] text-accent">{t("Private tools. Practical AI. One workspace.")}</p>
            <h1 className="text-3xl font-semibold tracking-tight text-ink sm:text-5xl">
              {t("Smart Knife brings your work tools and AI together.")}
            </h1>
            <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-muted">
              {t("Work across documents, websites, data and creative projects—with an assistant that can use the tools you already have here.")}
            </p>
            <Link href="/tools/cv-studio" className="mt-5 inline-flex h-11 items-center rounded-xl bg-accent px-5 text-sm font-semibold text-white shadow-sm transition hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
              {t("Explore the studios")}
            </Link>
          </div>
          <div className="flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1.5 text-xs text-muted shadow-xs">
            <span className="font-mono tabular-nums">{TOOLS.length} {" "}{t("tools")}</span>
            <span aria-hidden>·</span>
            <KindBadge kind={serverCount > 0 ? "server" : "client"} />
            <span className="font-mono">{serverCount} {" "}{t("on server")}</span>
          </div>
        </div>
      </header>

      <section aria-labelledby="best-features" className="mb-12">
        <div className="mb-4">
          <h2 id="best-features" className="text-xl font-semibold tracking-tight text-ink">{t("Best features")}</h2>
          <p className="mt-1 text-sm text-muted">{t("Focused workspaces for the jobs people come here to do.")}</p>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {[
            [msg("AI assistant"), msg("An assistant that can act across the tools, keep several chats and turn requests into trackable tasks."), "/tools/mcp-connect"],
            [msg("CV studio"), msg("Create per-job CV versions, check ATS readiness and track each application."), "/tools/cv-studio"],
            [msg("Website studio"), msg("Audit a site, open GitHub pull requests, inspect Vercel previews and review screenshots."), "/tools/cv-studio?tab=website"],
            [msg("Office documents"), msg("Create and edit Word, Excel and PowerPoint files in your private workspace."), "/tools/office"],
            [msg("Workflows"), msg("Connect services and automate repeatable work with visual workflows."), "/tools/workflows"],
            [msg("Craft apps"), msg("Make and edit creative assets in a collection of browser-based apps."), "/tools/artcraft"],
            [msg("MCP for outside agents"), msg("Give external agents personal tokens to work with your account's tools."), "/tools/mcp-connect"],
            [msg("Database and SQL labs"), msg("Format, validate and run SQL, then learn against a real database."), "/tools/sql-lab"],
            [msg("PDF and OCR"), msg("Inspect, convert and extract text from PDFs with local processing where available."), "/tools/pdf"],
          ].map(([title, description, href]) => (
            <Link key={title} href={href} className="group rounded-2xl border border-line bg-surface p-4 shadow-xs transition hover:-translate-y-0.5 hover:border-accent/50 hover:shadow-card focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
              <h3 className="font-semibold text-ink group-hover:text-accent">{t(title)}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-muted">{t(description)}</p>
            </Link>
          ))}
        </div>
      </section>

      <section aria-labelledby="all-tools" className="mb-5">
        <h2 id="all-tools" className="text-xl font-semibold tracking-tight text-ink">{t("All tools")}</h2>
        <p className="mt-1 text-sm text-muted">{t("Flagship workspaces first, quick utilities after. Search or filter the full collection.")}</p>
      </section>

      <Launcher tools={TOOLS} />

      <footer className="mt-14 border-t border-line pt-5 text-xs text-faint">
        <p>
          {t("Smart Knife · self-hosted")}
        </p>
      </footer>
    </main>
  );
}
