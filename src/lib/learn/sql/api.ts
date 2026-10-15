import { jsonError } from "@/lib/accounts/http";
import { touch } from "@/lib/services/manager";
import { ProgressError } from "../progress";
import { ensureSeeded, LearnDbError, SERVICE_ID, sidecarConnection, type ConnectionInfo } from "./db";

/** Shared by the /api/learn/sql routes: a seeded connection, and errors as JSON. */

export async function readyConnection(): Promise<ConnectionInfo> {
  const info = sidecarConnection();
  await ensureSeeded(info);
  touch(SERVICE_ID);
  return info;
}

export function learnError(error: unknown): Response {
  if (error instanceof LearnDbError) return jsonError(error.message, error.status, { code: error.code });
  if (error instanceof ProgressError) return jsonError(error.message, 500, { code: "progress_damaged" });
  throw error;
}
