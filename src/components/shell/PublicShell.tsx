import Link from "next/link";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Brand } from "@/components/ToolShell";
import { ButtonLink } from "@/components/ui";

const linkClass =
  "inline-flex h-9 shrink-0 items-center rounded-lg px-3 text-sm text-muted transition-colors hover:text-ink";

/**
 * Frame for a signed-out visitor on the public server: the welcome page and the auth pages only. No tool sidebar, palette,
 * assistant or UI bridge (none of them work without a session, and the bridge would poll 401s forever). Server-rendered.
 */
export function PublicShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sk-glass sticky top-0 z-40 flex h-14 shrink-0 items-center gap-3 border-b border-line px-4 sm:px-6">
        <Brand />
        <nav aria-label="Account" className="ml-auto flex items-center gap-1 sm:gap-2">
          <Link href="/login" className={linkClass}>
            Log in
          </Link>
          <ButtonLink href="/register" variant="primary">
            Create account
          </ButtonLink>
          <ThemeToggle />
        </nav>
      </header>
      <div className="min-w-0 flex-1">{children}</div>
      <footer className="border-t border-line px-4 py-6 text-xs text-faint sm:px-6">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-3">
          <p>Smart Knife · self-hosted · no ads, no tracking</p>
          <nav aria-label="Footer" className="flex flex-wrap gap-4">
            <Link href="/" className="hover:text-ink">Home</Link>
            <Link href="/login" className="hover:text-ink">Log in</Link>
            <Link href="/register" className="hover:text-ink">Create account</Link>
            <Link href="/forgot-password" className="hover:text-ink">Forgot password</Link>
            <Link href="/terms" className="hover:text-ink">Terms</Link>
            <Link href="/privacy" className="hover:text-ink">Privacy</Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
