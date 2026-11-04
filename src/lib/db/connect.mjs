// Connection settings for the core Postgres database (docs/DB-POSTGRES.md "Connection"). Plain .mjs: shared by the app
// (src/lib/db/pool.ts), scripts/db-migrate.mjs, scripts/db-import.mjs and the accounts CLI. No dependencies.
//
// KNIFE_DB_URL        postgres://user:password@host:port/db[?sslmode=verify-full&sslrootcert=/path/ca.pem]  (unset = files)
// KNIFE_DB_CA_FILE    CA certificate for verify-full (instead of sslrootcert in the URL)
// KNIFE_DB_ALLOW_PLAINTEXT=1  allow a non-TLS connection to a non-loopback host (never in production)
//
// TLS is required for every host that is not loopback or a Unix socket: the primary is on another machine (35 ms away),
// so credentials and rows cross a network. sslmode=require (encryption without verifying the server) is accepted with a
// warning; verify-full is the documented setting.
import { readFileSync } from "node:fs";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const TLS_PARAMS = ["sslmode", "sslrootcert", "sslcert", "sslkey", "ssl", "uselibpqcompat"];

/** @param {Record<string, string | undefined>} env */
export function dbUrl(env = process.env) {
  const value = env.KNIFE_DB_URL?.trim();
  return value ? value : null;
}

/**
 * pg.Client / pg.Pool options for KNIFE_DB_URL. Throws (refuse to start) on a plaintext connection to a remote host.
 * @param {Record<string, string | undefined>} env
 * @param {{ applicationName?: string }} [options]
 * @returns {{ connectionString: string, ssl: false | { rejectUnauthorized: boolean, ca?: string, servername?: string }, keepAlive: boolean, keepAliveInitialDelayMillis: number, connectionTimeoutMillis: number, statement_timeout: number, query_timeout: number, idle_in_transaction_session_timeout: number, application_name: string, warnings: string[] }}
 */
export function connectionOptions(env = process.env, options = {}) {
  const raw = dbUrl(env);
  if (!raw) throw new Error("KNIFE_DB_URL is not set");
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("KNIFE_DB_URL is not a valid postgres:// URL");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") throw new Error("KNIFE_DB_URL must start with postgres://");
  const mode = (url.searchParams.get("sslmode") ?? "").toLowerCase();
  const rootCert = url.searchParams.get("sslrootcert") || env.KNIFE_DB_CA_FILE?.trim() || "";
  for (const name of TLS_PARAMS) url.searchParams.delete(name);
  const host = decodeURIComponent(url.hostname || url.searchParams.get("host") || "");
  const local = host === "" || host.startsWith("/") || LOOPBACK.has(host.toLowerCase());
  const warnings = [];
  /** @type {false | { rejectUnauthorized: boolean, ca?: string, servername?: string }} */
  let ssl = false;
  if (mode === "verify-full" || mode === "verify-ca") {
    ssl = { rejectUnauthorized: true, ...(rootCert ? { ca: readFileSync(rootCert, "utf8") } : {}) };
  } else if (mode === "require" || mode === "prefer") {
    ssl = { rejectUnauthorized: false };
    if (!local) warnings.push("KNIFE_DB_URL uses sslmode=require: encrypted but the server certificate is not verified; use sslmode=verify-full");
  } else if (mode === "" || mode === "disable" || mode === "allow") {
    if (!local && env.KNIFE_DB_ALLOW_PLAINTEXT?.trim() !== "1") {
      throw new Error(`KNIFE_DB_URL points at ${host} without TLS: add sslmode=verify-full (and sslrootcert or KNIFE_DB_CA_FILE)`);
    }
  } else {
    throw new Error(`KNIFE_DB_URL has an unknown sslmode=${mode}`);
  }
  return {
    connectionString: url.toString(),
    ssl,
    // The primary is a WAN hop away: keep connections open and the TCP path warm instead of reconnecting (TLS handshake
    // = 2-3 extra round trips).
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    connectionTimeoutMillis: Number(env.KNIFE_DB_CONNECT_TIMEOUT_MS) || 5_000,
    statement_timeout: Number(env.KNIFE_DB_STATEMENT_TIMEOUT_MS) || 10_000,
    query_timeout: Number(env.KNIFE_DB_QUERY_TIMEOUT_MS) || 15_000,
    idle_in_transaction_session_timeout: 10_000,
    application_name: options.applicationName ?? "samurai-knife",
    warnings,
  };
}

/** Same options without the `warnings` field (what pg accepts). */
export function pgConfig(env = process.env, options = {}) {
  const { warnings, ...config } = connectionOptions(env, options);
  for (const warning of warnings) console.warn(`[db] ${warning}`);
  return config;
}
