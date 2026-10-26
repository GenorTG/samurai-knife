import { Readable } from "node:stream";
import { authenticate, json, jsonError } from "@/lib/accounts/http";
import { requireAdmin } from "@/lib/accounts/authz";
import { LogAccessError, listLogSources, openLogFile, readLogTail } from "@/lib/logs/viewer";
import { msg } from "@/lib/i18n/msg";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Log files for admins (read-only; nothing here deletes or changes a file). docs/DEPLOY.md "Log files".
 *
 *   GET /api/admin/logs                                   -> { root, retentionDays, sources: [{ id, label, description, files: [{ name, size, mtime }] }] }
 *   GET /api/admin/logs?source=app&file=app-2026-10-21.log[&lines=500]  -> { source, file, size, mtime, lines[], truncated }
 *   GET /api/admin/logs?source=app&file=...&download=1   -> the file as stored (plain text or gzip)
 *
 * Sources: app, update, security, sidecar:<id>. Names are checked against each source's pattern and paths never leave
 * the source folder (src/lib/logs/viewer.ts).
 */
export async function GET(request: Request): Promise<Response> {
  const auth = authenticate(request, false);
  if ("response" in auth) return auth.response;
  const denied = requireAdmin(auth.account, "read the server logs");
  if (denied) return denied;
  const params = new URL(request.url).searchParams;
  const source = params.get("source");
  const file = params.get("file");
  if (source === null && file === null) return json(await listLogSources());
  if (!source || !file) return jsonError(msg("Give both source and file."), 400);
  try {
    if (params.get("download") === "1") {
      const opened = await openLogFile(source, file);
      // `end` pins the length that was stat'ed (the live file keeps growing); the stream closes the handle when done.
      let body: ReadableStream<Uint8Array> | string = "";
      if (opened.size === 0) await opened.handle.close();
      else body = Readable.toWeb(opened.handle.createReadStream({ start: 0, end: opened.size - 1 })) as ReadableStream<Uint8Array>;
      return new Response(body, {
        headers: {
          "Content-Type": opened.gz ? "application/gzip" : "text/plain; charset=utf-8",
          "Content-Length": String(opened.size),
          "Content-Disposition": `attachment; filename="${opened.name}"`,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
    const lines = Number(params.get("lines") ?? "500");
    return json(await readLogTail(source, file, Number.isFinite(lines) ? lines : 500));
  } catch (error) {
    if (error instanceof LogAccessError) return jsonError(error.message, error.status);
    throw error;
  }
}
