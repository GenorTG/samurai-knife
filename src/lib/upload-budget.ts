import { msgf } from "@/lib/i18n/msg";
import os from "node:os";

import { isPublicMode } from "./accounts/mode";
import { admitDiskBytes } from "./storage/disk-floor";

/**
 * Admission for request bodies the server streams to disk (multipart uploads: `/api/pdf`). docs/ARCHITECTURE.md
 * "Server work".
 *
 * Threat model (abuse audit #7): the work queue only counts jobs, so without this any number of uploads from one account
 * could be streaming into the scratch dir at once (40 x 512 MB = 20 GB of /tmp, RAM when /tmp is tmpfs). Every upload
 * takes a slot BEFORE the first body byte is read and gives it back in `finally`: per account, server-wide, an in-flight
 * byte budget, and the scratch filesystem's free-space floor (`storage/disk-floor.ts`). Refusals are 429 (the caller's
 * own share) or 503 (server load / low disk), both with Retry-After; nothing is written for a refused upload.
 *
 * Defaults (public / private mode), env-overridable:
 * - KNIFE_UPLOADS_PER_ACCOUNT: 2 / 8 uploads in flight per account.
 * - KNIFE_UPLOADS_MAX: 6 / 16 server-wide; in public mode one of them is kept for administrators.
 * - KNIFE_UPLOADS_INFLIGHT_MAX_MB: 512 / 4096 MB reserved by all in-flight uploads (administrators are not counted).
 * - KNIFE_UPLOAD_IDLE_SEC: 30 s without a body byte and the upload is abandoned (408), so a stalled client cannot sit on
 *   a slot; pass `uploadIdleTimeoutMs()` to the streaming reader.
 * A reservation is the declared Content-Length (when valid and under the cap) or the cap itself, and the caller must
 * pass `reservation.bytes` as the body cap to the streaming reader, so the reservation is a bound, not an estimate.
 */

export class UploadBudgetError extends Error {
  readonly code = "UPLOAD_BUDGET";
  readonly status: 429 | 503;
  readonly retryAfterSec: number;
  constructor(status: 429 | 503, message: string, retryAfterSec: number) {
    super(message);
    this.name = "UploadBudgetError";
    this.status = status;
    this.retryAfterSec = retryAfterSec;
  }
}

export const isUploadBudgetError = (error: unknown): error is UploadBudgetError =>
  typeof error === "object" && error !== null && (error as { code?: unknown }).code === "UPLOAD_BUDGET";

export interface UploadReservation {
  /** Bytes reserved: the most the caller may read from the body. */
  readonly bytes: number;
  /** After the body is on disk: hold only what it really took (never grows). */
  shrinkTo(actualBytes: number): void;
  /** Give the slot and the bytes back. Idempotent. */
  release(): void;
}

export interface UploadRequest {
  owner: string;
  /** Content-Length when the client sent a valid one, else null (chunked). */
  declaredBytes: number | null;
  /** The route's body cap. */
  maxBytes: number;
  /** An administrator in public mode: may use the reserved slot, not counted against the byte budget. */
  privileged?: boolean;
  /** Where the body is written (default os.tmpdir()): its filesystem's free-space floor applies. */
  dir?: string;
}

export interface UploadBudgetSettings {
  perAccount: number;
  max: number;
  inflightBytes: number;
  /** Slots kept for administrators. */
  reserved: number;
}

function intFromEnv(name: string, fallback: number, min: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isInteger(parsed) && parsed >= min ? parsed : fallback;
}

export function uploadBudgetSettings(): UploadBudgetSettings {
  const isPublic = isPublicMode();
  const max = intFromEnv("KNIFE_UPLOADS_MAX", isPublic ? 6 : 16, 1);
  return {
    perAccount: intFromEnv("KNIFE_UPLOADS_PER_ACCOUNT", isPublic ? 2 : 8, 1),
    max,
    inflightBytes: intFromEnv("KNIFE_UPLOADS_INFLIGHT_MAX_MB", isPublic ? 512 : 4096, 1) * 1024 * 1024,
    reserved: isPublic && max > 1 ? 1 : 0,
  };
}

/** How long an upload may send nothing before it loses its slot (multipart-upload.ts `idleTimeoutMs`). */
export function uploadIdleTimeoutMs(): number {
  return intFromEnv("KNIFE_UPLOAD_IDLE_SEC", 30, 1) * 1000;
}

interface State {
  /** Uploads in flight per owner; an entry exists only while that owner has one (bounded by `max`). */
  perOwner: Map<string, number>;
  total: number;
  /** Ordinary (non-privileged) uploads in flight. */
  ordinary: number;
  /** Bytes reserved by ordinary uploads. */
  bytes: number;
}

const STATE_KEY = Symbol.for("samurai-knife.upload-budget.v1");

function state(): State {
  const holder = globalThis as unknown as Record<symbol, State | undefined>;
  const current = holder[STATE_KEY];
  if (!current || !(current.perOwner instanceof Map)) holder[STATE_KEY] = { perOwner: new Map(), total: 0, ordinary: 0, bytes: 0 };
  return holder[STATE_KEY] as State;
}

const BUSY = "Too many uploads are in progress on the server. Try again shortly.";

/** Takes an upload slot or throws UploadBudgetError. Synchronous: no other request can slip in between check and take. */
export function reserveUpload(request: UploadRequest): UploadReservation {
  const settings = uploadBudgetSettings();
  const current = state();
  const declared = request.declaredBytes;
  const bytes = declared !== null && Number.isFinite(declared) && declared >= 0 ? Math.min(declared, request.maxBytes) : request.maxBytes;
  const privileged = request.privileged === true;

  if ((current.perOwner.get(request.owner) ?? 0) >= settings.perAccount) {
    throw new UploadBudgetError(429, msgf("You already have {perAccount} uploads in progress. Wait for one to finish, then try again.", { perAccount: settings.perAccount }), 10);
  }
  if (current.total >= settings.max || (!privileged && current.ordinary >= settings.max - settings.reserved)) {
    throw new UploadBudgetError(503, BUSY, 10);
  }
  if (!privileged && current.bytes + bytes > settings.inflightBytes) throw new UploadBudgetError(503, BUSY, 10);
  if (!admitDiskBytes(request.dir ?? os.tmpdir(), bytes)) {
    throw new UploadBudgetError(503, "The server is low on scratch space right now. Try again later.", 60);
  }

  current.perOwner.set(request.owner, (current.perOwner.get(request.owner) ?? 0) + 1);
  current.total += 1;
  if (!privileged) {
    current.ordinary += 1;
    current.bytes += bytes;
  }
  let held = bytes;
  let released = false;
  return {
    bytes,
    shrinkTo(actualBytes: number) {
      if (released || !Number.isFinite(actualBytes) || actualBytes < 0 || actualBytes >= held) return;
      if (!privileged) current.bytes -= held - actualBytes;
      held = actualBytes;
    },
    release() {
      if (released) return;
      released = true;
      const left = (current.perOwner.get(request.owner) ?? 1) - 1;
      if (left > 0) current.perOwner.set(request.owner, left);
      else current.perOwner.delete(request.owner);
      current.total -= 1;
      if (!privileged) {
        current.ordinary -= 1;
        current.bytes -= held;
      }
    },
  };
}

/** Current counters (GET /api/system/queue). */
export function uploadBudgetStats(): { inFlight: number; accounts: number; reservedBytes: number } & UploadBudgetSettings {
  const current = state();
  return { ...uploadBudgetSettings(), inFlight: current.total, accounts: current.perOwner.size, reservedBytes: current.bytes };
}
