"use client";

import { useEffect, useState } from "react";
import { Badge, Button, Field, KeyValues, Notice, Panel, TextInput } from "@/components/ui";
import { githubErrorText } from "./GithubButton";

interface AppStatusView {
  configured: boolean;
  appId?: number;
  slug?: string;
  name?: string;
  owner?: string;
  htmlUrl?: string;
  installUrl?: string;
  settingsUrl?: string;
  createdAt?: string;
  callbackUrls: string[];
  setupUrl: string;
}

async function call<T>(method: string, body?: unknown): Promise<T> {
  const res = await fetch("/api/admin/github-app", { method, credentials: "same-origin", headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  const json = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok) throw new Error(json?.error ?? `Request failed (${res.status}).`);
  return json as T;
}

/**
 * Users page: the server's GitHub App (docs/GITHUB.md). Not there yet: one click sends GitHub a manifest with the
 * permissions and callback URLs; the admin confirms on github.com and comes back with the app created.
 */
export function GithubAppAdmin({ created, errorCode, errorMessage }: { created?: boolean; errorCode?: string; errorMessage?: string }) {
  const [status, setStatus] = useState<AppStatusView | null>(null);
  const [error, setError] = useState("");
  const [name, setName] = useState("Samurai Knife");
  const [org, setOrg] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  // From the page's search params (server-rendered the same on both sides: no hydration difference).
  const flashError = githubErrorText(errorCode, errorMessage);
  const flash = created ? { tone: "good" as const, text: "GitHub App created. Install it on your repositories from the website studio (Connect)." } : flashError ? { tone: "error" as const, text: flashError } : null;

  useEffect(() => {
    let alive = true;
    call<AppStatusView>("GET").then((s) => alive && setStatus(s), (e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, []);

  async function create() {
    setBusy(true);
    setError("");
    try {
      const { postUrl, manifest } = await call<{ postUrl: string; manifest: string }>("POST", { name: name.trim() || undefined, org: org.trim() || undefined });
      // GitHub's manifest flow: a top-level form POST to github.com with the manifest as one field.
      const form = document.createElement("form");
      form.method = "post";
      form.action = postUrl;
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = "manifest";
      input.value = manifest;
      form.appendChild(input);
      document.body.appendChild(form);
      form.submit();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await call("DELETE");
      setStatus(await call<AppStatusView>("GET"));
      setConfirmRemove(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="GitHub App" right={status?.configured ? <Badge tone="good">ready</Badge> : status ? <Badge>not set up</Badge> : null}>
      <div id="github-app" className="space-y-3">
        {flash ? <Notice tone={flash.tone}>{flash.text}</Notice> : null}
        {error ? <Notice tone="error">{error}</Notice> : null}
        {!status ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : status.configured ? (
          <>
            <KeyValues
              rows={[
                ["App", <a key="a" className="text-accent underline" href={status.htmlUrl} target="_blank" rel="noreferrer">{status.name} ({status.slug})</a>],
                ["Owner", status.owner ?? ""],
                ["Install on repositories", <a key="i" className="text-accent underline" href={status.installUrl} target="_blank" rel="noreferrer">{status.installUrl}</a>],
                ["Callback URLs", status.callbackUrls.join("  ")],
              ]}
            />
            <p className="text-xs text-faint">
              Users sign in with GitHub (public mode) and install the app on the repositories they choose; the server mints a one-hour token per repository when it needs one. If this server&apos;s address changes, update the callback and setup URLs in the{" "}
              <a className="underline" href={status.settingsUrl} target="_blank" rel="noreferrer">app settings on GitHub</a>.
            </p>
            {confirmRemove ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm text-muted">Remove the app&apos;s credentials from this server? (Delete the app itself on GitHub.)</span>
                <Button variant="danger" disabled={busy} onClick={() => void remove()}>Remove from this server</Button>
                <Button variant="ghost" onClick={() => setConfirmRemove(false)}>Keep</Button>
              </div>
            ) : (
              <Button variant="ghost" onClick={() => setConfirmRemove(true)}>Remove from this server…</Button>
            )}
          </>
        ) : (
          <>
            <p className="text-sm text-muted">
              Creates a GitHub App under your GitHub account (or an organization) with exactly these permissions: repository contents and pull requests (read and write), metadata, commit statuses, deployments and checks (read), and the user&apos;s email address (read, for sign-in). No webhooks. You confirm the name on GitHub.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="App name (unique on GitHub)"><TextInput value={name} maxLength={34} onChange={(e) => setName(e.target.value)} /></Field>
              <Field label="Organization (optional)" hint="Empty = your personal account."><TextInput value={org} onChange={(e) => setOrg(e.target.value)} placeholder="my-company" /></Field>
            </div>
            <p className="text-xs text-faint">Callback URLs it registers: {status.callbackUrls.join(", ")}</p>
            <Button variant="primary" disabled={busy} onClick={() => void create()}>{busy ? "Opening GitHub…" : "Create the GitHub App on GitHub"}</Button>
          </>
        )}
      </div>
    </Panel>
  );
}
