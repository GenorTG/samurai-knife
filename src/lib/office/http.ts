import { jsonError } from "@/lib/accounts/http";
import { JwtError } from "@/lib/jwt-hs256";
import { OfficeUnavailableError } from "./editor";
import { DocError } from "./store";
import { ZipError } from "./zip";

/** Shared error mapping for the browser-facing office routes. */
export function officeError(error: unknown): Response {
  if (error instanceof DocError) return jsonError(error.message, error.status);
  if (error instanceof OfficeUnavailableError) return jsonError(error.message, 409, { code: "sidecar_not_installed" });
  if (error instanceof ZipError) return jsonError(`not a readable office file: ${error.message}`, 422);
  if (error instanceof JwtError) return jsonError(error.message, 403);
  throw error;
}

/** RFC 6266 attachment header with an ASCII fallback and the UTF-8 name. */
export function attachment(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
