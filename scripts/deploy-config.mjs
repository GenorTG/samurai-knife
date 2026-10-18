// Fail-closed deployment checks, run by scripts/serve.mjs before Next starts (docs/DEPLOY.md "Startup checks").
// Threat model: a deploy that loses or mistypes one variable must not quietly become insecure. Public mode without a
// trusted proxy buckets every client as the proxy (one attacker locks out everyone) and never marks cookies Secure; public
// mode without its public URL builds mail links from the bind address; a lost KNIFE_AUTH_MODE on a public host would make
// the passwordless default account everyone's identity; a private install bound to or accepting a public name or address
// is the same exposure. Errors stop the server (exit 2); warnings are printed. No dependencies; tests/deploy_config.test.mjs.
//
// The mode rule (audit M4, E5): KNIFE_PUBLIC_URL is the mark of a public deploy, but private installs set it too, to
// register the GitHub App (docs/GITHUB.md: GitHub only ever sees the public URL). So an EMPTY mode with KNIFE_PUBLIC_URL is
// ambiguous and refused (a public deploy that lost its mode must not start private; src/lib/accounts/mode.ts treats it as
// public when started another way), while an EXPLICIT `KNIFE_AUTH_MODE=private` with KNIFE_PUBLIC_URL starts, with a
// warning. A private install never binds or allows a public host.
import { addressScope, parseRule } from "../src/lib/net/client-ip.mjs";

/** Host names that only resolve inside a private network (MagicDNS short names, mDNS, home/LAN zones). */
const PRIVATE_NAME = /^(?:localhost|[a-z0-9-]+|[a-z0-9.-]+\.(?:ts\.net|local|lan|home\.arpa|internal|localhost|localdomain))$/i;

const split = (value) => String(value ?? "").split(",").map((part) => part.trim()).filter(Boolean);

/** "private" when `host` (an IP literal or a name) is loopback, Tailscale, LAN-private or a private-network name. */
export function hostScope(host) {
  const bare = String(host).trim().replace(/^\[|\]$/g, "").toLowerCase();
  const scope = addressScope(bare);
  if (scope) return scope === "public" ? "public" : "private";
  return PRIVATE_NAME.test(bare) ? "private" : "public";
}

/**
 * {errors, warnings} for an environment. `mode` = the effective auth mode ("private" | "public") serve.mjs resolved.
 * @param {Record<string, string | undefined>} env
 * @param {"private" | "public"} mode
 */
export function deployProblems(env, mode) {
  const errors = [];
  const warnings = [];
  const publicUrl = env.KNIFE_PUBLIC_URL?.trim() ?? "";
  const explicitMode = env.KNIFE_AUTH_MODE?.trim() ?? "";

  if (mode === "public") {
    if (!publicUrl) errors.push("public mode needs KNIFE_PUBLIC_URL (the https address users open): mail links, cookies and the Host guard depend on it.");
    else {
      let url = null;
      try {
        url = new URL(publicUrl);
      } catch {
        errors.push(`KNIFE_PUBLIC_URL=${publicUrl} is not a URL.`);
      }
      // Plain http only on a loopback/Tailscale/LAN address literal (test servers); a name or a public address needs https.
      const scope = url ? addressScope(url.hostname.replace(/^\[|\]$/g, "")) : null;
      if (url && url.protocol !== "https:" && !(url.protocol === "http:" && scope !== null && scope !== "public")) {
        errors.push(`KNIFE_PUBLIC_URL must be https in public mode (plain http only on a loopback/private address, for tests); got ${url.protocol}//${url.host}.`);
      }
    }
    const rules = split(env.KNIFE_TRUSTED_PROXIES);
    if (rules.length === 0) {
      errors.push("public mode needs KNIFE_TRUSTED_PROXIES (the reverse proxy's address): without it every client looks like the proxy, so one abuser trips the limits for everyone and cookies are never Secure.");
    }
    for (const rule of rules) {
      const parsed = parseRule(rule);
      if (!parsed) {
        errors.push(`KNIFE_TRUSTED_PROXIES entry "${rule}" is not an IP address or CIDR.`);
        continue;
      }
      const width = parsed.family === 4 ? 32 : 128;
      const floor = parsed.family === 4 ? 16 : 48;
      if (parsed.bits < floor) {
        errors.push(`KNIFE_TRUSTED_PROXIES entry "${rule}" is wider than /${floor}: every host in it could forge X-Forwarded-For. List the proxy's own address.`);
      } else if (parsed.bits < width) {
        warnings.push(`KNIFE_TRUSTED_PROXIES entry "${rule}" trusts a whole network: any container or host in it can forge X-Forwarded-For. Prefer the proxy's single address (/${width}).`);
      }
    }
    if (env.KNIFE_ABUSE_GUARD?.trim().toLowerCase() === "off") errors.push("KNIFE_ABUSE_GUARD=off is not allowed in public mode.");
  } else {
    if (publicUrl && !explicitMode) {
      errors.push("KNIFE_PUBLIC_URL is set but KNIFE_AUTH_MODE is not: set KNIFE_AUTH_MODE=public for a public deploy (a lost mode must never make the passwordless account everyone's identity), or KNIFE_AUTH_MODE=private for a private install that only uses KNIFE_PUBLIC_URL for the GitHub App (docs/DEPLOY.md \"Startup checks\").");
    } else if (publicUrl) {
      let name = publicUrl;
      try {
        name = new URL(publicUrl).hostname;
      } catch {
        // shown as given
      }
      warnings.push(`private mode with KNIFE_PUBLIC_URL (${name}): the Host guard accepts that name, so no proxy may route it to this server while the default account has no password (docs/DEPLOY.md "Startup checks").`);
    }
    const hosts = [
      ["KNIFE_HOST", split(env.KNIFE_HOST)],
      ["KNIFE_ALLOWED_HOSTS", split(env.KNIFE_ALLOWED_HOSTS)],
      ["KNIFE_MCP_ALLOWED_HOSTS", split(env.KNIFE_MCP_ALLOWED_HOSTS)],
    ];
    for (const [name, list] of hosts) {
      for (const host of list) {
        if (hostScope(host) === "public") {
          errors.push(`${name} contains "${host}", which is not loopback, Tailscale or a private-network name/address: private mode has a passwordless account, so it must only be reachable inside a private network. Use public mode for a public name.`);
        }
      }
    }
  }
  return { errors, warnings };
}
