import { json } from "@/lib/accounts/http";
import { appVersion } from "@/lib/version";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/system/version -> { version: "MAJOR.MINOR.PATCH.BUILD" } (src/lib/version.ts). No account needed. */
export async function GET(): Promise<Response> {
  return json({ version: appVersion() });
}
