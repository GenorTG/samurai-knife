import { randomBytes } from "node:crypto";
import { apiJson } from "@/lib/site/net";
import { GITHUB_API } from "@/lib/site/github";
import { GITHUB_WEB, saveApp, type GithubAppConfig } from "./config";

/**
 * GitHub's manifest flow (https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest):
 * the admin's browser POSTs this manifest to github.com, the admin confirms, GitHub redirects back with a one-time code
 * (valid one hour), and the server exchanges it for the app id, client id/secret and private key.
 */

export const APP_PERMISSIONS = {
  // Repository: read and change files, open pull requests; see checks, statuses and preview deployments.
  contents: "write",
  pull_requests: "write",
  metadata: "read",
  statuses: "read",
  deployments: "read",
  checks: "read",
  // The Pages domain proves a website belongs to the repository (src/lib/site/ownership.ts).
  pages: "read",
  // Account: the verified email for "Sign in with GitHub" (GET /user/emails). The manifest takes GitHub's internal resource
  // name `emails`; `email_addresses` (the name in installation/token API responses) is refused by GitHub's manifest check
  // ("Default permission records resource is not included in the list").
  emails: "read",
} as const;

export function callbackPaths(base: string) {
  return {
    redirect: `${base}/api/github/app-created`,
    callback: `${base}/api/github/callback`,
    setup: `${base}/api/github/setup`,
    webhook: `${base}/api/github/webhook`,
  };
}

/**
 * The one address GitHub talks to: KNIFE_PUBLIC_URL (origin only). The app's redirect, callback and setup URLs all use
 * it; a server without one cannot create or use the app (private Tailscale/LAN addresses are never registered).
 */
export function publicBase(): string | null {
  const raw = (process.env.KNIFE_PUBLIC_URL ?? "").trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return /^https?:$/.test(url.protocol) ? url.origin : null;
  } catch {
    return null;
  }
}

/** Callback URLs to register: the public URL, plus KNIFE_GITHUB_EXTRA_BASES (comma list, empty by default). Max 10. */
export function callbackBases(): string[] {
  const pub = publicBase();
  const extra = (process.env.KNIFE_GITHUB_EXTRA_BASES ?? "").split(",").map((b) => b.trim().replace(/\/+$/, "")).filter((b) => /^https?:\/\/[^/]+$/.test(b));
  return [...new Set([...(pub ? [pub] : []), ...extra])].slice(0, 10);
}

const KEY = Symbol.for("samurai-knife.github-manifest-states.v1");
function states(): Map<string, { accountId: string; createdAt: number }> {
  const g = globalThis as unknown as Record<symbol, Map<string, { accountId: string; createdAt: number }> | undefined>;
  return (g[KEY] ??= new Map());
}

export function buildManifest(accountId: string, options: { name?: string; org?: string } = {}) {
  const base = publicBase();
  if (!base) throw new Error("set KNIFE_PUBLIC_URL (the public address GitHub sends users back to) before creating the GitHub App");
  const now = Date.now();
  for (const [s, v] of states()) if (now - v.createdAt > 60 * 60_000) states().delete(s);
  const state = randomBytes(24).toString("base64url");
  states().set(state, { accountId, createdAt: now });
  const paths = callbackPaths(base);
  const manifest = {
    name: (options.name?.trim() || "Smart Knife").slice(0, 34),
    // Shown publicly on the app's GitHub page: KNIFE_GITHUB_APP_HOMEPAGE (e.g. your site), else the public URL, else this server.
    url: (process.env.KNIFE_GITHUB_APP_HOMEPAGE ?? "").trim() || base,
    description: "Smart Knife website studio: reads your website's repository, prepares changes as pull requests you review and merge, and lets you sign in with GitHub.",
    // No events are used; GitHub requires a hook URL in the object, the hook stays inactive.
    hook_attributes: { url: paths.webhook, active: false },
    redirect_url: paths.redirect,
    callback_urls: callbackBases().map((b) => callbackPaths(b).callback),
    setup_url: paths.setup,
    setup_on_update: true,
    public: true,
    default_permissions: APP_PERMISSIONS,
    default_events: [],
  };
  const org = options.org?.trim();
  if (org && !/^[A-Za-z0-9-]{1,39}$/.test(org)) throw new Error("invalid organization name");
  const target = org ? `${GITHUB_WEB()}/organizations/${org}/settings/apps/new` : `${GITHUB_WEB()}/settings/apps/new`;
  return { postUrl: `${target}?state=${state}`, manifest, state };
}

/** One-time: the manifest state must have been made by the same admin, within the hour. */
export function takeManifestState(state: string | null, accountId: string): boolean {
  if (!state) return false;
  const entry = states().get(state);
  states().delete(state);
  return !!entry && entry.accountId === accountId && Date.now() - entry.createdAt <= 60 * 60_000;
}

export async function exchangeManifestCode(code: string): Promise<GithubAppConfig> {
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(code)) throw new Error("invalid manifest code");
  const res = await apiJson(`${GITHUB_API()}/app-manifests/${code}/conversions`, { method: "POST", body: {} });
  const b = (res.body ?? {}) as Record<string, unknown>;
  if (res.status !== 201 && res.status !== 200) throw new Error(`GitHub refused the app registration code (${String(b.message ?? `HTTP ${res.status}`).slice(0, 200)}); start again (codes expire after an hour)`);
  const owner = ((b.owner ?? {}) as Record<string, unknown>).login;
  const app: GithubAppConfig = {
    appId: Number(b.id),
    slug: String(b.slug ?? ""),
    name: String(b.name ?? ""),
    clientId: String(b.client_id ?? ""),
    clientSecret: String(b.client_secret ?? ""),
    pem: String(b.pem ?? ""),
    webhookSecret: String(b.webhook_secret ?? ""),
    owner: String(owner ?? ""),
    htmlUrl: String(b.html_url ?? ""),
    createdAt: new Date().toISOString(),
  };
  saveApp(app);
  return app;
}
