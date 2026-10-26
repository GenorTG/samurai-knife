"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n/react";

type View = { kind: "hidden" } | { kind: "anonymous" } | { kind: "user"; id: string };

/**
 * Top-bar account entry, public mode only (private mode renders nothing: the owner's shell stays as it was). Decided in the
 * browser from GET /api/account, never from server env at build time; renders nothing until it knows (no hydration diff).
 */
export function AccountLink() {
  const { t } = useT();
  const pathname = usePathname();
  const [view, setView] = useState<View>({ kind: "hidden" });

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const response = await fetch("/api/account", { cache: "no-store", credentials: "same-origin" });
        const body = (await response.json().catch(() => null)) as { id?: unknown; authMode?: unknown; mode?: unknown } | null;
        if (!alive) return;
        if (response.ok && body?.authMode === "public" && typeof body.id === "string") setView({ kind: "user", id: body.id });
        else if (response.status === 401 && body?.mode === "public") setView({ kind: "anonymous" });
        else setView({ kind: "hidden" });
      } catch {
        if (alive) setView({ kind: "hidden" });
      }
    })();
    return () => {
      alive = false;
    };
    // Re-checked after navigating to/from the account pages (login, logout, delete).
  }, [pathname]);

  if (view.kind === "hidden") return null;
  const className = "inline-flex h-9 max-w-40 shrink-0 items-center rounded-lg border border-line bg-surface px-3 text-sm text-muted shadow-xs transition-colors hover:border-line-strong hover:text-ink";
  return view.kind === "user" ? (
    <Link href="/account" className={className} title={t("Your account")}>
      <span className="truncate">{view.id}</span>
    </Link>
  ) : (
    <Link href={`/login?next=${encodeURIComponent(pathname || "/")}`} className={className}>
      {t("Log in")}
    </Link>
  );
}
