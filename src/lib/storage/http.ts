import type { NextResponse } from "next/server";
import { jsonError } from "@/lib/accounts/http";
import { QuotaExceededError } from "./quota";

/** 507 Insufficient Storage with the readable message and the numbers (`code: "storage_quota_exceeded"`), else null. */
export function quotaErrorResponse(error: unknown): NextResponse | null {
  return error instanceof QuotaExceededError ? jsonError(error.message, 507, error.details()) : null;
}
