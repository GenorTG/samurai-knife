import { createReadStream } from "node:fs";
import { Readable } from "node:stream";

import { authenticate, jsonError } from "@/lib/accounts/http";
import { jobStore } from "@/lib/jobs";
import { knifeDataHeader } from "@/lib/pdf-run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/jobs/<id>/file -> the finished job's artifact, with the same headers the synchronous route sends. */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const auth = authenticate(request, false);
  if ("response" in auth) return auth.response;
  const { id } = await ctx.params;
  const record = jobStore().get(id, auth.account.id);
  if (!record) return jsonError("job_not_found", 404, { ok: false });
  const result = record.final?.result;
  if (!record.final) return jsonError("job_not_finished", 409, { ok: false });
  if (result?.kind !== "file") return jsonError("job_has_no_file", 404, { ok: false });

  const stream = Readable.toWeb(createReadStream(result.path)) as unknown as ReadableStream<Uint8Array>;
  return new Response(stream, {
    headers: {
      "Content-Type": result.mime,
      "Content-Length": String(result.bytes),
      "Content-Disposition": `attachment; filename="${result.filename}"`,
      "X-Knife-Data": knifeDataHeader(result.data),
      "X-Knife-Ms": String(result.ms ?? 0),
      "Cache-Control": "no-store",
    },
  });
}
