import { cookies } from "next/headers";
import { KindBadge } from "@/components/ToolShell";
import { Greeter } from "@/components/Greeter";
import { Launcher } from "@/components/Launcher";
import { isPublicMode } from "@/lib/accounts/mode";
import { accountForSessionToken, SESSION_COOKIE } from "@/lib/accounts/session";
import { loadApp } from "@/lib/github-app/config";
import { TOOLS } from "@/lib/registry";

// Signed in or not is decided per request (public mode); a prerendered page would show one answer to everybody.
export const dynamic = "force-dynamic";

export default async function Home() {
  const serverCount = TOOLS.filter((tool) => tool.kind === "server").length;
  const signedOut = isPublicMode() && !accountForSessionToken((await cookies()).get(SESSION_COOKIE)?.value);

  if (signedOut) {
    return (
      <main className="w-full px-4 py-6 sm:px-6 sm:py-10 xl:px-8">
        <Greeter github={!!loadApp()} />
        <section id="tools" aria-labelledby="tools-title" className="mx-auto mt-16 w-full max-w-6xl scroll-mt-20 border-t border-line pt-10 sm:mt-20">
          <h2 id="tools-title" className="text-2xl font-semibold tracking-tight text-ink">
            Try the tools
          </h2>
          <p className="mt-2 mb-6 max-w-xl text-[15px] text-muted">
            Browser tools work without an account. Tools marked server or sidecar ask you to log in first.
          </p>
          <Launcher tools={TOOLS} />
        </section>
        <footer className="mx-auto mt-14 w-full max-w-6xl border-t border-line pt-5 text-xs text-faint">
          <p>Smart Knife · self-hosted</p>
        </footer>
      </main>
    );
  }

  return (
    <main className="w-full px-4 py-6 sm:px-6 sm:py-10 xl:px-8">
      <header className="mb-7">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight text-ink sm:text-4xl">
              A private room of hand-made tools.
            </h1>
            <p className="mt-3 max-w-xl text-[15px] leading-relaxed text-muted">
              Small, sharp, single-purpose. Most run in your browser and keep
              files local. Favorites and recent history stay in this browser.
              PDFs use local Python; chat-widget messages go to the provider
              configured for your account.
            </p>
          </div>
          <div className="flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1.5 text-xs text-muted shadow-xs">
            <span className="font-mono tabular-nums">{TOOLS.length} tools</span>
            <span aria-hidden>·</span>
            <KindBadge kind={serverCount > 0 ? "server" : "client"} />
            <span className="font-mono">{serverCount} on server</span>
          </div>
        </div>
      </header>

      <Launcher tools={TOOLS} />

      <footer className="mt-14 border-t border-line pt-5 text-xs text-faint">
        <p>
          Smart Knife · self-hosted
        </p>
      </footer>
    </main>
  );
}
