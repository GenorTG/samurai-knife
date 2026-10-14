import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Not found" };

/** Themed 404: Next's built-in page is plain white and ignores the app's dark theme. Unknown tool slugs land here too. */
export default function NotFound() {
  return (
    <main className="w-full px-4 py-16 sm:px-6 xl:px-8">
      <div className="mx-auto max-w-xl text-center">
        <p className="font-mono text-sm tracking-widest text-faint">404</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-ink">This page could not be found</h1>
        <p className="mt-3 text-[15px] leading-relaxed text-muted">
          There is no tool or page at this address. Retired tool names redirect on their own; anything else is a typo or an old link.
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/"
            className="inline-flex h-9 items-center rounded-lg border border-line-strong bg-surface px-4 text-sm text-ink hover:bg-raised"
          >
            Back to all tools
          </Link>
          <span className="text-xs text-faint">
            or press <kbd className="sk-kbd">Ctrl</kbd> <kbd className="sk-kbd">K</kbd> to jump to a tool
          </span>
        </div>
      </div>
    </main>
  );
}
