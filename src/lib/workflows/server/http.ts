/** Shared answers of the workflow API routes (src/app/api/workflows/). */
import { jsonError } from "@/lib/accounts/http";
import { quotaErrorResponse } from "@/lib/storage/http";
import { RunRefusedError } from "./runner";
import { WorkflowStoreError } from "./store";

export function workflowError(error: unknown): Response {
  const quota = quotaErrorResponse(error);
  if (quota) return quota;
  if (error instanceof WorkflowStoreError) return jsonError(error.message, error.status, error.details ? { details: error.details } : {});
  if (error instanceof RunRefusedError) return jsonError(error.message, error.status);
  throw error;
}

export function zodMessage(error: { issues: { path: PropertyKey[]; message: string }[] }): string {
  const issue = error.issues[0];
  return `${issue.path.map(String).join("/") || "body"}: ${issue.message}`;
}
