import { authenticate, json } from "@/lib/accounts/http";
import { learnError, readyConnection } from "@/lib/learn/sql/api";
import { courseSchema } from "@/lib/learn/sql/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/learn/sql/schema -> { tables }: tables and columns of the course schemas, as the learner role sees them. */
export async function GET(request: Request): Promise<Response> {
  const auth = authenticate(request, false);
  if ("response" in auth) return auth.response;
  try {
    return json({ tables: await courseSchema(await readyConnection()) });
  } catch (error) {
    return learnError(error);
  }
}
