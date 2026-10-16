"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Notice, NumberField, Panel } from "@/components/ui";
import { formatBytes } from "@/lib/format";
import type { AdminUserRow } from "@/lib/accounts/admin";
import { call, fetchUsers } from "./api";

const GIB = 1024 ** 3;

/** Dates as plain UTC text: no locale formatting (SSR/hydration rule), and admins compare them across time zones. */
function when(iso: string | null): string {
  return iso ? `${iso.slice(0, 16).replace("T", " ")} UTC` : "never";
}

function statusTone(status: AdminUserRow["status"]): "good" | "warn" | "danger" {
  return status === "active" ? "good" : status === "pending" ? "warn" : "danger";
}

function QuotaEditor({ row, onSave }: { row: AdminUserRow; onSave: (bytes: number | null) => void }) {
  const [gib, setGib] = useState(row.storageQuotaBytes === null ? 0 : Math.round((row.storageQuotaBytes / GIB) * 100) / 100);
  return (
    <div className="flex items-center gap-2">
      <NumberField aria-label={`Quota of ${row.id} in GiB (0 = unlimited)`} value={gib} onValueChange={setGib} min={0} max={1024} className="w-24" />
      <Button size="sm" onClick={() => onSave(gib > 0 ? Math.round(gib * GIB) : null)}>Save quota</Button>
    </div>
  );
}

/** /account/admin: every account with its state; disable/enable, delete, quota, role, resend verification. */
export function AdminUsers() {
  const [rows, setRows] = useState<AdminUserRow[] | null>(null);
  const [self, setSelf] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<{ tone: "good" | "error"; text: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const load = useCallback(() => {
    void fetchUsers().then((reply) => {
      if (reply.ok) {
        setRows(reply.body.users);
        setSelf(reply.body.self);
        setError(null);
      } else {
        setError(reply.message);
      }
    });
  }, []);
  useEffect(load, [load]);

  async function act(id: string, body: Record<string, unknown>, done: string) {
    setNote(null);
    const reply = await call<{ detail?: string; removed?: string[] }>("POST", `/api/admin/users/${encodeURIComponent(id)}`, body);
    if (reply.ok) {
      const extra = reply.body.detail ? ` (${reply.body.detail})` : reply.body.removed ? ` Removed: ${reply.body.removed.join(", ")}.` : "";
      setNote({ tone: "good", text: `${done}${extra}` });
      load();
    } else {
      setNote({ tone: "error", text: reply.message });
    }
  }

  if (error) {
    return (
      <Panel>
        <Notice tone="error">{error} <Link className="underline underline-offset-2" href="/login?next=/account/admin">Log in</Link></Notice>
      </Panel>
    );
  }
  if (!rows) return <p role="status" className="text-sm text-muted">Loading users…</p>;

  return (
    <div className="space-y-4">
      <div role="status" aria-live="polite">{note ? <Notice tone={note.tone}>{note.text}</Notice> : null}</div>
      <Panel title={`Users (${rows.length})`} bodyClassName="p-0 sm:p-0">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[56rem] text-left text-sm">
            <thead className="border-b border-line text-xs text-faint">
              <tr>
                <th scope="col" className="px-4 py-2 font-medium">User</th>
                <th scope="col" className="px-4 py-2 font-medium">Email</th>
                <th scope="col" className="px-4 py-2 font-medium">State</th>
                <th scope="col" className="px-4 py-2 font-medium">Created / last login</th>
                <th scope="col" className="px-4 py-2 font-medium">Storage</th>
                <th scope="col" className="px-4 py-2 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} data-user={row.id} className="border-b border-line align-top last:border-0">
                  <td className="px-4 py-3">
                    <div className="font-medium text-ink">{row.id}{row.id === self ? " (you)" : ""}</div>
                    <div className="mt-1"><Badge tone={row.role === "admin" ? "accent" : "neutral"}>{row.role}</Badge></div>
                  </td>
                  <td className="px-4 py-3 text-muted">
                    <div className="wrap-anywhere">{row.email ?? "—"}</div>
                    <div className="text-xs text-faint">{row.email ? (row.emailVerified ? "confirmed" : "not confirmed") : ""}</div>
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    <Badge tone={statusTone(row.status)}>{row.status}</Badge>
                    <div className="mt-1 text-xs text-faint">{row.sessions} session(s){row.hasPassword ? "" : ", no password"}</div>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-muted">
                    <div>{when(row.createdAt)}</div>
                    <div>{when(row.lastLoginAt)}</div>
                  </td>
                  <td className="px-4 py-3 text-xs text-muted">
                    <div className="mb-1.5 font-mono">{formatBytes(row.storageBytes)} of {row.storageQuotaBytes === null ? "unlimited" : formatBytes(row.storageQuotaBytes)}</div>
                    <QuotaEditor row={row} onSave={(bytes) => void act(row.id, { action: "quota", bytes }, `Quota of ${row.id} saved.`)} />
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1.5">
                      {row.status === "disabled" ? (
                        <Button size="sm" onClick={() => void act(row.id, { action: "enable" }, `${row.id} enabled.`)}>Enable</Button>
                      ) : (
                        <Button size="sm" disabled={row.id === self} onClick={() => void act(row.id, { action: "disable" }, `${row.id} disabled.`)}>Disable</Button>
                      )}
                      {!row.emailVerified && row.email ? (
                        <Button size="sm" onClick={() => void act(row.id, { action: "resend-verification" }, `Confirmation link sent to ${row.id}.`)}>Resend confirmation</Button>
                      ) : null}
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={row.id === self}
                        onClick={() => void act(row.id, { action: "role", role: row.role === "admin" ? "user" : "admin" }, `${row.id} is now ${row.role === "admin" ? "a user" : "an administrator"}.`)}
                      >
                        {row.role === "admin" ? "Make user" : "Make admin"}
                      </Button>
                      {confirmDelete === row.id ? (
                        <>
                          <Button size="sm" variant="danger" onClick={() => { setConfirmDelete(null); void act(row.id, { action: "delete" }, `${row.id} deleted.`); }}>
                            Confirm delete {row.id}
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(null)}>Keep</Button>
                        </>
                      ) : (
                        <Button size="sm" variant="danger" disabled={row.id === self} onClick={() => setConfirmDelete(row.id)}>Delete…</Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}
