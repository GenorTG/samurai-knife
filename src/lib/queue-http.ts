import { NextResponse } from "next/server";
import { isQueueFull, type QueueFullError } from "@/lib/work-queue";

/** 503 + Retry-After for a full lane. */
export function queueFullResponse(error: QueueFullError): NextResponse {
  return NextResponse.json(
    { ok: false, error: error.message, lane: error.lane, retryAfterSec: error.retryAfterSec },
    { status: 503, headers: { "Retry-After": String(error.retryAfterSec), "Cache-Control": "no-store" } },
  );
}

/** `queueFullResponse` when the error is a QueueFullError, otherwise null (caller handles it). */
export function queueFullOrNull(error: unknown): NextResponse | null {
  return isQueueFull(error) ? queueFullResponse(error) : null;
}
