import type { ZodType } from "zod/v4";
import { authenticate, json, jsonError, readJsonBody } from "@/lib/accounts/http";
import { CvCollectionError } from "./collections";
import { CvStoreError, mutateCv } from "./store";
import type { CvData } from "./schema";

/** A damaged stored file is a server-side condition with a readable reason, not an opaque 500: the UI can show it. */
export function cvStoreErrorResponse(error: unknown): Response | null {
  return error instanceof CvStoreError ? jsonError(error.message, 500) : null;
}

/** Shared body of the CV collection routes: auth + origin guard, parse, mutate, translate domain errors to 422. */
export async function cvMutationRoute<T>(request: Request, bodySchema: ZodType<T>, apply: (data: CvData, body: T) => { data: CvData; result: unknown }): Promise<Response> {
  const auth = authenticate(request, true);
  if ("response" in auth) return auth.response;
  const read = await readJsonBody(request, 1024 * 1024);
  if ("response" in read) return read.response;
  const parsed = bodySchema.safeParse(read.body);
  if (!parsed.success) return jsonError(`Bad request: ${parsed.error.issues[0].path.join("/") || "body"}: ${parsed.error.issues[0].message}`, 422);
  try {
    const { data, result } = mutateCv(auth.account.id, (current) => apply(current, parsed.data));
    return json({ revision: data.revision, ...(result as object) });
  } catch (error) {
    if (error instanceof CvCollectionError) return jsonError(error.message, error.message.startsWith("no ") ? 404 : 422);
    const stored = cvStoreErrorResponse(error);
    if (stored) return stored;
    throw error;
  }
}

export async function cvDeleteRoute(request: Request, remove: (data: CvData, id: string) => CvData): Promise<Response> {
  const id = new URL(request.url).searchParams.get("id") ?? "";
  if (!id) return jsonError("Pass ?id=<id>.", 422);
  const auth = authenticate(request, true);
  if ("response" in auth) return auth.response;
  try {
    const { data } = mutateCv(auth.account.id, (current) => ({ data: remove(current, id), result: null }));
    return json({ revision: data.revision, removed: id });
  } catch (error) {
    if (error instanceof CvCollectionError) return jsonError(error.message, 404);
    const stored = cvStoreErrorResponse(error);
    if (stored) return stored;
    throw error;
  }
}
