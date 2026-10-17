"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Badge, Button, EmptyState, Field, Notice, Panel, TextArea, TextInput } from "@/components/ui";
import { openAssistant } from "@/lib/agent-client/bridge";
import { errorText, siteRequest, when, type ChangesView } from "./client";
import { useSite } from "./useSite";

const POLL_MS = 15_000;
const CHECK_TONE: Record<string, "good" | "warn" | "danger" | "neutral"> = { success: "good", pending: "warn", failure: "danger", error: "danger", none: "neutral" };

/**
 * Changes tab: what the assistant (or you) prepared on the work branch, the pull request, checks and the preview, and the
 * two buttons no agent can press: Publish (merge into the production branch at exactly the reviewed head) and Discard.
 */
export default function ChangesTab() {
  const { view } = useSite();
  const [data, setData] = useState<ChangesView | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "good" | "error"; text: string } | null>(null);
  const [confirm, setConfirm] = useState<"publish" | "discard" | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const revision = view?.revision ?? -1;

  const load = useCallback(() => {
    return siteRequest<ChangesView>("GET", "/api/site/changes").then(
      (d) => {
        setData(d);
        setError("");
      },
      (e: unknown) => setError(errorText(e)),
    );
  }, []);

  // Reload on every store revision (a new commit or pull request) and every 15 s for checks and the preview build.
  const connected = view?.connected ?? false;
  useEffect(() => {
    if (!connected) return;
    const tick = () => {
      if (document.visibilityState === "visible") void load();
    };
    const first = setTimeout(tick, 0);
    const timer = setInterval(tick, POLL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [load, revision, connected]);

  async function act(payload: Record<string, unknown>, done: string) {
    setBusy(true);
    setNotice(null);
    try {
      await siteRequest("POST", "/api/site/changes", payload);
      setNotice({ tone: "good", text: done });
      setConfirm(null);
      setReviewed(false);
      await load();
    } catch (e) {
      setNotice({ tone: "error", text: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  async function auditPreview(url: string) {
    try {
      await siteRequest("POST", "/api/site/audit", { target: "preview", url });
      setNotice({ tone: "good", text: "Preview audit started: see the Score tab." });
    } catch (e) {
      setNotice({ tone: "error", text: errorText(e) });
    }
  }

  if (view && !view.connected) {
    return <EmptyState title="No repository connected" action={<Link className="text-accent underline" href="/tools/site-studio?tab=connect">Open Connect</Link>}>Changes are prepared on a branch of your website&apos;s repository.</EmptyState>;
  }
  const base = view?.connection?.baseBranch ?? "main";
  return (
    <div className="space-y-4">
      {error ? <Notice tone="error">{error}</Notice> : null}
      {notice ? <Notice tone={notice.tone}>{notice.text}</Notice> : null}
      {data?.lastAction ? <p className="text-xs text-faint">Last: {data.lastAction.kind} · {data.lastAction.detail} · {when(data.lastAction.at)}</p> : null}

      {!data ? (
        <p className="text-sm text-muted">Loading the changes…</p>
      ) : !data.work || !data.compare ? (
        <EmptyState
          title="No changes prepared"
          action={<Button onClick={() => openAssistant("Look at my latest website audit and my CV, then prepare the most valuable improvements to my website as a pull request.")}>Ask the assistant to prepare changes</Button>}
        >
          The assistant (or an agent over MCP) commits to a separate work branch; you review and publish here.
        </EmptyState>
      ) : (
        <>
          <Panel
            title={`Work branch ${data.work.branch} · ${data.compare.aheadBy} commit(s) ahead of ${base}${data.compare.behindBy ? `, ${data.compare.behindBy} behind` : ""}`}
            right={data.checks ? <Badge tone={CHECK_TONE[data.checks.state] ?? "neutral"}>checks: {data.checks.state}</Badge> : null}
          >
            <div className="space-y-3 text-sm">
              {data.pull ? (
                <p>
                  Pull request <a className="text-accent underline" href={data.pull.url} target="_blank" rel="noreferrer">#{data.pull.number} {data.pull.title}</a>
                  {data.pull.mergeable === false ? <Badge tone="danger" className="ml-2">conflicts</Badge> : null}
                </p>
              ) : (
                <form
                  className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void act({ action: "pr", title: title.trim() || "Website update", body }, "Pull request opened.");
                  }}
                >
                  <div className="space-y-2">
                    <Field label="Pull request title"><TextInput value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Website update" /></Field>
                    <Field label="Description"><TextArea rows={2} value={body} onChange={(e) => setBody(e.target.value)} placeholder="What changes and why" /></Field>
                  </div>
                  <Button type="submit" disabled={busy}>Open pull request</Button>
                </form>
              )}
              {data.checks?.previewUrl ? (
                <p className="flex flex-wrap items-center gap-2">
                  Preview: <a className="text-accent underline wrap-anywhere" href={data.checks.previewUrl} target="_blank" rel="noreferrer">{data.checks.previewUrl}</a>
                  <Button size="sm" onClick={() => void auditPreview(data.checks!.previewUrl)}>Score the preview</Button>
                </p>
              ) : (
                <p className="text-muted">No preview deployment yet{data.checks?.state === "pending" ? " (building…)" : ""}.</p>
              )}
              {data.checks?.items.length ? (
                <ul className="flex flex-wrap gap-1.5">
                  {data.checks.items.map((c, n) => (
                    <li key={`${c.name}-${n}`}><Badge tone={CHECK_TONE[c.state] ?? "neutral"} title={c.description}>{c.name}: {c.state}</Badge></li>
                  ))}
                </ul>
              ) : null}
            </div>
          </Panel>

          <Panel title="Commits">
            <ul className="space-y-1 text-sm">
              {data.compare.commits.map((c) => (
                <li key={c.sha} className="flex gap-2">
                  <a className="font-mono text-xs text-accent underline" href={c.url} target="_blank" rel="noreferrer">{c.sha.slice(0, 7)}</a>
                  <span className="text-ink">{c.message.split("\n")[0]}</span>
                  <span className="ml-auto font-mono text-xs text-faint">{when(c.date)}</span>
                </li>
              ))}
            </ul>
          </Panel>

          <Panel title={`Files (${data.compare.files.length})`}>
            <div className="space-y-3">
              {data.compare.files.map((f) => (
                <details key={f.path} open={data.compare!.files.length <= 3}>
                  <summary className="cursor-pointer text-sm">
                    <span className="font-mono text-ink">{f.path}</span> <Badge>{f.status}</Badge> <span className="text-good">+{f.additions}</span> <span className="text-danger">−{f.deletions}</span>
                  </summary>
                  <pre className="mt-2 max-h-96 overflow-auto rounded-lg border border-line bg-raised p-3 text-xs leading-relaxed">
                    {f.patch
                      ? f.patch.split("\n").map((line, n) => (
                          <div key={n} className={line.startsWith("+") ? "text-good" : line.startsWith("-") ? "text-danger" : line.startsWith("@@") ? "text-faint" : ""}>{line || " "}</div>
                        ))
                      : "(binary or too large to show)"}
                  </pre>
                </details>
              ))}
            </div>
          </Panel>

          <Panel title="Publish">
            {confirm === "publish" ? (
              <div className="space-y-3">
                <Notice tone="warn">
                  This merges {data.pull ? `pull request #${data.pull.number}` : "the work branch"} into <b>{base}</b>. Your host then deploys it to production.
                </Notice>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} /> I reviewed the files above (and the preview)
                </label>
                <div className="flex gap-2">
                  <Button variant="primary" disabled={!reviewed || busy} onClick={() => void act({ action: "publish", head: data.work!.head }, `Published to ${base}.`)}>Publish to production</Button>
                  <Button variant="ghost" onClick={() => setConfirm(null)}>Not yet</Button>
                </div>
              </div>
            ) : confirm === "discard" ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm text-muted">Close the pull request and delete the work branch? The prepared changes are gone.</span>
                <Button variant="danger" disabled={busy} onClick={() => void act({ action: "discard" }, "Changes discarded.")}>Discard changes</Button>
                <Button variant="ghost" onClick={() => setConfirm(null)}>Keep them</Button>
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                <Button variant="primary" disabled={busy || data.pull?.mergeable === false} onClick={() => setConfirm("publish")}>Publish to production…</Button>
                <Button variant="ghost" disabled={busy} onClick={() => setConfirm("discard")}>Discard…</Button>
              </div>
            )}
          </Panel>
        </>
      )}
    </div>
  );
}
