/**
 * KNIFE_AUTH_MODE: `private` (default) = the owner-only toolbox behind a loopback/Tailscale bind, the passwordless default
 * account is the implicit identity and accounts are made with `npm run accounts` only. `public` = multi-user: registration with
 * a verified email, every request needs a session, no default-account fallback anywhere. docs/ACCOUNTS.md.
 *
 * Fails closed: any value other than empty/`private` means public (a typo must never expose the passwordless account);
 * scripts/serve.mjs refuses to start with an unknown value, so this only matters when the app is started some other way.
 */
export type AuthMode = "private" | "public";

export function authMode(env: NodeJS.ProcessEnv = process.env): AuthMode {
  const value = env.KNIFE_AUTH_MODE?.trim().toLowerCase();
  return !value || value === "private" ? "private" : "public";
}

export function isPublicMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return authMode(env) === "public";
}
