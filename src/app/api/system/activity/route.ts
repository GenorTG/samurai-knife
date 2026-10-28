import { networkInterfaces } from "node:os";
import { json, jsonError } from "@/lib/accounts/http";
import { socketPeer } from "@/lib/accounts/network";
import { normalizeIp } from "@/lib/net/client-ip.mjs";
import { auditsRunning } from "@/lib/site/audit/run";
import { pythonQueue } from "@/lib/work-queue";
import { workflowQueueStats } from "@/lib/workflows/server/runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const KEY = Symbol.for("samurai-knife.activity.v1");

interface Counters {
  inflight: number;
  lastWork: number;
  started: number;
}

/**
 * A process on this machine: the peer is loopback or one of this host's own addresses, and no proxy forwarded it (Next
 * fills X-Forwarded-For with the peer itself on a direct connection; a proxy puts its client there).
 */
function fromThisHost(request: Request): boolean {
  const peer = socketPeer(request);
  if (!peer) return false;
  if (request.headers.has("forwarded") || request.headers.has("x-real-ip")) return false;
  const forwarded = (request.headers.get("x-forwarded-for") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (forwarded.some((a) => normalizeIp(a) !== peer)) return false;
  if (peer === "127.0.0.1" || peer === "::1") return true;
  return Object.values(networkInterfaces()).some((list) => list?.some((a) => normalizeIp(a.address) === peer));
}

/**
 * GET /api/system/activity -> { busy, idleSeconds, inflight, jobs, audits, workflows } for knife-update, which restarts
 * the server only after a quiet moment (docs/DEPLOY.md "Updates without breaking work"). Work = an agent's MCP calls, the
 * assistant, saves and uploads (scripts/activity.mjs), Python jobs, website audits and workflow runs; open tabs alone are
 * not. Counts only, no accounts; answered only to processes on this host (404 otherwise, also through the proxy).
 */
export async function GET(request: Request): Promise<Response> {
  if (!fromThisHost(request)) return jsonError("not_found", 404);
  const c = (globalThis as unknown as Record<symbol, Counters | undefined>)[KEY];
  const now = Date.now();
  const inflight = c?.inflight ?? 0;
  const jobs = Object.values(pythonQueue().stats()).reduce((n, l) => n + l.running + l.queued, 0);
  const audits = auditsRunning();
  const wf = workflowQueueStats();
  const workflows = wf.running + wf.queued;
  const idleSeconds = Math.floor((now - (c?.lastWork || c?.started || now)) / 1000);
  return json({ busy: inflight + jobs + audits + workflows > 0, idleSeconds, inflight, jobs, audits, workflows, tracked: Boolean(c) });
}
