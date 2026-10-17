import type { NextResponse } from "next/server";
import { jsonError } from "@/lib/accounts/http";
import { quotaErrorResponse } from "@/lib/storage/http";
import { SiteError } from "./net";

/** SiteError -> its status and message; quota -> 507; anything else -> 500 with the message (owner-facing tool). */
export function siteErrorResponse(error: unknown): NextResponse {
  if (error instanceof SiteError) return jsonError(error.message, error.status);
  return quotaErrorResponse(error) ?? jsonError(error instanceof Error ? error.message : String(error), 500);
}
