import { jsonError } from "@/lib/accounts/http";
import { ShowcaseError } from "./types";

/** Domain failures become real 4xx/502 with the reason; anything else is rethrown (500). */
export function showcaseErrorResponse(error: unknown): Response {
  if (error instanceof ShowcaseError) return jsonError(error.message, error.status);
  throw error;
}
