import Link from "next/link";
import { redirect } from "next/navigation";
import { Greeter } from "@/components/Greeter";
import { Launcher } from "@/components/Launcher";
import { SetCards, TopTasks } from "@/components/sets/SetCards";
import { ToolEntryLink } from "@/components/showcase/ShowcaseLinks";
import { isGuest, sessionAccount } from "@/lib/accounts/viewer";
import { loadApp } from "@/lib/github-app/config";
import { getT } from "@/lib/i18n/server";
import { msg } from "@/lib/i18n/msg";
import { TOOLS } from "@/lib/registry";

// Signed in or not is decided per request (public mode); a prerendered page would show one answer to everybody.
export const dynamic = "force-dynamic";

/** What no tool set shows on its own. Cards open the tool's about page first (docs/SHOWCASE.md). */
const ALSO_HERE: { title: string; text: string; slug: string; tab?: string }[] = [
  { title: msg("AI assistant"), text: msg("Optional: an assistant that works in the tools with you, on the AI model you choose. It can keep several chats and lists of tasks."), slug: "mcp-connect" },
  { title: msg("Your website and your CV"), text: msg("Check your own website, compare it with your CV and prepare fixes for you to review."), slug: "cv-studio", tab: "website" },
];

export default async function Home() {
  // Public mode, no session: the welcome page (the public frame has its own header and footer). Every tool needs an account.
  if (await isGuest()) {
    return (
      <main className="w-full px-4 py-6 sm:px-6 sm:py-10 xl:px-8">
        <Greeter github={!!loadApp()} />
      </main>
    );
  }

  // A brand-new account starts with the welcome wizard, once. Only here: a link to a tool is never interrupted.
  const account = await sessionAccount();
  if (account?.needsWelcome) redirect("/welcome");
  // Administrators' pages stay out of everyone else's list.
  const tools = account?.role === "user" ? TOOLS.filter((tool) => tool.category !== "sidecars") : TOOLS;

  const { t } = await getT();
  return (
    <main className="w-full px-4 py-6 sm:px-6 sm:py-10 xl:px-8">
      <header className="mb-6">
        <h1 className="text-3xl font-semibold tracking-tight text-ink sm:text-4xl">{t("What do you want to do today?")}</h1>
        <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-muted">
          {t("Everything here is free and works in your browser, with nothing to install. Pick a job below, or search for anything further down.")}{" "}
          <Link href="/welcome" className="text-accent-soft underline underline-offset-2">{t("Show me around")}</Link>
        </p>
      </header>

      <TopTasks />

      <section aria-labelledby="home-sets" className="mt-10">
        <h2 id="home-sets" className="mb-3 text-xl font-semibold tracking-tight text-ink">{t("Tool sets")}</h2>
        <SetCards />
      </section>

      <section aria-labelledby="home-also" className="mt-10">
        <h2 id="home-also" className="mb-3 text-xl font-semibold tracking-tight text-ink">{t("Also here")}</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          {ALSO_HERE.map((item) => (
            <ToolEntryLink key={item.title} slug={item.slug} tab={item.tab} className="rounded-tool border border-line bg-surface p-4 shadow-card transition-colors hover:border-accent/50 hover:bg-raised/40">
              <h3 className="text-[15px] font-semibold text-ink">{t(item.title)}</h3>
              <p className="mt-1 text-[13px] leading-relaxed text-muted">{t(item.text)}</p>
            </ToolEntryLink>
          ))}
        </div>
      </section>

      <section aria-labelledby="all-tools" className="mt-10">
        <h2 id="all-tools" className="mb-3 text-xl font-semibold tracking-tight text-ink">{t("All tools")}</h2>
        <Launcher tools={tools} />
      </section>

      <footer className="mt-14 border-t border-line pt-5 text-xs text-faint">
        <p>{t("Smart Knife · free · no ads, no tracking")}</p>
      </footer>
    </main>
  );
}
