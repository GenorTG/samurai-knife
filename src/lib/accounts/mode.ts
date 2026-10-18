/**
 * KNIFE_AUTH_MODE: `private` (default) = the owner-only toolbox behind a loopback/Tailscale bind, the passwordless default
 * account is the implicit identity and accounts are made with `npm run accounts` only. `public` = multi-user: registration with
 * a verified email, every request needs a session, no default-account fallback anywhere. docs/ACCOUNTS.md.
 *
 * Fails closed: any value other than empty/`private` means public (a typo must never expose the passwordless account), and
 * so does an empty value with KNIFE_PUBLIC_URL set (a public deploy that lost its mode must never make the passwordless
 * account everyone's identity). scripts/serve.mjs refuses both situations at startup (scripts/deploy-config.mjs: a private
 * install that uses KNIFE_PUBLIC_URL for the GitHub App sets KNIFE_AUTH_MODE=private explicitly), so this only matters when
 * the app is started some other way. Same rule in src/lib/security/guard.mjs `guardMode`.
 */
export type AuthMode = "private" | "public";

export function authMode(env: NodeJS.ProcessEnv = process.env): AuthMode {
  const value = env.KNIFE_AUTH_MODE?.trim().toLowerCase();
  if (!value) return env.KNIFE_PUBLIC_URL?.trim() ? "public" : "private";
  return value === "private" ? "private" : "public";
}

export function isPublicMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return authMode(env) === "public";
}
