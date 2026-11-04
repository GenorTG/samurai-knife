import Link from "next/link";
import { redirect } from "next/navigation";
import { Greeter } from "@/components/Greeter";
import { Launcher } from "@/components/Launcher";
import { SetCards, TopTasks } from "@/components/sets/SetCards";
import { isGuest, sessionAccount } from "@/lib/accounts/viewer";
import { loadApp } from "@/lib/github-app/config";
import { getT } from "@/lib/i18n/server";
import { TOOLS } from "@/lib/registry";

// Signed in or not is decided per request (public mode); a prerendered page would show one answer to everybody.
export const dynamic = "force-dynamic";

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

      <section aria-labelledby="home-all" className="mt-10">
        <h2 id="home-all" className="mb-3 text-xl font-semibold tracking-tight text-ink">{t("All tools")}</h2>
        <Launcher tools={tools} />
      </section>

      <footer className="mt-14 border-t border-line pt-5 text-xs text-faint">
        <p>{t("Smart Knife · free · no ads, no tracking")}</p>
      </footer>
    </main>
  );
}
