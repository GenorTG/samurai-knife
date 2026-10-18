import { credentialHash, currentGuard } from "./guard.mjs";

/**
 * The app's side of the abuse guard (src/lib/security/guard.mjs, installed by the scripts/abuse-guard.mjs preload, which
 * cannot read sessions): when a request resolves to an administrator, its credential hash is marked so the guard never
 * blocks that admin (budgets still apply, at 4x). Called from `authenticate` (src/lib/accounts/http.ts). A no-op when the
 * server was not started through scripts/serve.mjs (no guard installed).
 */
export function noteAuthenticated(request: Request, admin: boolean): void {
  if (!admin) return;
  const guard = currentGuard();
  if (!guard) return;
  const hash = credentialHash({ cookie: request.headers.get("cookie") ?? undefined, authorization: request.headers.get("authorization") ?? undefined });
  if (hash) guard.markAdmin(hash);
}
