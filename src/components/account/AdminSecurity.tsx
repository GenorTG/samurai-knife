"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Notice, Panel, Stat, StatGrid } from "@/components/ui";
import { formatInt } from "@/lib/format";
import type { SecurityEvent } from "@/lib/security/events";
import { call } from "./api";

interface GuardBlock {
  key: string;
  until: string;
  since: string;
  level: number;
  reason: string;
  strikes: number;
}

interface SecurityReply {
  guard: {
    mode: "private" | "public";
    blocking: boolean;
    blocks: GuardBlock[];
    tables: { clients: number; credentials: number; blocks: number; maxClients: number; maxBlocks: number };
    counters: { refused: number; blocked: number; evicted: number };
  } | null;
  events: SecurityEvent[];
  rateLimits: Record<string, { keys: number; maxKeys: number; preAuth: boolean }>;
  alerts: { watching: boolean; pending: number; lastSent: string | null; mailsSent: number };
}

/** UTC text, no locale formatting (SSR/hydration rule). */
const utc = (iso: string) => `${iso.slice(0, 19).replace("T", " ")} UTC`;

/** A string detail as is, a flat record as `key=value` pairs. */
const detailText = (detail: SecurityEvent["detail"]) => (typeof detail === "string" ? detail : detail ? Object.entries(detail).map(([k, v]) => `${k}=${v}`).join(" ") : "");

function kindTone(kind: string): "danger" | "warn" | "neutral" {
  if (kind === "scanner_block" || kind === "login_lockout" || kind === "disk_low" || kind === "quota_full") return "danger";
  if (kind === "unblock") return "neutral";
  return "warn";
}

/** /account/admin: the abuse guard's current blocks (with Unblock) and the recent security events. */
export function AdminSecurity() {
  const [data, setData] = useState<SecurityReply | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<{ tone: "good" | "error"; text: string } | null>(null);
  const [showAll, setShowAll] = useState(false);

  const load = useCallback(() => {
    void call<SecurityReply>("GET", "/api/admin/security").then((reply) => {
      if (reply.ok) {
        setData(reply.body);
        setError(null);
      } else {
        setError(reply.message);
      }
    });
  }, []);
  useEffect(load, [load]);

  async function unblock(key: string) {
    setNote(null);
    const reply = await call<{ removed: boolean }>("POST", "/api/admin/security", { action: "unblock", key });
    setNote(reply.ok ? { tone: "good", text: reply.body.removed ? `${key} unblocked.` : `${key} had no active block.` } : { tone: "error", text: reply.message });
    load();
  }

  if (error) return <Panel title="Security"><Notice tone="error">{error}</Notice></Panel>;
  if (!data) return <p className="text-sm text-muted">Loading security events…</p>;

  const events = [...data.events].reverse();
  const shown = showAll ? events : events.slice(0, 50);
  const guard = data.guard;
  const blocks = guard?.blocks ?? [];

  return (
    <section aria-label="Security" className="space-y-4">
      <div aria-live="polite">{note ? <Notice tone={note.tone}>{note.text}</Notice> : null}</div>
      <Panel
        title={<span className="flex items-center gap-2">Security {blocks.length ? <Badge tone="danger">{blocks.length} blocked</Badge> : <Badge tone="good">no blocks</Badge>}</span>}
        right={<Button size="sm" onClick={load}>Refresh</Button>}
      >
        {guard ? (
          <StatGrid aria-label="Abuse guard">
            <Stat label="Guard" value={`${guard.mode}${guard.blocking ? ", blocking" : ", budgets only"}`} />
            <Stat label="Clients tracked" value={`${formatInt(guard.tables.clients)} / ${formatInt(guard.tables.maxClients)}`} />
            <Stat label="Requests refused" value={formatInt(guard.counters.refused)} />
            <Stat label="Blocked requests" value={formatInt(guard.counters.blocked)} />
            <Stat label="Idle clients evicted" value={formatInt(guard.counters.evicted)} />
            <Stat label="Alert mails sent" value={formatInt(data.alerts.mailsSent)} />
          </StatGrid>
        ) : (
          <Notice tone="warn">The abuse guard is not running in this server process (it is loaded by <code>npm run start</code> / <code>npm run dev</code>).</Notice>
        )}
      </Panel>

      <Panel title={`Blocked clients (${blocks.length})`} bodyClassName="p-0 sm:p-0">
        {blocks.length === 0 ? (
          <p className="px-4 py-3 text-sm text-muted">Nobody is blocked.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] text-left text-sm">
              <thead className="border-b border-line text-xs text-faint">
                <tr>
                  <th scope="col" className="px-4 py-2 font-medium">Client prefix</th>
                  <th scope="col" className="px-4 py-2 font-medium">Why</th>
                  <th scope="col" className="px-4 py-2 font-medium">Until</th>
                  <th scope="col" className="px-4 py-2 font-medium">Action</th>
                </tr>
              </thead>
              <tbody>
                {blocks.map((block) => (
                  <tr key={block.key} data-block={block.key} className="border-b border-line align-top last:border-0">
                    <td className="px-4 py-3 font-mono text-xs text-ink wrap-anywhere">{block.key}</td>
                    <td className="px-4 py-3 text-muted">
                      <div>{block.reason}</div>
                      <div className="text-xs text-faint">level {block.level}, strike {block.strikes}</div>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-muted">{utc(block.until)}</td>
                    <td className="px-4 py-3"><Button size="sm" onClick={() => void unblock(block.key)}>Unblock {block.key}</Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel
        title={`Security events (${events.length})`}
        right={events.length > 50 ? <Button size="sm" variant="ghost" onClick={() => setShowAll(!showAll)}>{showAll ? "Show 50" : `Show all ${events.length}`}</Button> : null}
        bodyClassName="p-0 sm:p-0"
      >
        {events.length === 0 ? (
          <p className="px-4 py-3 text-sm text-muted">No security events recorded.</p>
        ) : (
          <div className="max-h-[32rem] overflow-auto">
            <table className="w-full min-w-[48rem] text-left text-sm">
              <thead className="sticky top-0 border-b border-line bg-surface text-xs text-faint">
                <tr>
                  <th scope="col" className="px-4 py-2 font-medium">Time</th>
                  <th scope="col" className="px-4 py-2 font-medium">Kind</th>
                  <th scope="col" className="px-4 py-2 font-medium">Client / account</th>
                  <th scope="col" className="px-4 py-2 font-medium">Detail</th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">Count</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((event, index) => (
                  <tr key={`${event.ts}-${index}`} data-event={event.kind} className="border-b border-line align-top last:border-0">
                    <td className="px-4 py-2 font-mono text-xs whitespace-nowrap text-muted">{utc(event.ts)}</td>
                    <td className="px-4 py-2"><Badge tone={kindTone(event.kind)}>{event.label ? `${event.kind}: ${event.label}` : event.kind}</Badge></td>
                    <td className="px-4 py-2 font-mono text-xs text-muted wrap-anywhere">{[event.ipPrefix, event.account].filter(Boolean).join(" · ") || "—"}</td>
                    <td className="px-4 py-2 text-xs text-muted wrap-anywhere">{[detailText(event.detail), event.path, event.status ? `HTTP ${event.status}` : ""].filter(Boolean).join(" · ")}</td>
                    <td className="px-4 py-2 text-right font-mono text-xs text-muted">{formatInt(event.count)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </section>
  );
}
