import { createPrivateKey, createSign } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import * as z from "zod/v4";
import { dataDir, writePrivateFile } from "@/lib/accounts/store";

/**
 * The server's GitHub App (docs/GITHUB.md): created once by an admin through GitHub's manifest flow, then used for
 * "Sign in with GitHub" (its OAuth client) and for repository access through installations (short-lived installation
 * tokens, nothing per user stored). The credentials are server secrets: a 0600 JSON file at KNIFE_GITHUB_APP_FILE
 * (absolute; share it between servers, keep it out of backups of the data dir) or `$KNIFE_DATA_DIR/github-app.json`.
 */

export const GITHUB_WEB = (): string => (process.env.KNIFE_GITHUB_WEB_URL?.trim() || "https://github.com").replace(/\/+$/, "");

const appSchema = z.object({
  appId: z.number().int().positive(),
  slug: z.string().min(1).max(100),
  name: z.string().max(100),
  clientId: z.string().min(1).max(100),
  clientSecret: z.string().min(1).max(200),
  pem: z.string().min(100).max(10_000),
  webhookSecret: z.string().max(200).default(""),
  owner: z.string().max(100).default(""),
  htmlUrl: z.string().max(300).default(""),
  createdAt: z.string(),
});
export type GithubAppConfig = z.infer<typeof appSchema>;

export function appFile(): string {
  const configured = process.env.KNIFE_GITHUB_APP_FILE?.trim();
  if (configured) {
    if (!isAbsolute(configured)) throw new Error("KNIFE_GITHUB_APP_FILE must be an absolute path");
    return configured;
  }
  return join(dataDir(), "github-app.json");
}

let cache: { path: string; mtimeMs: number; app: GithubAppConfig } | null = null;

export function loadApp(): GithubAppConfig | null {
  const path = appFile();
  if (!existsSync(path)) return null;
  const mtimeMs = statSync(path).mtimeMs;
  if (cache?.path === path && cache.mtimeMs === mtimeMs) return cache.app;
  const app = appSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  cache = { path, mtimeMs, app };
  return app;
}

export function saveApp(app: GithubAppConfig): void {
  const path = appFile();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writePrivateFile(path, `${JSON.stringify(appSchema.parse(app), null, 2)}\n`);
  cache = null;
}

/** Forget the local credentials (the app itself stays on GitHub until its owner deletes it there). */
export function forgetApp(): boolean {
  const path = appFile();
  if (!existsSync(path)) return false;
  rmSync(path);
  cache = null;
  return true;
}

export function appStatus() {
  const app = loadApp();
  if (!app) return { configured: false as const };
  return {
    configured: true as const,
    appId: app.appId,
    slug: app.slug,
    name: app.name,
    owner: app.owner,
    htmlUrl: app.htmlUrl,
    installUrl: `${GITHUB_WEB()}/apps/${app.slug}/installations/new`,
    settingsUrl: app.owner ? `${GITHUB_WEB()}/settings/apps/${app.slug}` : app.htmlUrl,
    createdAt: app.createdAt,
  };
}

function b64url(data: Buffer | string): string {
  return Buffer.from(data).toString("base64url");
}

/** The app's own JWT (RS256, 9 minutes, issuer = client id): only for /app/* calls, e.g. minting installation tokens. */
export function appJwt(app: GithubAppConfig, now = Date.now()): string {
  const seconds = Math.floor(now / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  // iat 60 s in the past absorbs clock drift (GitHub's recommendation); exp at most 10 min ahead.
  const payload = b64url(JSON.stringify({ iat: seconds - 60, exp: seconds + 540, iss: app.clientId }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${b64url(signer.sign(createPrivateKey(app.pem)))}`;
}
