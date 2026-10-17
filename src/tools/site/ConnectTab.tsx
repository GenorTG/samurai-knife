"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Badge, Button, Field, KeyValues, Notice, Panel, SegmentedControl, TextArea, TextInput } from "@/components/ui";
import { useIsAdmin } from "@/lib/use-is-admin";
import { errorText, siteRequest, when } from "./client";
import { useSite } from "./useSite";

interface StatusView {
  repo: { fullName: string; defaultBranch: string; private: boolean; canPush: boolean; htmlUrl: string; pushedAt: string } | null;
  ref?: string;
  instructions: { path: string; text: string }[];
}

/** Connect tab: GitHub repository + token, production URL, audited pages, optional PageSpeed key. */
export default function ConnectTab() {
  const { view, error, reload } = useSite();
  const c = view?.connection ?? null;
  // The form starts from the stored connection; when it changes (saved here, in another tab or by an agent) the form
  // starts over from the new values.
  const stamp = c ? `${c.repo}|${c.baseBranch}|${c.productionUrl}|${c.pages.join(",")}|${c.token.source}` : "";
  // Kept here: saving the first connection changes the stamp, and the message must survive the form starting over.
  const [message, setMessage] = useState<Message>(null);
  return <ConnectForm key={stamp} view={view} error={error} reload={reload} stamp={stamp} message={message} setMessage={setMessage} />;
}

type Message = { tone: "good" | "error" | "warn"; text: string } | null;

function ConnectForm({ view, error, reload, stamp, message, setMessage }: { view: ReturnType<typeof useSite>["view"]; error: string; reload: () => Promise<void>; stamp: string; message: Message; setMessage: (m: Message) => void }) {
  const admin = useIsAdmin();
  const c = view?.connection ?? null;
  const [repo, setRepo] = useState(c?.repo ?? "");
  const [source, setSource] = useState<"pat" | "host-gh">(c?.token.source ?? "pat");
  const [token, setToken] = useState("");
  const [baseBranch, setBaseBranch] = useState(c?.baseBranch ?? "");
  const [productionUrl, setProductionUrl] = useState(c?.productionUrl ?? "");
  const [pages, setPages] = useState(c ? c.pages.filter((p) => p !== "/").join("\n") : "");
  const [psiKey, setPsiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<StatusView | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  useEffect(() => {
    if (!stamp) return;
    let alive = true;
    siteRequest<StatusView>("GET", "/api/site/status")
      .then((s) => alive && setStatus(s))
      .catch((e) => alive && setMessage({ tone: "error", text: errorText(e) }));
    return () => {
      alive = false;
    };
  }, [stamp, setMessage]);

  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await siteRequest<{ warning: string }>("PUT", "/api/site", {
        repo: repo.trim(),
        tokenSource: source,
        ...(source === "pat" && token.trim() ? { token: token.trim() } : {}),
        ...(baseBranch.trim() ? { baseBranch: baseBranch.trim() } : {}),
        productionUrl: productionUrl.trim(),
        pages: pages.split(/\n|,/).map((p) => p.trim()).filter(Boolean),
        ...(psiKey.trim() ? { psiKey: psiKey.trim() } : {}),
      });
      setToken("");
      setPsiKey("");
      setMessage(res.warning ? { tone: "warn", text: `Connected, but ${res.warning}.` } : { tone: "good", text: c ? "Settings saved." : "Connected. Next: run an audit in the Score tab." });
      await reload();
    } catch (e) {
      setMessage({ tone: "error", text: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    try {
      await siteRequest("DELETE", "/api/site");
      setConfirmDisconnect(false);
      setMessage({ tone: "good", text: "Disconnected: the token and settings are gone (audits stay)." });
      await reload();
    } catch (e) {
      setMessage({ tone: "error", text: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Panel title={c ? "Repository connection" : "Connect your website's repository"} right={c ? <Badge tone="good">connected</Badge> : null}>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="GitHub repository" hint="owner/name, e.g. GenorTG/my-website">
              <TextInput value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="owner/name" required autoComplete="off" spellCheck={false} />
            </Field>
            <Field label="Production URL" hint="The live site that gets audited (default: the repo's homepage).">
              <TextInput value={productionUrl} onChange={(e) => setProductionUrl(e.target.value)} placeholder="https://www.example.com" inputMode="url" autoComplete="off" />
            </Field>
          </div>
          {admin ? (
            <SegmentedControl
              label="GitHub access"
              value={source}
              onChange={setSource}
              options={[
                { value: "pat", label: "My token" },
                { value: "host-gh", label: "Server's gh login" },
              ]}
            />
          ) : null}
          {source === "pat" ? (
            <Field
              label="GitHub token"
              hint={c?.token.source === "pat" ? `Stored (${c.token.hint}, ${c.token.login}). Leave empty to keep it.` : "Fine-grained token for this repository: Contents and Pull requests read & write (Commit statuses / Deployments read for previews)."}
            >
              <TextInput type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={c?.token.source === "pat" ? "unchanged" : "github_pat_…"} autoComplete="off" />
            </Field>
          ) : (
            <Notice tone="info">Uses this server&apos;s own <code>gh</code> login (administrators only). Nothing is stored.</Notice>
          )}
          <details className="text-sm text-muted">
            <summary className="cursor-pointer text-ink">More settings</summary>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <Field label="Base branch" hint="Where published changes go (default: the repository's default branch).">
                <TextInput value={baseBranch} onChange={(e) => setBaseBranch(e.target.value)} placeholder="main" autoComplete="off" spellCheck={false} />
              </Field>
              <Field label="PageSpeed API key (optional)" hint={c?.hasPsiKey ? "Stored. Leave empty to keep it." : "Without one Google's small anonymous quota applies."}>
                <TextInput type="password" value={psiKey} onChange={(e) => setPsiKey(e.target.value)} placeholder={c?.hasPsiKey ? "unchanged" : "AIza…"} autoComplete="off" />
              </Field>
              <Field label="More pages to audit" hint="One path per line (the home page is always audited), at most 9.">
                <TextArea rows={3} value={pages} onChange={(e) => setPages(e.target.value)} placeholder={"/about\n/projects"} spellCheck={false} />
              </Field>
            </div>
          </details>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" variant="primary" disabled={busy || !repo.trim()}>{c ? "Save settings" : "Connect"}</Button>
            {c && !confirmDisconnect ? <Button variant="ghost" onClick={() => setConfirmDisconnect(true)} disabled={busy}>Disconnect…</Button> : null}
            {confirmDisconnect ? (
              <>
                <span className="text-sm text-muted">Forget the token and settings?</span>
                <Button variant="danger" onClick={() => void disconnect()} disabled={busy}>Disconnect</Button>
                <Button variant="ghost" onClick={() => setConfirmDisconnect(false)}>Keep</Button>
              </>
            ) : null}
          </div>
          {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
        </form>
      </Panel>

      {!c ? (
        <Panel title="How it works">
          <ol className="list-decimal space-y-1.5 pl-5 text-sm text-muted">
            <li>Create a fine-grained token on GitHub (Settings → Developer settings → Fine-grained tokens) for just this repository, with <b>Contents</b> and <b>Pull requests</b> set to read and write. It is stored encrypted and never shown again.</li>
            <li>Score the site (Score tab): SEO, copywriting, fit with your CV, Lighthouse.</li>
            <li>Ask the assistant (or your own agent over MCP) to improve it: changes land on a separate branch as a pull request, with a preview build when your host makes one (Vercel does).</li>
            <li>Review the diff and the preview score, then publish from the Changes tab. Nothing reaches production without you.</li>
          </ol>
        </Panel>
      ) : null}

      {c && status?.repo ? (
        <Panel title="Repository">
          <KeyValues
            rows={[
              ["Repository", <a key="r" className="text-accent underline" href={status.repo.htmlUrl} target="_blank" rel="noreferrer">{status.repo.fullName}</a>],
              ["Access", status.repo.canPush ? <Badge key="a" tone="good">read and write</Badge> : <Badge key="a" tone="warn">read only: changes will be refused</Badge>],
              ["Base branch", c.baseBranch],
              ["Work branch", view?.work ? `${view.work.branch}${view.work.pull ? ` (pull request #${view.work.pull})` : ""}` : "none yet (created on the first change)"],
              ["Instructions for agents", status.instructions.length ? status.instructions.map((i) => i.path).join(", ") : "none (add an AGENTS.md to tell agents how the site is built)"],
              ["Last push", when(status.repo.pushedAt)],
            ]}
          />
          <p className="mt-3 text-sm text-muted">
            Next: <Link className="text-accent underline" href="/tools/site-studio?tab=score">score the site</Link>, then ask the assistant, for example: “Make my website match my CV and add my newest projects”.
          </p>
        </Panel>
      ) : null}
    </div>
  );
}
