import * as z from "zod/v4";
import { authenticate, json, jsonError, readJsonBody } from "@/lib/accounts/http";
import { isAdmin, requireAdmin } from "@/lib/accounts/authz";
import { opViewFor, serviceViewFor } from "@/lib/services/view";
import { findSidecar } from "@/lib/services/definitions";
import { syncAssets } from "@/lib/services/assets";
import { configure, ensureReaper, needsRecreate, probeHealth, SidecarError, status, touch } from "@/lib/services/manager";
import { runningOp, startOp } from "@/lib/services/ops";
import { readState } from "@/lib/services/state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const urlField = z.string().max(300);

const bodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("install"),
    port: z.number().int().min(1024).max(65535).optional(),
    appUrl: urlField.optional(),
    publicUrl: urlField.optional(),
    idleStopMinutes: z.number().int().min(0).max(1440).optional(),
    autostart: z.boolean().optional(),
  }).strict(),
  z.object({ action: z.literal("start") }).strict(),
  z.object({ action: z.literal("stop") }).strict(),
  z.object({ action: z.literal("update") }).strict(),
  z.object({ action: z.literal("remove"), purge: z.boolean().optional(), removeImage: z.boolean().optional() }).strict(),
  /** Lazy start: answers `{ready:true}` when healthy, else starts it (or joins the running start) and returns the op. */
  z.object({ action: z.literal("ensure") }).strict(),
  /** Editor heartbeat: keeps the idle stop away while a document is open. */
  z.object({ action: z.literal("touch") }).strict(),
  z.object({
    action: z.literal("configure"),
    port: z.number().int().min(1024).max(65535).optional(),
    appUrl: urlField.nullable().optional(),
    publicUrl: urlField.nullable().optional(),
    idleStopMinutes: z.number().int().min(0).max(1440).optional(),
    autostart: z.boolean().optional(),
  }).strict(),
]);

function serviceError(error: unknown): Response {
  if (error instanceof SidecarError) return jsonError(error.message, error.status, error.hint ? { hint: error.hint } : undefined);
  throw error;
}

/** GET /api/services/<id>[?memory=1] -> status (runtime, container, ready, URLs, warnings) + the running op. */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const auth = authenticate(request, false);
  if ("response" in auth) return auth.response;
  const { id } = await ctx.params;
  if (!findSidecar(id)) return jsonError("unknown_service", 404);
  ensureReaper();
  const memory = new URL(request.url).searchParams.get("memory") === "1";
  return json({ service: serviceViewFor(auth.account, { ...(await status(id, { memory: memory && isAdmin(auth.account) })), op: runningOp(id) }) });
}

/**
 * POST /api/services/<id> { action, ... }. Long actions (install/start/stop/update/remove, ensure when stopped) return
 * 202 `{ op }` at once; poll GET /api/services/ops/<opId>.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const auth = authenticate(request, true);
  if ("response" in auth) return auth.response;
  const { id } = await ctx.params;
  const def = findSidecar(id);
  if (!def) return jsonError("unknown_service", 404);
  const read = await readJsonBody(request, 4096);
  if ("response" in read) return read.response;
  const parsed = bodySchema.safeParse(read.body);
  if (!parsed.success) return jsonError(`Bad request: ${parsed.error.issues[0].path.join("/") || "body"}: ${parsed.error.issues[0].message}`, 422);
  const body = parsed.data;
  ensureReaper();
  // Public mode: everything but using a running service (ensure while healthy, touch) is an administrator's job.
  if (body.action !== "ensure" && body.action !== "touch") {
    const denied = requireAdmin(auth.account, `${body.action} ${def.name}`);
    if (denied) return denied;
  }
  try {
    switch (body.action) {
      case "install": {
        return json({ op: startOp(id, { kind: "install", options: { port: body.port, appUrl: body.appUrl, publicUrl: body.publicUrl, idleStopMinutes: body.idleStopMinutes, autostart: body.autostart } }) }, 202);
      }
      case "remove":
        return json({ op: startOp(id, { kind: "remove", purge: body.purge, removeImage: body.removeImage }) }, 202);
      case "start":
      case "stop":
      case "update":
        return json({ op: startOp(id, { kind: body.action }) }, 202);
      case "ensure": {
        const state = readState(id);
        if (!state) return jsonError("not_installed", 409);
        const running = runningOp(id);
        if (running) return json({ ready: false, op: opViewFor(auth.account, running) }, 202);
        if (await probeHealth(def, state, 1500)) {
          // Running: refresh the mounted assets (a changed editor plugin is served at once under its new folder name);
          // a container from an older compose file (no plugin mount yet) is recreated once, before any document opens.
          syncAssets(def);
          if (!needsRecreate(def, state)) {
            touch(id);
            return json({ ready: true });
          }
        }
        const denied = requireAdmin(auth.account, `start ${def.name}`);
        if (denied) return denied;
        return json({ ready: false, op: startOp(id, { kind: "start" }) }, 202);
      }
      case "touch":
        touch(id);
        return json({ ok: true });
      case "configure": {
        return json(await configure(id, { port: body.port, appUrl: body.appUrl, publicUrl: body.publicUrl, idleStopMinutes: body.idleStopMinutes, autostart: body.autostart }));
      }
    }
  } catch (error) {
    return serviceError(error);
  }
}
