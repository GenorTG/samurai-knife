"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Badge, Button, Field, KeyValues, Notice, Panel, Select, TextInput } from "@/components/ui";
import { withProject } from "@/lib/cv/shown-project";
import { errorText, siteRequest, type VercelProjectView, type VercelView } from "./client";
import { useT } from "@/lib/i18n/react";
import { msg } from "@/lib/i18n/msg";

type Message = { tone: "good" | "error" | "warn"; text: string } | null;

const FLASH_ERRORS: Record<string, string> = {
  expired: msg("The Vercel sign-in expired or was opened in another browser: start again."),
  session_changed: msg("You signed in as someone else meanwhile: start again."),
  denied: msg("Vercel access was not granted."),
  not_configured: msg("Connect with Vercel is not set up on this server: use a token instead."),
};

/** The Vercel redirect's result in the URL (?vercel=connected / ?vercel_error=...): read after hydration. */
function useVercelFlash(): Message {
  const search = useSyncExternalStore(() => () => undefined, () => window.location.search, () => "");
  const p = new URLSearchParams(search);
  if (p.get("vercel") === "connected") return { tone: "good", text: msg("Vercel connected. Check the project below.") };
  const code = p.get("vercel_error");
  if (!code) return null;
  return { tone: "error", text: FLASH_ERRORS[code] ?? p.get("vercel_message") ?? msg("Vercel could not be connected.") };
}

/**
 * Optional Vercel link of the website (docs/WEBSITE-STUDIO.md "Vercel"): with it the assistant follows the previews of its
 * work branch, reads their build logs, starts a preview build and reads previews behind Deployment Protection.
 * Production is never deployed from here.
 */
export default function VercelPanel({ repo }: { repo: string }) {
  const { t } = useT();
  const flash = useVercelFlash();
  const [data, setData] = useState<{ vercel: VercelView | null; oauth: boolean; projects?: VercelProjectView[] } | null>(null);
  const [token, setToken] = useState("");
  const [team, setTeam] = useState("");
  const [bypass, setBypass] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await siteRequest<{ vercel: VercelView | null; oauth: boolean; projects?: VercelProjectView[] }>("GET", "/api/site/vercel?projects=1");
      setData(d);
      setTeam(d.vercel?.team ?? "");
    } catch (e) {
      setMessage({ tone: "error", text: errorText(e) });
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(() => void load(), 0);
    return () => clearTimeout(first);
  }, [load]);

  async function save(body: Record<string, unknown>, done: string) {
    setBusy(true);
    setMessage(null);
    try {
      const r = await siteRequest<{ vercel: VercelView | null; projects: VercelProjectView[]; project: VercelProjectView | null }>("PUT", "/api/site/vercel", body);
      setData((d) => ({ oauth: d?.oauth ?? false, vercel: r.vercel, projects: r.projects }));
      setToken("");
      setBypass("");
      setMessage(r.vercel?.projectId ? { tone: "good", text: done } : { tone: "warn", text: t("Connected, but no Vercel project deploys {repo}: pick it below (or check the team).", { repo }) });
    } catch (e) {
      setMessage({ tone: "error", text: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  async function post(action: "generate-bypass") {
    setBusy(true);
    setMessage(null);
    try {
      await siteRequest("POST", "/api/site/vercel", { action });
      await load();
      setMessage({ tone: "good", text: t("Bypass secret created and stored: the assistant can now read protected previews.") });
    } catch (e) {
      setMessage({ tone: "error", text: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    try {
      await siteRequest("DELETE", "/api/site/vercel");
      setConfirmDisconnect(false);
      await load();
      setMessage({ tone: "good", text: t("Vercel disconnected.") });
    } catch (e) {
      setMessage({ tone: "error", text: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  const v = data?.vercel ?? null;
  const projects = data?.projects ?? [];
  const chosen = projects.find((p) => p.id === v?.projectId) ?? null;
  const shown = flash ?? message;

  return (
    <Panel title={t("Vercel (optional)")}>
      <div className="space-y-4 text-sm">
        <p className="text-muted">
          {t("If the site is hosted on Vercel, connect it so the assistant can follow the preview of its work branch (build state, build log), start a preview build of that branch and check previews that sit behind Vercel's Deployment Protection. Production is never deployed from here: it changes only when you publish.")}
        </p>
        {!v ? (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void save({ token, team }, t("Vercel connected."));
            }}
          >
            {data?.oauth ? (
              <div className="flex flex-wrap items-center gap-2">
                <a className="inline-flex h-9 items-center rounded-lg bg-accent px-3 font-semibold text-accent-fg" href={withProject(`/api/vercel/start?returnTo=${encodeURIComponent("/tools/cv-studio?tab=website&step=connect")}`)}>
                  {t("Connect with Vercel")}
                </a>
                <span className="text-muted">{t("or use a token:")}</span>
              </div>
            ) : null}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t("Vercel token")} hint={t("Vercel → Account settings → Tokens, scoped to the team that owns the site. Stored encrypted, never shown again.")}>
                <TextInput type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={t("vercel token")} autoComplete="off" />
              </Field>
              <Field label={t("Team (optional)")} hint={t("Team id (team_…) or slug; empty = your personal account.")}>
                <TextInput value={team} onChange={(e) => setTeam(e.target.value)} placeholder={t("my-team")} autoComplete="off" spellCheck={false} />
              </Field>
            </div>
            <Button type="submit" variant="primary" disabled={busy || !token.trim()}>{t("Connect Vercel")}</Button>
          </form>
        ) : (
          <>
            <KeyValues
              rows={[
                [t("Connected with"), v.source === "oauth" ? t("Vercel integration ({hint})", { hint: v.hint }) : t("token {hint}", { hint: v.hint })],
                [t("Team"), v.team || t("personal account")],
                [t("Project"), chosen ? `${chosen.name}${chosen.repo ? ` (${chosen.repo})` : ""}` : v.projectName || t("none chosen")],
                [
                  t("Protected previews"),
                  chosen && !chosen.protectedPreviews ? (
                    <Badge key="p" tone="good">{t("not protected: readable")}</Badge>
                  ) : v.hasBypass ? (
                    <Badge key="p" tone="good">{t("bypass secret stored")}</Badge>
                  ) : (
                    <Badge key="p" tone="warn">{t("no bypass secret: protected previews cannot be read")}</Badge>
                  ),
                ],
              ]}
            />
            <Field label={t("Vercel project")} hint={t("The project that deploys {repo}.", { repo })}>
              <Select value={v.projectId} disabled={busy} onChange={(e) => void save({ projectId: e.target.value }, t("Project saved."))}>
                <option value="">{t("Choose…")}</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}{p.repo ? ` — ${p.repo}` : ""}</option>
                ))}
              </Select>
            </Field>
            {v.projectId && (!chosen || chosen.protectedPreviews) ? (
              <div className="flex flex-wrap items-end gap-2">
                <Button onClick={() => void post("generate-bypass")} disabled={busy}>{v.hasBypass ? t("Create a new bypass secret") : t("Create bypass secret")}</Button>
                <Field label={t("…or paste one")} hint={t("Project settings → Deployment Protection → Protection Bypass for Automation.")}>
                  <TextInput type="password" value={bypass} onChange={(e) => setBypass(e.target.value)} placeholder={t("bypass secret")} autoComplete="off" />
                </Field>
                <Button onClick={() => void save({ bypass }, t("Bypass secret saved."))} disabled={busy || !bypass.trim()}>{t("Save secret")}</Button>
              </div>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="ghost" onClick={() => void load()} disabled={busy}>{t("Refresh")}</Button>
              {!confirmDisconnect ? (
                <Button variant="ghost" onClick={() => setConfirmDisconnect(true)} disabled={busy}>{t("Disconnect Vercel…")}</Button>
              ) : (
                <>
                  <span className="text-muted">{t("Forget the Vercel token and settings?")}</span>
                  <Button variant="danger" onClick={() => void disconnect()} disabled={busy}>{t("Disconnect")}</Button>
                  <Button variant="ghost" onClick={() => setConfirmDisconnect(false)}>{t("Keep")}</Button>
                </>
              )}
            </div>
          </>
        )}
        {shown ? <Notice tone={shown.tone === "warn" ? "warn" : shown.tone}>{t(shown.text)}</Notice> : null}
      </div>
    </Panel>
  );
}
