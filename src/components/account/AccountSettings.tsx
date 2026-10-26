"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Badge, Button, Field, KeyValues, Notice, Panel, StorageMeter, TextInput } from "@/components/ui";
import { formatBytes } from "@/lib/format";
import type { StorageUsage } from "@/lib/storage/quota";
import type { PublicAccount } from "@/lib/accounts/store";
import { clearAccountStorage } from "@/lib/client-account";
import { call, fetchMe, hardNavigate } from "./api";
import { GithubLink } from "./GithubLink";
import { useT } from "@/lib/i18n/react";
import { LanguageChoice } from "@/components/LanguageSwitcher";
import { msg } from "@/lib/i18n/msg";

type Note = { tone: "good" | "error"; text: string } | null;

function Status({ note }: { note: Note }) {
  return <div role="status" aria-live="polite">{note ? <Notice tone={note.tone}>{note.text}</Notice> : null}</div>;
}

function ChangePassword() {
  const { t, tn } = useT();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [working, setWorking] = useState(false);
  const [note, setNote] = useState<Note>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setWorking(true);
    setNote(null);
    const reply = await call<{ signedOut: number; mcpKeysRevoked: number }>("POST", "/api/account/password", { currentPassword: current, newPassword: next });
    setWorking(false);
    if (reply.ok) {
      setCurrent("");
      setNext("");
      const keys = reply.body.mcpKeysRevoked > 0 ? ` ${tn("{n} MCP key was revoked: create a new one for your agents.", "{n} MCP keys were revoked: create new ones for your agents.", reply.body.mcpKeysRevoked)}` : "";
      setNote({ tone: "good", text: `${t("Password changed.")} ${tn("{n} other session was signed out.", "{n} other sessions were signed out.", reply.body.signedOut)}${keys}` });
    } else {
      setNote({ tone: "error", text: reply.message });
    }
  }

  return (
    <Panel title={t("Change password")}>
      <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2" aria-label={t("Change password")}>
        <Field label={t("Current password")}>
          <TextInput type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
        </Field>
        <Field label={t("New password")} hint={t("At least 10 characters. Signs out your other devices and revokes your MCP keys.")}>
          <TextInput type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required minLength={10} />
        </Field>
        <div className="space-y-3 sm:col-span-2">
          <Status note={note} />
          <Button type="submit" variant="primary" disabled={working || !current || next.length < 10}>
            {working ? t("Saving…") : t("Change password")}
          </Button>
        </div>
      </form>
    </Panel>
  );
}

function ChangeEmail({ account, onChanged }: { account: PublicAccount; onChanged: () => void }) {
  const { t } = useT();
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
    <Panel title={t("Change email")}>
      <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2" aria-label={t("Change email")}>
        {account.pendingEmail ? (
          <div className="sm:col-span-2">
            <Notice tone="info">{t("Waiting for confirmation of {pendingEmail}: open the link sent there. Until then {email} stays in use.", { pendingEmail: account.pendingEmail, email: account.email })}</Notice>
          </div>
        ) : null}
        <Field label={t("New email")}>
          <TextInput type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </Field>
        <Field label={t("Password")} hint={t("To confirm it is you.")}>
          <TextInput type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </Field>
        <div className="space-y-3 sm:col-span-2">
          <Status note={note} />
          <Button type="submit" disabled={working || !email.trim() || !password}>
            {working ? t("Sending…") : t("Send confirmation link")}
          </Button>
        </div>
      </form>
    </Panel>
  );
}

const AREAS: [keyof StorageUsage["areas"], string][] = [
  ["docs", msg("Office documents (with versions and trash)")],
  ["cv", msg("CV studio (profile, snapshots, photo)")],
  ["conversations", msg("Assistant conversations")],
  ["workspace", msg("Tool drafts")],
  ["site", msg("Website studio (connection, audits)")],
  ["craft", msg("Craft apps files")],
  ["workflows", msg("Workflows (runs, credentials)")],
  ["jobs", msg("Running and finished jobs (temporary)")],
  ["learn", msg("Course progress")],
  ["usage", msg("Usage counters")],
];

/** Used / quota for this account (GET /api/account/storage) and what takes the space. */
function Storage() {
  const { t } = useT();
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void call<StorageUsage>("GET", "/api/account/storage").then((reply) => {
      if (reply.ok) setUsage(reply.body);
      else setError(reply.message);
    });
  }, []);
  return (
    <Panel title={t("Storage")}>
      {usage ? (
        <div className="space-y-3">
          <StorageMeter usedBytes={usage.usedBytes} quotaBytes={usage.quotaBytes} label={t("Your storage")} />
          {usage.quotaBytes === null ? <p className="text-xs text-faint">{t("No storage limit on this account.")}</p> : null}
          <KeyValues rows={AREAS.filter(([key]) => usage.areas[key] > 0).map(([key, label]) => [t(label), formatBytes(usage.areas[key])])} />
          <p className="text-sm text-muted">
            {t("To free space, empty the trash or prune old versions in")}{" "}
            <Link className="text-accent-soft underline underline-offset-2" href="/tools/office">{t("Office documents")}</Link>.
          </p>
        </div>
      ) : error ? (
        <Notice tone="error">{error}</Notice>
      ) : (
        <p role="status" className="text-sm text-muted">{t("Measuring your storage…")}</p>
      )}
    </Panel>
  );
}

function Sessions({ username }: { username: string }) {
  const { t, tn } = useT();
  const [count, setCount] = useState<number | null>(null);
  const [note, setNote] = useState<Note>(null);
  const [revokeKeys, setRevokeKeys] = useState(false);
  useEffect(() => {
    void call<{ count: number }>("GET", "/api/account/sessions").then((reply) => {
      if (reply.ok) setCount(reply.body.count);
    });
  }, []);

  async function logout(everywhere: boolean) {
    // Nothing of this account stays in this browser for the next person (transcript, queue, SQL schema, trust mode).
    clearAccountStorage(username);
    const reply = everywhere
      ? await call<{ revoked: number }>("POST", "/api/account/sessions", { action: "revoke-all", mcpKeys: revokeKeys })
      : await call("POST", "/api/account/logout", {});
    if (reply.ok) hardNavigate("/login");
    else setNote({ tone: "error", text: reply.message });
  }

  return (
    <Panel title={t("Sessions")}>
      <div className="space-y-3">
        <p className="text-sm text-muted">
          {count === null ? t("Counting your sessions…") : tn("{n} signed-in session (browsers and devices), this one included.", "{n} signed-in sessions (browsers and devices), this one included.", count)}
        </p>
        <label className="flex items-center gap-2 text-sm text-muted">
          <input type="checkbox" checked={revokeKeys} onChange={(e) => setRevokeKeys(e.target.checked)} />
          {t("With \"Log out everywhere\", also revoke every MCP key (agents lose access until you create a new key)")}
        </label>
        <Status note={note} />
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void logout(false)}>{t("Log out")}</Button>
          <Button variant="danger" onClick={() => void logout(true)}>{t("Log out everywhere")}</Button>
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
  const { t } = useT();
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
      setNote({ tone: "good", text: t("Revoked \"{name}\". Agents using it are refused from now on.", { name: row.name }) });
      load();
    } else {
      setNote({ tone: "error", text: reply.message });
    }
  }

  const endpoint = typeof window === "undefined" ? "/api/mcp" : `${window.location.origin}/api/mcp`;
  return (
    <Panel title={t("MCP keys")}>
      <div className="space-y-3">
        <p className="text-sm text-muted">
          {t("Let an agent outside the browser (OpenClaw, Claude, Cursor…) use this account's tools at")}{" "} <code className="font-mono">{endpoint}</code>{t(". It sends your username")}{" "} <code className="font-mono">{username}</code> {" "}{t("and a key (HTTP Basic auth, or")}{" "} <code className="font-mono">Authorization: Bearer &lt;key&gt;</code> {" "}{t("with")}{" "} <code className="font-mono">X-Knife-User: {username}</code>{t(") and only ever reaches this account's data.")}
        </p>
        {created ? (
          <Notice tone="good">
            <span className="block">{t("Key \"{name}\" created. Copy it now: it is not shown again.", { name: created.name })}</span>
            <code data-testid="mcp-key-value" className="mt-2 block font-mono text-[13px] break-all select-all">{created.key}</code>
          </Notice>
        ) : null}
        <Status note={note} />
        {keys === null ? (
          <p className="text-sm text-muted">{t("Loading keys…")}</p>
        ) : keys.length === 0 ? (
          <p className="text-sm text-muted">{t("No MCP keys yet.")}</p>
        ) : (
          <ul className="divide-y divide-line rounded-lg border border-line" aria-label={t("MCP keys")}>
            {keys.map((row) => (
              <li key={row.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                <span className="min-w-0">
                  <span className="font-medium text-ink">{row.name}</span>{" "}
                  <span className="font-mono text-faint">{t(row.hint)}</span>
                  <span className="block text-xs text-muted">{t("created {createdAt} · last used", { createdAt: when(row.createdAt) })}{" "} {when(row.lastUsedAt)}</span>
                </span>
                <Button size="sm" variant="danger" onClick={() => void revoke(row)} aria-label={t("Revoke {name}", { name: row.name })}>{t("Revoke")}</Button>
              </li>
            ))}
          </ul>
        )}
        <form onSubmit={create} className="flex flex-wrap items-end gap-2" aria-label={t("New MCP key")}>
          <Field label={t("Key name")} hint={t("Where it is used, e.g. laptop OpenClaw.")} className="min-w-0 flex-1">
            <TextInput value={name} maxLength={60} onChange={(e) => setName(e.target.value)} required />
          </Field>
          <Button type="submit" disabled={working || !name.trim()}>{working ? t("Creating…") : t("Create key")}</Button>
        </form>
      </div>
    </Panel>
  );
}

function DeleteAccount({ username, requiresPassword }: { username: string; requiresPassword: boolean }) {
  const { t } = useT();
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
    <Panel title={t("Delete account")}>
      {!open ? (
        <div className="space-y-3">
          <p className="text-sm text-muted">{t("Removes the account, every session and MCP key, and all of its data on this server: CV studio, documents, assistant conversations, course progress and usage counters. It cannot be undone.")}</p>
          <Button variant="danger" onClick={() => setOpen(true)}>{t("Delete my account…")}</Button>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-3" aria-label={t("Delete account")}>
          {requiresPassword ? (
            <Field label={t("Password")} hint={t("Type it to delete the account for good.")}>
              <TextInput autoFocus type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </Field>
          ) : (
            <Field label={t("Your username")} hint={t("You sign in with GitHub: type {username} to delete the account for good.", { username })}>
              <TextInput autoFocus autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </Field>
          )}
          <Status note={note} />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="danger" disabled={working || !password}>{working ? t("Deleting…") : t("Delete account and data")}</Button>
            <Button variant="ghost" onClick={() => setOpen(false)}>{t("Keep it")}</Button>
          </div>
        </form>
      )}
    </Panel>
  );
}

/** /account: who you are, password, email, sessions, deletion (public mode); private mode shows the identity and sessions. */
export function AccountSettings() {
  const { t } = useT();
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

  if (state === "loading") return <p role="status" className="text-sm text-muted">{t("Loading your account…")}</p>;
  if (state !== "ready" || !account) {
    return (
      <Panel>
        <Notice tone={state === "anonymous" ? "info" : "error"}>
          {state === "anonymous" ? t("You are not logged in.") : t("Could not load the account.")}{" "}
          <Link className="underline underline-offset-2" href="/login?next=/account">{t("Log in")}</Link>
        </Notice>
      </Panel>
    );
  }
  const publicMode = account.authMode === "public";
  return (
    <div className="space-y-4">
      <Panel title={t("Account")} right={<Badge tone={account.isAdmin && publicMode ? "accent" : "neutral"}>{account.role}</Badge>}>
        <div className="space-y-3">
          <KeyValues
            rows={[
              [t("Username"), account.id],
              [t("Email"), account.email ? `${account.email}${account.emailVerified ? "" : ` ${t("(not confirmed)")}`}` : "—"],
            ]}
          />
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="text-muted">{t("Interface language")}</span>
            <LanguageChoice />
          </div>
          {account.isAdmin ? (
            <p className="text-sm text-muted">
              <Link className="text-accent-soft underline underline-offset-2" href="/account/admin">{t("Manage users")}</Link>
              {" · "}
              <Link className="text-accent-soft underline underline-offset-2" href="/tools/sidecars">{t("Sidecar services")}</Link>
            </p>
          ) : null}
        </div>
      </Panel>
      <Storage />
      {publicMode && account.requiresPassword ? <ChangePassword /> : null}
      {publicMode && !account.requiresPassword ? (
        <Panel title={t("Password")}>
          <p className="text-sm text-muted">{t("You sign in with GitHub. To be able to log in with a password too, log out and use “Forgot your password?” with")}{" "} {account.email ?? t("your email address")}.</p>
        </Panel>
      ) : null}
      <GithubLink account={account} onChanged={load} />
      {publicMode ? <ChangeEmail account={account} onChanged={load} /> : null}
      <Sessions username={account.id} />
      <McpKeys username={account.id} />
      {publicMode ? <DeleteAccount username={account.id} requiresPassword={account.requiresPassword} /> : null}
    </div>
  );
}
