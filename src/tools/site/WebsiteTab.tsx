"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useState } from "react";
import { Badge, Button, CopyButton, Field, Notice, Panel, TextArea, TextInput } from "@/components/ui";
import { cx } from "@/lib/format";
import { msg } from "@/lib/i18n/msg";
import { useT } from "@/lib/i18n/react";
import { errorText, siteRequest } from "./client";
import ChangesTab from "./ChangesTab";
import ConnectTab from "./ConnectTab";
import CopyTab from "./CopyTab";
import ScoreTab from "./ScoreTab";
import { useSite } from "./useSite";


/** The steps of the Website tab; the ids are the old website studio's tabs (site-studio?tab=X lands on step X). */
const STEPS = [
  { id: "connect", label: msg("1. Your website") },
  { id: "score", label: msg("2. Check it") },
  { id: "copy", label: msg("3. Compare with your CV") },
  { id: "changes", label: msg("4. Improve it (optional)") },
] as const;
type StepId = (typeof STEPS)[number]["id"];

/**
 * CV studio, Website tab (optional; docs/WEBSITE-STUDIO.md): for people with their own website or portfolio. Add the
 * site (its address is enough for the CV check; its GitHub repository also lets the assistant prepare changes), check
 * it, compare it with this CV project, and optionally improve it through reviewed pull requests. Per CV project.
 */
export default function WebsiteTab() {
  const { t } = useT();
  const pathname = usePathname();
  const params = useSearchParams();
  const requested = params.get("step");
  const step: StepId = STEPS.some((s) => s.id === requested) ? (requested as StepId) : "connect";
  const go = (id: StepId) => {
    const next = new URLSearchParams(window.location.search);
    next.set("step", id);
    window.history.pushState(null, "", `${pathname}?${next.toString()}`);
  };
  return (
    <div className="space-y-4" data-cv-website>
      <Notice tone="info">{t("Optional: only if you have your own website or portfolio. It is checked against the CV project selected above.")}</Notice>
      <nav aria-label={t("Website steps")} className="flex flex-wrap gap-1.5">
        {STEPS.map((s) => (
          <button
            key={s.id}
            type="button"
            autoComplete="off"
            aria-current={s.id === step ? "step" : undefined}
            onClick={() => go(s.id)}
            className={cx(
              "rounded-lg border px-3 py-1.5 text-sm transition-colors",
              s.id === step ? "border-accent bg-accent/10 font-medium text-ink" : "border-line text-muted hover:border-line-strong hover:text-ink",
            )}
          >
            {t(s.label)}
          </button>
        ))}
      </nav>
      {step === "connect" ? <ConnectStep /> : null}
      {step === "score" ? <ScoreTab /> : null}
      {step === "copy" ? <CopyTab /> : null}
      {step === "changes" ? <ChangesTab /> : null}
    </div>
  );
}

function ConnectStep() {
  const { t } = useT();
  const { view } = useSite();
  const [way, setWay] = useState<"address" | "github" | null>(null);
  const shown = way ?? (view?.connected ? "github" : "address");
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <WayCard
          active={shown === "address"}
          onClick={() => setWay("address")}
          title={t("Just its address")}
          text={t("Enough to check the site and compare it with your CV. Nothing is changed on the site.")}
        />
        <WayCard
          active={shown === "github"}
          onClick={() => setWay("github")}
          title={t("Its GitHub repository")}
          text={t("Also lets the assistant prepare improvements as pull requests that you review and publish yourself.")}
        />
      </div>
      {shown === "address" ? <SiteAddress /> : <ConnectTab />}
    </div>
  );
}

function WayCard({ active, onClick, title, text }: { active: boolean; onClick: () => void; title: string; text: string }) {
  return (
    <button
      type="button"
      autoComplete="off"
      aria-pressed={active}
      onClick={onClick}
      className={cx(
        "rounded-lg border p-3 text-left transition-colors",
        active ? "border-accent bg-accent/10" : "border-line bg-surface hover:border-line-strong",
      )}
    >
      <span className="block text-sm font-semibold text-ink">{title}</span>
      <span className="mt-1 block text-[13px] text-muted">{text}</span>
    </button>
  );
}

/** A website without a repository: its address, extra pages, and (when this account needs it) the ownership proof. */
function SiteAddress() {
  const { t, m } = useT();
  const { view, reload } = useSite();
  const saved = view?.siteUrl ?? null;
  const [url, setUrl] = useState<string | null>(null);
  const [pages, setPages] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "good" | "error"; text: string } | null>(null);
  const urlValue = url ?? saved?.url ?? "";
  const pagesValue = pages ?? (saved ? saved.pages.filter((p) => p !== "/").join("\n") : "");

  const act = async (body: Record<string, unknown>, done: string) => {
    setBusy(true);
    setMessage(null);
    try {
      await siteRequest("POST", "/api/site", body);
      setMessage({ tone: "good", text: done });
      setUrl(null);
      setPages(null);
      await reload();
    } catch (e) {
      setMessage({ tone: "error", text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  if (view?.connected) {
    return <Notice tone="info">{t("This CV project's website is connected through its GitHub repository ({repo}); its production address is used for the checks.", { repo: view.connection?.repo ?? "" })}</Notice>;
  }
  const metaTag = saved ? `<meta name="smart-knife-verification" content="${saved.token}">` : "";
  return (
    <Panel title={t("Your website's address")}>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          void act({ action: "set-url", url: urlValue.trim(), pages: pagesValue.split(/\n|,/).map((p) => p.trim()).filter(Boolean) }, t("Saved. Next: check the site."));
        }}
      >
        <Field label={t("Address")}>
          <TextInput value={urlValue} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com" inputMode="url" autoComplete="off" spellCheck={false} />
        </Field>
        <Field label={t("More pages to check (optional)")} hint={t("One path per line, e.g. /about or /projects. The home page is always checked.")}>
          <TextArea value={pagesValue} onChange={(e) => setPages(e.target.value)} rows={3} spellCheck={false} />
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="primary" disabled={busy || !urlValue.trim()}>{t("Save address")}</Button>
          {saved ? <Button variant="ghost" disabled={busy} onClick={() => void act({ action: "clear-url" }, t("Address removed."))}>{t("Remove")}</Button> : null}
        </div>
      </form>
      {message ? <div className="mt-3"><Notice tone={message.tone}>{m(message.text)}</Notice></div> : null}
      {saved ? (
        <div className="mt-4 space-y-2 border-t border-line pt-3" data-site-proof>
          <p className="flex items-center gap-2 text-sm text-ink">
            {t("Ownership")}
            {saved.verified ? <Badge tone="good">{t("verified")}</Badge> : view?.proofNeeded ? <Badge tone="warn">{t("not verified yet")}</Badge> : <Badge tone="neutral">{t("not needed here")}</Badge>}
          </p>
          {!saved.verified && view?.proofNeeded ? (
            <>
              <p className="text-[13px] text-muted">{t("This server only checks sites their owners prove are theirs. Add this tag inside the <head> of your home page (or serve the code alone as /.well-known/smart-knife-verification.txt), publish the site, then press Verify.")}</p>
              <div className="flex items-start gap-2">
                <pre className="min-w-0 flex-1 overflow-x-auto rounded-md border border-line bg-surface px-2.5 py-1.5 font-mono text-xs text-ink">{metaTag}</pre>
                <CopyButton text={metaTag} />
              </div>
              <Button disabled={busy} onClick={() => void act({ action: "verify-url" }, t("Verified: you can check the site now."))}>{t("Verify")}</Button>
            </>
          ) : null}
        </div>
      ) : null}
    </Panel>
  );
}
