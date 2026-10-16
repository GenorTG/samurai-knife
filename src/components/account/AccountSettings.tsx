"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Badge, Button, Field, KeyValues, Notice, Panel, StorageMeter, TextInput } from "@/components/ui";
import { formatBytes } from "@/lib/format";
import type { StorageUsage } from "@/lib/storage/quota";
import type { PublicAccount } from "@/lib/accounts/store";
import { clearAccountStorage } from "@/lib/client-account";
import { call, fetchMe, hardNavigate } from "./api";

type Note = { tone: "good" | "error"; text: string } | null;

function Status({ note }: { note: Note }) {
  return <div role="status" aria-live="polite">{note ? <Notice tone={note.tone}>{note.text}</Notice> : null}</div>;
}

function ChangePassword() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [working, setWorking] = useState(false);
  const [note, setNote] = useState<Note>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setWorking(true);
    setNote(null);
    const reply = await call<{ signedOut: number }>("POST", "/api/account/password", { currentPassword: current, newPassword: next });
    setWorking(false);
    if (reply.ok) {
      setCurrent("");
      setNext("");
      setNote({ tone: "good", text: `Password changed. ${reply.body.signedOut} other session(s) were signed out.` });
    } else {
      setNote({ tone: "error", text: reply.message });
    }
  }

  return (
    <Panel title="Change password">
      <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2" aria-label="Change password">
        <Field label="Current password">
          <TextInput type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
        </Field>
        <Field label="New password" hint="At least 10 characters. Signs out your other devices.">
          <TextInput type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required minLength={10} />
        </Field>
        <div className="space-y-3 sm:col-span-2">
          <Status note={note} />
          <Button type="submit" variant="primary" disabled={working || !current || next.length < 10}>
            {working ? "Saving…" : "Change password"}
          </Button>
        </div>
      </form>
    </Panel>
  );
}

function ChangeEmail({ account, onChanged }: { account: PublicAccount; onChanged: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [working, setWorking] = useState(false);
  const [note, setNote] = useState<Note>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setWorking(true);
    setNote(null);
    const reply = await call<{ message: string }>("POST", "/api/account/email", { email: email.trim(), password });
    setWorking(false);
    if (reply.ok) {
      setPassword("");
      setNote({ tone: "good", text: reply.body.message });
      onChanged();
    } else {
      setNote({ tone: "error", text: reply.message });
    }
  }

  return (
    <Panel title="Change email">
      <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2" aria-label="Change email">
        {account.pendingEmail ? (
          <div className="sm:col-span-2">
            <Notice tone="info">Waiting for confirmation of {account.pendingEmail}: open the link sent there. Until then {account.email} stays in use.</Notice>
          </div>
        ) : null}
        <Field label="New email">
          <TextInput type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </Field>
        <Field label="Password" hint="To confirm it is you.">
          <TextInput type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </Field>
        <div className="space-y-3 sm:col-span-2">
          <Status note={note} />
          <Button type="submit" disabled={working || !email.trim() || !password}>
            {working ? "Sending…" : "Send confirmation link"}
          </Button>
        </div>
      </form>
    </Panel>
  );
}

const AREAS: [keyof StorageUsage["areas"], string][] = [
  ["docs", "Office documents (with versions and trash)"],
  ["cv", "CV studio (profile, snapshots, photo)"],
  ["conversations", "Assistant conversations"],
  ["jobs", "Running and finished jobs (temporary)"],
  ["learn", "Course progress"],
  ["usage", "Usage counters"],
];

/** Used / quota for this account (GET /api/account/storage) and what takes the space. */
function Storage() {
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void call<StorageUsage>("GET", "/api/account/storage").then((reply) => {
      if (reply.ok) setUsage(reply.body);
      else setError(reply.message);
    });
  }, []);
  return (
    <Panel title="Storage">
      {usage ? (
        <div className="space-y-3">
          <StorageMeter usedBytes={usage.usedBytes} quotaBytes={usage.quotaBytes} label="Your storage" />
          {usage.quotaBytes === null ? <p className="text-xs text-faint">No storage limit on this account.</p> : null}
          <KeyValues rows={AREAS.filter(([key]) => usage.areas[key] > 0).map(([key, label]) => [label, formatBytes(usage.areas[key])])} />
          <p className="text-sm text-muted">
            To free space, empty the trash or prune old versions in{" "}
            <Link className="text-accent-soft underline underline-offset-2" href="/tools/office">Office documents</Link>.
          </p>
        </div>
      ) : error ? (
        <Notice tone="error">{error}</Notice>
      ) : (
        <p role="status" className="text-sm text-muted">Measuring your storage…</p>
      )}
    </Panel>
  );
}

function Sessions({ username }: { username: string }) {
  const [count, setCount] = useState<number | null>(null);
  const [note, setNote] = useState<Note>(null);
  useEffect(() => {
    void call<{ count: number }>("GET", "/api/account/sessions").then((reply) => {
      if (reply.ok) setCount(reply.body.count);
    });
  }, []);

  async function logout(everywhere: boolean) {
    // Nothing of this account stays in this browser for the next person (transcript, queue, SQL schema, trust mode).
    clearAccountStorage(username);
    const reply = everywhere
      ? await call<{ revoked: number }>("POST", "/api/account/sessions", { action: "revoke-all" })
      : await call("POST", "/api/account/logout", {});
    if (reply.ok) hardNavigate("/login");
    else setNote({ tone: "error", text: reply.message });
  }

  return (
    <Panel title="Sessions">
      <div className="space-y-3">
        <p className="text-sm text-muted">
          {count === null ? "Counting your sessions…" : `${count} signed-in session(s) (browsers and devices), this one included.`}
        </p>
        <Status note={note} />
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void logout(false)}>Log out</Button>
          <Button variant="danger" onClick={() => void logout(true)}>Log out everywhere</Button>
        </div>
      </div>
    </Panel>
  );
}

type McpKeyRow = { id: string; name: string; hint: string; createdAt: string; lastUsedAt: string | null };

/** UTC, minute precision: the same text on the server and in every browser locale. */
const when = (iso: string | null): string => (iso ? `${iso.slice(0, 16).replace("T", " ")} UTC` : "never");

/** Per-account MCP credentials (docs/MCP.md): an agent outside the browser acts on this account only. */
function McpKeys({ username }: { username: string }) {
  const [keys, setKeys] = useState<McpKeyRow[] | null>(null);
  const [name, setName] = useState("");
  const [created, setCreated] = useState<{ key: string; name: string } | null>(null);
  const [note, setNote] = useState<Note>(null);
  const [working, setWorking] = useState(false);

  const load = useCallback(() => {
    void call<{ keys: McpKeyRow[] }>("GET", "/api/account/mcp-keys").then((reply) => {
      if (reply.ok) setKeys(reply.body.keys);
      else setNote({ tone: "error", text: reply.message });
    });
  }, []);
  useEffect(load, [load]);

  async function create(event: FormEvent) {
    event.preventDefault();
    setWorking(true);
    setNote(null);
    const reply = await call<{ key: string; keyInfo: McpKeyRow }>("POST", "/api/account/mcp-keys", { action: "create", name });
    setWorking(false);
    if (!reply.ok) {
      setNote({ tone: "error", text: reply.message });
      return;
    }
    setCreated({ key: reply.body.key, name: reply.body.keyInfo.name });
    setName("");
    load();
  }

  async function revoke(row: McpKeyRow) {
    setNote(null);
    const reply = await call("POST", "/api/account/mcp-keys", { action: "revoke", id: row.id });
    if (reply.ok) {
      setNote({ tone: "good", text: `Revoked "${row.name}". Agents using it are refused from now on.` });
      load();
    } else {
      setNote({ tone: "error", text: reply.message });
    }
  }

  const endpoint = typeof window === "undefined" ? "/api/mcp" : `${window.location.origin}/api/mcp`;
  return (
    <Panel title="MCP keys">
      <div className="space-y-3">
        <p className="text-sm text-muted">
          Let an agent outside the browser (OpenClaw, Claude, Cursor…) use this account&apos;s tools at <code className="font-mono">{endpoint}</code>.
          It sends your username <code className="font-mono">{username}</code> and a key (HTTP Basic auth, or <code className="font-mono">Authorization: Bearer &lt;key&gt;</code> with <code className="font-mono">X-Knife-User: {username}</code>) and only ever reaches this account&apos;s data.
        </p>
        {created ? (
          <Notice tone="good">
            <span className="block">Key &quot;{created.name}&quot; created. Copy it now: it is not shown again.</span>
            <code data-testid="mcp-key-value" className="mt-2 block font-mono text-[13px] break-all select-all">{created.key}</code>
          </Notice>
        ) : null}
        <Status note={note} />
        {keys === null ? (
          <p className="text-sm text-muted">Loading keys…</p>
        ) : keys.length === 0 ? (
          <p className="text-sm text-muted">No MCP keys yet.</p>
        ) : (
          <ul className="divide-y divide-line rounded-lg border border-line" aria-label="MCP keys">
            {keys.map((row) => (
              <li key={row.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                <span className="min-w-0">
                  <span className="font-medium text-ink">{row.name}</span>{" "}
                  <span className="font-mono text-faint">{row.hint}</span>
                  <span className="block text-xs text-muted">created {when(row.createdAt)} · last used {when(row.lastUsedAt)}</span>
                </span>
                <Button size="sm" variant="danger" onClick={() => void revoke(row)} aria-label={`Revoke ${row.name}`}>Revoke</Button>
              </li>
            ))}
          </ul>
        )}
        <form onSubmit={create} className="flex flex-wrap items-end gap-2" aria-label="New MCP key">
          <Field label="Key name" hint="Where it is used, e.g. laptop OpenClaw." className="min-w-0 flex-1">
            <TextInput value={name} maxLength={60} onChange={(e) => setName(e.target.value)} required />
          </Field>
          <Button type="submit" disabled={working || !name.trim()}>{working ? "Creating…" : "Create key"}</Button>
        </form>
      </div>
    </Panel>
  );
}

function DeleteAccount({ username }: { username: string }) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [working, setWorking] = useState(false);
  const [note, setNote] = useState<Note>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setWorking(true);
    setNote(null);
    const reply = await call<{ removed: string[] }>("POST", "/api/account/delete", { password });
    setWorking(false);
    if (reply.ok) {
      clearAccountStorage(username);
      hardNavigate("/?account-deleted=1");
    }
    else setNote({ tone: "error", text: reply.message });
  }

  return (
    <Panel title="Delete account">
      {!open ? (
        <div className="space-y-3">
          <p className="text-sm text-muted">Removes the account, every session and MCP key, and all of its data on this server: CV studio, documents, assistant conversations, course progress and usage counters. It cannot be undone.</p>
          <Button variant="danger" onClick={() => setOpen(true)}>Delete my account…</Button>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-3" aria-label="Delete account">
          <Field label="Password" hint="Type it to delete the account for good.">
            <TextInput autoFocus type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </Field>
          <Status note={note} />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="danger" disabled={working || !password}>{working ? "Deleting…" : "Delete account and data"}</Button>
            <Button variant="ghost" onClick={() => setOpen(false)}>Keep it</Button>
          </div>
        </form>
      )}
    </Panel>
  );
}

/** /account: who you are, password, email, sessions, deletion (public mode); private mode shows the identity and sessions. */
export function AccountSettings() {
  const [account, setAccount] = useState<PublicAccount | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "anonymous" | "error">("loading");

  const load = useCallback(() => {
    void fetchMe().then((reply) => {
      if (reply.ok) {
        setAccount(reply.body);
        setState("ready");
      } else {
        setState(reply.status === 401 ? "anonymous" : "error");
      }
    });
  }, []);
  useEffect(load, [load]);

  if (state === "loading") return <p role="status" className="text-sm text-muted">Loading your account…</p>;
  if (state !== "ready" || !account) {
    return (
      <Panel>
        <Notice tone={state === "anonymous" ? "info" : "error"}>
          {state === "anonymous" ? "You are not logged in." : "Could not load the account."}{" "}
          <Link className="underline underline-offset-2" href="/login?next=/account">Log in</Link>
        </Notice>
      </Panel>
    );
  }
  const publicMode = account.authMode === "public";
  return (
    <div className="space-y-4">
      <Panel title="Account" right={<Badge tone={account.isAdmin && publicMode ? "accent" : "neutral"}>{account.role}</Badge>}>
        <div className="space-y-3">
          <KeyValues
            rows={[
              ["Username", account.id],
              ["Email", account.email ? `${account.email}${account.emailVerified ? "" : " (not confirmed)"}` : "—"],
            ]}
          />
          {account.isAdmin ? (
            <p className="text-sm text-muted">
              <Link className="text-accent-soft underline underline-offset-2" href="/account/admin">Manage users</Link>
              {" · "}
              <Link className="text-accent-soft underline underline-offset-2" href="/tools/sidecars">Sidecar services</Link>
            </p>
          ) : null}
        </div>
      </Panel>
      <Storage />
      {publicMode ? <ChangePassword /> : null}
      {publicMode ? <ChangeEmail account={account} onChanged={load} /> : null}
      <Sessions username={account.id} />
      <McpKeys username={account.id} />
      {publicMode ? <DeleteAccount username={account.id} /> : null}
    </div>
  );
}
