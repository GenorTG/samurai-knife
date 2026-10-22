/** Transform node implementations (metadata: src/lib/workflows/catalog/data.ts). */
import { createHash, createHmac, createPrivateKey, createPublicKey, createSign, createVerify, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { marked } from "marked";
import { SANDBOX_PRELUDE } from "../engine/prelude";
import { NodeError, type NodeImpl } from "../engine/node-api";
import { isPlainObject, jsonParam, setPath } from "./util";

const DATE_OPS = String.raw`
globalThis.__dateOp = (a) => {
  const parse = (v, label) => {
    if (v instanceof DateTime) return v;
    if (typeof v === "number") return DateTime.fromMillis(v < 1e11 ? v * 1000 : v);
    if (typeof v === "string" && v.trim()) { const d = DateTime.fromISO(v.trim()); if (d.isValid) return d; }
    if (v && typeof v === "object" && typeof v.ts === "number") return DateTime.fromMillis(v.ts);
    throw new Error("The " + label + " " + JSON.stringify(v) + " is not a date.");
  };
  const fmt = (d) => (a.format ? d.toFormat(a.format) : d.toISO());
  switch (a.operation) {
    case "getCurrentDate": return fmt(DateTime.now());
    case "addToDate": return parse(a.date, "date").plus({ [a.unit]: Number(a.amount) }).toISO();
    case "subtractFromDate": return parse(a.date, "date").minus({ [a.unit]: Number(a.amount) }).toISO();
    case "formatDate": return fmt(parse(a.date, "date"));
    case "roundDate": { const d = parse(a.date, "date"); return (a.roundMode === "roundUp" ? d.endOf(a.unit) : d.startOf(a.unit)).toISO(); }
    case "getTimeBetweenDates": return parse(a.endDate, "end date").diff(parse(a.date, "date"), a.unit).as();
    case "extractDate": {
      const d = parse(a.date, "date");
      if (a.part === "week") {
        const t = new Date(Date.UTC(d.year, d.month - 1, d.day));
        const day = t.getUTCDay() || 7;
        t.setUTCDate(t.getUTCDate() + 4 - day);
        return Math.ceil(((t - Date.UTC(t.getUTCFullYear(), 0, 1)) / 86400000 + 1) / 7);
      }
      return d[a.part];
    }
  }
  throw new Error("Unknown operation " + a.operation);
};
`;

const dateTimeNode: NodeImpl = {
  type: "core.date-time",
  async execute(ctx) {
    const box = await ctx.openSandbox({ timeoutMs: 5_000 });
    try {
      box.setJson("__data", { items: [], nodes: {}, meta: { now: ctx.now(), tzOffset: ctx.tzOffsetMinutes, runIndex: 0, workflow: {}, execution: {} } });
      box.exec(SANDBOX_PRELUDE);
      box.exec(DATE_OPS);
      return [
        ctx.items.map((item, index) => {
          const args = {
            operation: ctx.param("operation", index),
            date: ctx.param("date", index),
            endDate: ctx.param("endDate", index),
            amount: ctx.param("amount", index),
            unit: ctx.param("unit", index),
            roundMode: ctx.param("roundMode", index),
            format: ctx.param("format", index),
            part: ctx.param("part", index),
          };
          box.setJson("__args", args);
          let value: unknown;
          try {
            value = box.run("__dateOp(__args)");
          } catch (error) {
            throw new NodeError(error instanceof Error ? error.message.replace(/^Error: /, "") : String(error), { itemIndex: index });
          }
          const json = { ...item.json };
          setPath(json, String(ctx.param("outputField", index) || "date"), value);
          return { ...item, json, pairedItem: index };
        }),
      ];
    } finally {
      box.dispose();
    }
  },
};

const HASHES: Record<string, string> = { MD5: "md5", SHA1: "sha1", SHA256: "sha256", SHA384: "sha384", SHA512: "sha512", "SHA3-256": "sha3-256", "SHA3-512": "sha3-512" };
const ASCII = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

const cryptoNode: NodeImpl = {
  type: "core.crypto",
  async execute(ctx) {
    return [
      ctx.items.map((item, index) => {
        const action = ctx.param<string>("action", index);
        const encoding = ctx.param<"hex" | "base64">("encoding", index) === "base64" ? "base64" : "hex";
        const value = String(ctx.param("value", index) ?? "");
        let result: string;
        if (action === "hash" || action === "hmac") {
          const algorithm = HASHES[ctx.param<string>("type", index)];
          if (!algorithm) throw new NodeError("Unknown hash algorithm.");
          result = action === "hash" ? createHash(algorithm).update(value).digest(encoding) : createHmac(algorithm, String(ctx.param("secret", index) ?? "")).update(value).digest(encoding);
        } else if (action === "sign") {
          const algorithm = ctx.param<string>("algorithm", index);
          try {
            const key = createPrivateKey(String(ctx.param("privateKey", index) ?? ""));
            const signer = createSign(algorithm === "ECDSA-SHA256" ? "SHA256" : algorithm);
            signer.update(value);
            result = signer.sign(key, encoding);
          } catch (error) {
            throw new NodeError(`Could not sign: ${error instanceof Error ? error.message : String(error)}`, { itemIndex: index });
          }
        } else {
          const kind = ctx.param<string>("generate", index);
          const length = Math.max(1, Math.min(4096, Math.floor(Number(ctx.param("length", index)) || 32)));
          if (kind === "uuid") result = randomUUID();
          else if (kind === "hex") result = randomBytes(Math.ceil(length / 2)).toString("hex").slice(0, length);
          else if (kind === "base64") result = randomBytes(Math.ceil((length * 3) / 4)).toString("base64").slice(0, length);
          else result = Array.from({ length }, () => ASCII[randomInt(ASCII.length)]).join("");
        }
        const json = { ...item.json };
        setPath(json, String(ctx.param("dataPropertyName", index) || "data"), result);
        return { ...item, json, pairedItem: index };
      }),
    ];
  },
};

const b64url = (data: Buffer | string) => Buffer.from(data).toString("base64url");
const JWT_ALGS = new Set(["HS256", "HS384", "HS512", "RS256", "RS384", "RS512", "ES256"]);

function jwtKey(data: Record<string, unknown>) {
  const algorithm = String(data.algorithm ?? "HS256");
  if (!JWT_ALGS.has(algorithm)) throw new NodeError(`JWT algorithm ${algorithm} is not supported.`);
  return { algorithm, secret: String(data.secret ?? ""), privateKey: String(data.privateKey ?? ""), publicKey: String(data.publicKey ?? "") };
}

function jwtSign(input: string, key: ReturnType<typeof jwtKey>): Buffer {
  const bits = key.algorithm.slice(2);
  if (key.algorithm.startsWith("HS")) {
    if (!key.secret) throw new NodeError("The JWT credential has no secret.");
    return createHmac(`sha${bits}`, key.secret).update(input).digest();
  }
  if (!key.privateKey) throw new NodeError("The JWT credential has no private key.");
  const signer = createSign(`SHA${bits}`);
  signer.update(input);
  return signer.sign({ key: createPrivateKey(key.privateKey), ...(key.algorithm.startsWith("ES") ? { dsaEncoding: "ieee-p1363" as const } : {}) });
}

function jwtVerify(input: string, signature: Buffer, key: ReturnType<typeof jwtKey>): boolean {
  const bits = key.algorithm.slice(2);
  if (key.algorithm.startsWith("HS")) {
    const expected = createHmac(`sha${bits}`, key.secret).update(input).digest();
    return expected.length === signature.length && timingSafeEqual(expected, signature);
  }
  const material = key.publicKey || key.privateKey;
  if (!material) throw new NodeError("The JWT credential has no public key.");
  const verifier = createVerify(`SHA${bits}`);
  verifier.update(input);
  return verifier.verify({ key: createPublicKey(material), ...(key.algorithm.startsWith("ES") ? { dsaEncoding: "ieee-p1363" as const } : {}) }, signature);
}

function jwtDecode(token: string) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new NodeError("That is not a JWT (it needs three dot-separated parts).");
  try {
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as Record<string, unknown>;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as unknown;
    return { header, payload, signature: parts[2], parts };
  } catch {
    throw new NodeError("The JWT's header or payload is not valid JSON.");
  }
}

const jwtNode: NodeImpl = {
  type: "core.jwt",
  async execute(ctx) {
    const operation = ctx.param<string>("operation");
    const credential = operation === "decode" ? null : await ctx.credential("jwt");
    const key = credential ? jwtKey(credential.data) : null;
    return [
      ctx.items.map((item, index) => {
        const json = { ...item.json };
        const field = String(ctx.param("outputField", index) || "token");
        if (operation === "sign" && key) {
          const claims = jsonParam(ctx.param("claims", index), "Payload");
          if (!isPlainObject(claims)) throw new NodeError("The payload must be a JSON object.");
          const now = Math.floor(ctx.now() / 1000);
          const expires = Math.max(0, Math.floor(Number(ctx.param("expiresIn", index)) || 0));
          const payload = { iat: now, ...claims, ...(expires ? { exp: now + expires } : {}) };
          const input = `${b64url(JSON.stringify({ alg: key.algorithm, typ: "JWT" }))}.${b64url(JSON.stringify(payload))}`;
          setPath(json, field, `${input}.${b64url(jwtSign(input, key))}`);
        } else {
          const token = String(ctx.param("token", index) ?? "").trim();
          const decoded = jwtDecode(token);
          if (operation === "verify" && key) {
            if (decoded.header.alg !== key.algorithm) throw new NodeError(`The token is signed with ${String(decoded.header.alg)}, the credential expects ${key.algorithm}.`, { itemIndex: index });
            if (!jwtVerify(`${decoded.parts[0]}.${decoded.parts[1]}`, Buffer.from(decoded.signature, "base64url"), key)) throw new NodeError("The token's signature is not valid.", { itemIndex: index });
            const claims = isPlainObject(decoded.payload) ? decoded.payload : {};
            const now = ctx.now() / 1000;
            if (typeof claims.exp === "number" && now > claims.exp + 30) throw new NodeError("The token has expired.", { itemIndex: index });
            if (typeof claims.nbf === "number" && now + 30 < claims.nbf) throw new NodeError("The token is not valid yet.", { itemIndex: index });
            setPath(json, field, decoded.payload);
          } else {
            setPath(json, field, { header: decoded.header, payload: decoded.payload, signature: decoded.signature });
          }
        }
        return { ...item, json, pairedItem: index };
      }),
    ];
  },
};

function base32Decode(input: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = input.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = alphabet.indexOf(char);
    if (index < 0) throw new NodeError("The TOTP secret is not valid base32.");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function totpCode(secret: string, nowMs: number, digits = 6, period = 30, algorithm = "SHA1"): { token: string; secondsRemaining: number } {
  const counter = Math.floor(nowMs / 1000 / period);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac(algorithm.toLowerCase(), base32Decode(secret)).update(buffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return { token: String(code % 10 ** digits).padStart(digits, "0"), secondsRemaining: period - (Math.floor(nowMs / 1000) % period) };
}

const totpNode: NodeImpl = {
  type: "core.totp",
  async execute(ctx) {
    const credential = await ctx.credential("totp");
    const secret = String(credential.data.secret ?? "");
    if (!secret) throw new NodeError("The TOTP credential has no secret.");
    const digits = Math.max(6, Math.min(8, Math.floor(Number(ctx.param("digits")) || 6)));
    const period = Math.max(10, Math.min(120, Math.floor(Number(ctx.param("period")) || 30)));
    const algorithm = ["SHA1", "SHA256", "SHA512"].includes(ctx.param<string>("algorithm")) ? ctx.param<string>("algorithm") : "SHA1";
    const result = totpCode(secret, ctx.now(), digits, period, algorithm);
    return [(ctx.items.length ? ctx.items : [{ json: {} }]).map((item, index) => ({ ...item, json: { ...item.json, ...result }, pairedItem: index }))];
  },
};

const markdownNode: NodeImpl = {
  type: "core.markdown",
  async execute(ctx) {
    return [
      ctx.items.map((item, index) => {
        const html = marked.parse(String(ctx.param("markdown", index) ?? ""), { async: false });
        const json = { ...item.json };
        setPath(json, String(ctx.param("destinationKey", index) || "html"), html);
        return { ...item, json, pairedItem: index };
      }),
    ];
  },
};

export const TRANSFORM_IMPLS: NodeImpl[] = [dateTimeNode, cryptoNode, jwtNode, totpNode, markdownNode];
