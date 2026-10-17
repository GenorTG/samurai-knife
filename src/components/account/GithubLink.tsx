"use client";

import { useEffect, useState } from "react";
import { Badge, Button, Notice, Panel } from "@/components/ui";
import type { PublicAccount } from "@/lib/accounts/store";
import { call } from "./api";

/** Account settings: link or unlink the GitHub identity ("Sign in with GitHub", website studio repositories). */
export function GithubLink({ account, onChanged }: { account: PublicAccount; onChanged: () => void }) {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch("/api/site/github", { credentials: "same-origin", cache: "no-store" })
      .then((r) => r.json().catch(() => null))
      .then((body: { app?: unknown } | null) => alive && setAvailable(!!body?.app))
      .catch(() => alive && setAvailable(false));
    return () => {
      alive = false;
    };
  }, []);

  if (!available) return null;
  const publicMode = account.authMode === "public";

  async function unlink() {
    setBusy(true);
    setError("");
    const reply = await call("POST", "/api/account/github", { action: "unlink" });
    setBusy(false);
    if (reply.ok) onChanged();
    else setError(reply.message);
  }

  return (
    <Panel title="GitHub" right={account.github ? <Badge tone="good">@{account.github}</Badge> : null}>
      <div className="space-y-3">
        {account.github ? (
          <>
            <p className="text-sm text-muted">
              Linked to GitHub user <b>@{account.github}</b>{publicMode ? ": you can sign in with GitHub" : ""}. The website studio uses the app installations this GitHub user can reach.
            </p>
            <div className="flex flex-wrap gap-2">
              <a className="inline-flex h-9 items-center rounded-lg border border-line-strong px-3 text-sm text-ink hover:bg-raised" href="/api/github/start?purpose=link&returnTo=%2Faccount">Refresh from GitHub</a>
              <Button variant="ghost" disabled={busy} onClick={() => void unlink()}>Unlink GitHub</Button>
            </div>
          </>
        ) : (
          <>
            <p className="text-sm text-muted">Link your GitHub user to {publicMode ? "sign in with GitHub and " : ""}connect your website&apos;s repository in the website studio without a token.</p>
            <a className="inline-flex h-9 items-center rounded-lg border border-line-strong bg-surface px-3 text-sm font-semibold text-ink hover:bg-raised" href="/api/github/start?purpose=link&returnTo=%2Faccount">Link GitHub</a>
          </>
        )}
        {error ? <Notice tone="error">{error}</Notice> : null}
      </div>
    </Panel>
  );
}
