import { KindBadge } from "@/components/ToolShell";
import { Greeter } from "@/components/Greeter";
import { Launcher } from "@/components/Launcher";
import { isGuest } from "@/lib/accounts/viewer";
import { loadApp } from "@/lib/github-app/config";
import { TOOLS } from "@/lib/registry";
import { getT } from "@/lib/i18n/server";

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
      <header className="mb-7">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight text-ink sm:text-4xl">
              {t("A private room of hand-made tools.")}
            </h1>
            <p className="mt-3 max-w-xl text-[15px] leading-relaxed text-muted">
              {t("Small, sharp, single-purpose. Most run in your browser and keep files local. Favorites and recent history stay in this browser. PDFs use local Python; chat-widget messages go to the provider configured for your account.")}
            </p>
          </div>
          <div className="flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1.5 text-xs text-muted shadow-xs">
            <span className="font-mono tabular-nums">{TOOLS.length} {" "}{t("tools")}</span>
            <span aria-hidden>·</span>
            <KindBadge kind={serverCount > 0 ? "server" : "client"} />
            <span className="font-mono">{serverCount} {" "}{t("on server")}</span>
          </div>
        </div>
      </header>

      <Launcher tools={TOOLS} />

      <footer className="mt-14 border-t border-line pt-5 text-xs text-faint">
        <p>
          {t("Smart Knife · self-hosted")}
        </p>
      </footer>
    </main>
  );
}
