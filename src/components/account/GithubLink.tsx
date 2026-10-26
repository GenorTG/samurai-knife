"use client";

import { useEffect, useState } from "react";
import { Badge, Button, Notice, Panel } from "@/components/ui";
import type { PublicAccount } from "@/lib/accounts/store";
import { call } from "./api";
import { useT } from "@/lib/i18n/react";

/** Account settings: link or unlink the GitHub identity ("Sign in with GitHub", website studio repositories). */
export function GithubLink({ account, onChanged }: { account: PublicAccount; onChanged: () => void }) {
  const { t } = useT();
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
    <Panel title={t("GitHub")} right={account.github ? <Badge tone="good">@{account.github}</Badge> : null}>
      <div className="space-y-3">
        {account.github ? (
          <>
            <p className="text-sm text-muted">
              {t("Linked to GitHub user")}{" "} <b>@{account.github}</b>{publicMode ? t(": you can sign in with GitHub") : ""}{t(". The website studio uses the app installations this GitHub user can reach.")}
            </p>
            <div className="flex flex-wrap gap-2">
              <a className="inline-flex h-9 items-center rounded-lg border border-line-strong px-3 text-sm text-ink hover:bg-raised" href="/api/github/start?purpose=link&returnTo=%2Faccount">{t("Refresh from GitHub")}</a>
              <Button variant="ghost" disabled={busy} onClick={() => void unlink()}>{t("Unlink GitHub")}</Button>
            </div>
          </>
        ) : (
          <>
            <p className="text-sm text-muted">{t("Link your GitHub user to")}{" "} {publicMode ? t("sign in with GitHub and ") : ""}{t("connect your website's repository in the website studio without a token.")}</p>
            <a className="inline-flex h-9 items-center rounded-lg border border-line-strong bg-surface px-3 text-sm font-semibold text-ink hover:bg-raised" href="/api/github/start?purpose=link&returnTo=%2Faccount">{t("Link GitHub")}</a>
          </>
        )}
        {error ? <Notice tone="error">{error}</Notice> : null}
      </div>
    </Panel>
  );
}
