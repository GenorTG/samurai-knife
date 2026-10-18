import { createHash, createHmac } from "node:crypto";
import { bearerToken, JwtError, signJwt, verifyJwt, type JwtPayload } from "@/lib/jwt-hs256";
import { accountUsable } from "@/lib/accounts/session";
import { getAccount, type Account } from "@/lib/accounts/store";
import { readSecret } from "@/lib/services/state";

/**
 * Every token between the app, the browser and the office Document Server (DS), one key or one claim shape per kind.
 *
 * Threat: one per-install secret (the DS's JWT_SECRET) used to sign everything, so a token the browser sees (the editor
 * config, the capability URLs inside it) also passed as the DS's own Bearer token on the two guard-less routes
 * (/api/office/ds/file, /callback), never expired, and outlived the account. Now:
 *  - capability (`t` in the DS URLs, account + document + purpose + account epoch): key HMAC(secret, capability
 *    context), so it is never a DS token and no DS token is a capability; dropped when the account is disabled,
 *    deleted or re-registered (epoch = account id + creation time);
 *  - editor config (browser -> DS inbox): the raw secret, because the DS verifies it; `exp` set; it has no `payload`
 *    and no `status`, so it is refused as either DS token form below;
 *  - DS outbox (DS -> app): the raw secret, as the DS signs it; the header form must wrap the request in `payload`
 *    and expire, the callback body form must carry `key` + `status` and expire;
 *  - proxy tickets (proxy.ts) use their own HMAC-derived key.
 */

export const OFFICE_SERVICE = "office";
const FILE_TOKEN_TTL_SEC = 24 * 3600;
const CALLBACK_TOKEN_TTL_SEC = 30 * 24 * 3600;
/**
 * The DS checks the config token when an editor opens (and again when it reconnects): a session left open longer than
 * this has to reload the page. Matches the file capability's lifetime, after which the config cannot open anything.
 */
export const EDITOR_TOKEN_TTL_SEC = 24 * 3600;
const CAPABILITY_CONTEXT = "knife-office-capability-v1";

export class OfficeUnavailableError extends Error {}

export function officeSecret(): string {
  const secret = readSecret(OFFICE_SERVICE, "JWT_SECRET");
  if (!secret) throw new OfficeUnavailableError("the office sidecar is not installed");
  return secret;
}

function capabilityKey(secret = officeSecret()): string {
  return createHmac("sha256", secret).update(CAPABILITY_CONTEXT).digest("hex");
}

/** Changes when an account id is deleted and registered again; an old capability then names someone else. */
export function accountEpoch(account: Pick<Account, "id" | "createdAt">): string {
  return createHash("sha256").update(`${account.id}\n${account.createdAt ?? ""}`).digest("base64url").slice(0, 16);
}

export type DsPurpose = "file" | "callback";

export interface DsCapability {
  acc: string;
  doc: string;
  use: DsPurpose;
  /** `accountEpoch` of the account when the token was made. */
  ep: string;
}

export function capabilityToken(account: Pick<Account, "id" | "createdAt">, doc: string, use: DsPurpose): string {
  const claims: DsCapability = { acc: account.id, doc, use, ep: accountEpoch(account) };
  return signJwt({ ...claims }, capabilityKey(), { expiresInSec: use === "file" ? FILE_TOKEN_TTL_SEC : CALLBACK_TOKEN_TTL_SEC });
}

export function readCapability(token: string | null, use: DsPurpose): DsCapability {
  if (!token) throw new JwtError("missing capability token");
  const claims = verifyJwt(token, capabilityKey());
  if (claims.use !== use || typeof claims.acc !== "string" || typeof claims.doc !== "string" || typeof claims.ep !== "string") {
    throw new JwtError("wrong capability token");
  }
  return { acc: claims.acc, doc: claims.doc, use, ep: claims.ep };
}

/** The account a capability names, only while it may act and is the same account the token was made for. */
export function capabilityAccount(cap: DsCapability): Account {
  const account = getAccount(cap.acc);
  if (!account || !accountUsable(account) || accountEpoch(account) !== cap.ep) throw new JwtError("capability no longer valid");
  return account;
}

/** The editor config as the DS expects it: signed with the shared secret, expiring. */
export function editorConfigToken(config: JwtPayload): string {
  return signJwt(config, officeSecret(), { expiresInSec: EDITOR_TOKEN_TTL_SEC });
}

function isObject(value: unknown): value is JwtPayload {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The DS's outgoing token (JWT_ENABLED outbox): `Authorization: Bearer <jwt>` whose claims wrap the request in
 * `payload`, or, on callbacks, `token` in the body whose claims ARE the callback (key, status, ...). Both expire (the
 * DS sets `exp`). Returns the signed request. An editor config or a capability is refused in either place.
 */
export function readServerToken(request: Request, bodyToken?: unknown): JwtPayload {
  const secret = officeSecret();
  if (typeof bodyToken === "string" && bodyToken) {
    const claims = verifyJwt(bodyToken, secret);
    if (typeof claims.exp !== "number" || typeof claims.status !== "number" || typeof claims.key !== "string" || "document" in claims || "editorConfig" in claims) {
      throw new JwtError("not a Document Server callback token");
    }
    return claims;
  }
  const header = bearerToken(request.headers.get("authorization"));
  if (!header) throw new JwtError("missing Document Server token");
  const claims = verifyJwt(header, secret);
  if (typeof claims.exp !== "number" || !isObject(claims.payload)) throw new JwtError("not a Document Server token");
  return claims.payload;
}

export interface DsRequest {
  account: Account;
  cap: DsCapability;
  /** The DS-signed request (callback status fields come from here only). */
  signed: JwtPayload;
}

/**
 * The one check both DS routes run: the capability (cheap HMAC) first, then the DS token, then the account. Throws
 * JwtError (-> 403) on any failure, with no detail about the account.
 */
export function authorizeDsRequest(request: Request, use: DsPurpose, bodyToken?: unknown): DsRequest {
  const cap = readCapability(new URL(request.url).searchParams.get("t"), use);
  const signed = readServerToken(request, bodyToken);
  return { account: capabilityAccount(cap), cap, signed };
}
