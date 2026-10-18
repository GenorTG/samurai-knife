import { NextResponse } from "next/server";
import { isQueueFull, type QueueFullError } from "@/lib/work-queue";

/**
 * 503 + Retry-After for a full lane; 429 when the caller's own share of the lane is full (work-queue.ts `perOwner`) or it
 * started too many jobs recently (python-admission.ts).
 */
export function queueFullResponse(error: QueueFullError): NextResponse {
  const status = error.scope === "lane" ? 503 : 429;
  return NextResponse.json(
    { ok: false, error: error.message, lane: error.lane, retryAfterSec: error.retryAfterSec },
    { status, headers: { "Retry-After": String(error.retryAfterSec), "Cache-Control": "no-store" } },
  );
}

/** `queueFullResponse` when the error is a QueueFullError, otherwise null (caller handles it). */
export function queueFullOrNull(error: unknown): NextResponse | null {
  return isQueueFull(error) ? queueFullResponse(error) : null;
}
