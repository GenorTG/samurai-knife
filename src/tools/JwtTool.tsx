"use client";

import { INTL_LOCALE, type Locale } from "@/lib/i18n/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256, sha384, sha512 } from "@noble/hashes/sha2.js";
import { Button, CopyButton, Field, KeyValues, Notice, OutputBlock, Panel, Select, Stat, StatGrid, TextArea, TextInput } from "@/components/ui";
import { useT } from "@/lib/i18n/react";

/**
 * JWT decode / verify / sign. HMAC runs locally, so the secret and token stay
 * in the tab even on HTTP origins where Web Crypto's subtle API is unavailable.
 */

const ALGS = [
  { id: "HS256", hash: "SHA-256" },
  { id: "HS384", hash: "SHA-384" },
  { id: "HS512", hash: "SHA-512" },
] as const;

const HASH_FUNCTIONS = {
  "SHA-256": sha256,
  "SHA-384": sha384,
  "SHA-512": sha512,
} as const;

const SAMPLE_HEADER = { alg: "HS256", typ: "JWT" };
const SAMPLE_PAYLOAD = {
  sub: "genor",
  role: "owner",
  scope: "toolbox",
  iat: 1_761_955_200,
  exp: 1_825_027_200,
};

const CLAIM_LABELS: Record<string, string> = {
  iss: "issuer",
  sub: "subject",
  aud: "audience",
  exp: "expires",
  nbf: "not before",
  iat: "issued at",
  jti: "token id",
};

function b64uEncodeBytes(bytes: Uint8Array): string {
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64uEncodeText(text: string): string {
  return b64uEncodeBytes(new TextEncoder().encode(text));
}

function b64uDecodeText(segment: string): string | null {
  if (!/^[A-Za-z0-9_-]*$/.test(segment)) return null;
  const standard = segment.replace(/-/g, "+").replace(/_/g, "/");
  const padded = standard + "=".repeat((4 - (standard.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

async function hmacSign(algId: string, secret: string, data: string): Promise<string> {
  const hashName = ALGS.find((alg) => alg.id === algId)?.hash ?? "SHA-256";
  const signature = hmac(
    HASH_FUNCTIONS[hashName],
    new TextEncoder().encode(secret),
    new TextEncoder().encode(data),
  );
  return b64uEncodeBytes(signature);
}

function humanDate(seconds: number): string {
  if (!Number.isFinite(seconds)) return "—";
  const stamp = new Date(seconds * 1000);
  if (Number.isNaN(stamp.getTime())) return "—";
  const local = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });
  const utc = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium", timeZone: "UTC" });
  return `${local.format(stamp)} · ${utc.format(stamp)}`;
}

function relTime(seconds: number, now: number, locale: Locale): string {
  const delta = seconds - now;
  const abs = Math.abs(delta);
  const sign = delta >= 0 ? 1 : -1;
  const format = new Intl.RelativeTimeFormat(INTL_LOCALE[locale], { numeric: "always" });
  if (abs < 60) return format.format(sign * Math.round(abs), "second");
  if (abs < 3600) return format.format(sign * Math.round(abs / 60), "minute");
  if (abs < 86_400) return format.format(sign * Math.round(abs / 3600), "hour");
  if (abs < 2_592_000) return format.format(sign * Math.round(abs / 86_400), "day");
  if (abs < 31_536_000) return format.format(sign * Math.round(abs / 2_592_000), "month");
  return format.format(sign * Math.round(abs / 31_536_000), "year");
}

export default function JwtTool() {
  const { t, locale } = useT();
  const [token, setToken] = useState("");
  const [secret, setSecret] = useState("samurai-knife");
  const [headerText, setHeaderText] = useState(JSON.stringify(SAMPLE_HEADER, null, 2));
  const [payloadText, setPayloadText] = useState(JSON.stringify(SAMPLE_PAYLOAD, null, 2));
  const [signAlg, setSignAlg] = useState("HS256");
  const [signed, setSigned] = useState("");
  const [signError, setSignError] = useState<string | null>(null);
  const [verification, setVerification] = useState<{
    key: string;
    verdict: "valid" | "invalid";
  } | null>(null);
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    const update = () => setNow(Date.now() / 1000);
    const initial = setTimeout(update, 0);
    const interval = setInterval(update, 1000);
    return () => {
      clearTimeout(initial);
      clearInterval(interval);
    };
  }, []);

  const loadSample = useCallback(async () => {
    const head = b64uEncodeText(JSON.stringify(SAMPLE_HEADER));
    const body = b64uEncodeText(JSON.stringify(SAMPLE_PAYLOAD));
    try {
      const signature = await hmacSign("HS256", "samurai-knife", `${head}.${body}`);
      setToken(`${head}.${body}.${signature}`);
      setSecret("samurai-knife");
    } catch {
      setToken(`${head}.${body}.`);
    }
  }, []);

  const decoded = useMemo(() => {
    const trimmed = token.trim();
    if (!trimmed) return { ok: false as const, error: "" };
    const parts = trimmed.split(".");
    if (parts.length !== 3) {
      return { ok: false as const, error: t("Expected 3 dot-separated segments, found {parts}.", { parts: parts.length }) };
    }
    const [headRaw, bodyRaw, signature] = parts;
    const headJson = b64uDecodeText(headRaw);
    const bodyJson = b64uDecodeText(bodyRaw);
    if (headJson === null || bodyJson === null) {
      return { ok: false as const, error: "A segment is not valid base64url." };
    }
    let header: unknown;
    let payload: unknown;
    try {
      header = JSON.parse(headJson);
      payload = JSON.parse(bodyJson);
    } catch {
      return { ok: false as const, error: t("Header or payload is not valid JSON.") };
    }
    return {
      ok: true as const,
      header,
      payload,
      signature,
      headRaw,
      bodyRaw,
      headerJson: headJson,
      payloadJson: bodyJson,
    };
  }, [t, token]);

  const headerAlg =
    decoded.ok && typeof decoded.header === "object" && decoded.header !== null
      ? String((decoded.header as Record<string, unknown>).alg ?? "")
      : "";

  const verifiable = ALGS.some((alg) => alg.id === headerAlg);
  const canVerify = decoded.ok && Boolean(decoded.signature) && Boolean(secret) && verifiable;
  const verificationKey = canVerify && decoded.ok
    ? `${decoded.headRaw}.${decoded.bodyRaw}.${decoded.signature}.${secret}`
    : "";
  const verdict = !canVerify
    ? "unknown"
    : verification?.key === verificationKey
      ? verification.verdict
      : "checking";

  useEffect(() => {
    if (!canVerify || !decoded.ok) return;
    let active = true;
    const run = async () => {
      let nextVerdict: "valid" | "invalid";
      try {
        const expected = await hmacSign(headerAlg, secret, `${decoded.headRaw}.${decoded.bodyRaw}`);
        nextVerdict = expected === decoded.signature ? "valid" : "invalid";
      } catch {
        nextVerdict = "invalid";
      }
      if (active) setVerification({ key: verificationKey, verdict: nextVerdict });
    };
    const timer = setTimeout(() => void run(), 150);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [canVerify, decoded, headerAlg, secret, verificationKey]);

  const sign = useCallback(async () => {
    try {
      const header = JSON.parse(headerText) as Record<string, unknown>;
      // The Algorithm select is authoritative: keep header.alg in step so the token verifies.
      if (typeof header === "object" && header !== null && !Array.isArray(header)) header.alg = signAlg;
      const payload = JSON.parse(payloadText) as Record<string, unknown>;
      const head = b64uEncodeText(JSON.stringify(header));
      const body = b64uEncodeText(JSON.stringify(payload));
      const signature = await hmacSign(signAlg, secret, `${head}.${body}`);
      setSigned(`${head}.${body}.${signature}`);
      setSignError(null);
    } catch (exc) {
      setSigned("");
      setSignError(exc instanceof Error ? exc.message : t("Could not sign."));
    }
  }, [t, headerText, payloadText, secret, signAlg]);

  useEffect(() => {
    const timer = setTimeout(() => void sign(), 150);
    return () => clearTimeout(timer);
  }, [sign]);

  const claims: [string, string][] = useMemo(() => {
    if (!decoded.ok) return [];
    const payload = decoded.payload;
    if (typeof payload !== "object" || payload === null) return [];
    const rows: [string, string][] = [];
    for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
      const label = CLAIM_LABELS[key] ?? key;
      const isTime = ["exp", "iat", "nbf"].includes(key);
      const rendered = typeof value === "number" ? String(value) : JSON.stringify(value);
      if (isTime && typeof value === "number") {
        rows.push([`${label} — ${humanDate(value)}`, `${now === null ? "…" : relTime(value, now, locale)} · ${rendered}`]);
      } else {
        rows.push([label, rendered]);
      }
    }
    return rows;
  }, [decoded, now]);

  const expSeconds =
    decoded.ok && typeof decoded.payload === "object" && decoded.payload !== null
      ? Number((decoded.payload as Record<string, unknown>).exp ?? Number("NaN"))
      : Number("NaN");

  const liveBadge = !Number.isFinite(expSeconds) || now === null
    ? null
    : expSeconds < now
      ? { tone: "error" as const, text: t("Expired {expSeconds}.", { expSeconds: relTime(expSeconds, now, locale) }) }
      : { tone: "good" as const, text: t("Valid — expires {when}.", { when: relTime(expSeconds, now, locale) }) };

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel
          title={t("Token")}
          right={
            <div className="flex gap-1.5">
              <Button size="sm" variant="subtle" onClick={async () => await loadSample()}>
                {t("Load sample")}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setToken("")}>
                {t("Clear")}
              </Button>
            </div>
          }
        >
          <div className="space-y-3">
            <Field label={t("Paste a JWT")}>
              <TextArea
                rows={4}
                spellCheck={false}
                value={token}
                onChange={(e) => setToken(e.target.value.trim())}
                placeholder={t("eyJhbGciOi…")}
                className="font-mono text-[12px]"
              />
            </Field>

            {decoded.ok ? (
              <KeyValues
                rows={[
                  ["Header", decoded.headerJson],
                  ["Payload", decoded.payloadJson],
                  ["Signature", decoded.signature || "— none —"],
                  ["Algorithm", headerAlg || "—"],
                ]}
              />
            ) : token ? (
              <Notice tone="error">{decoded.error}</Notice>
            ) : null}

            {decoded.ok ? (
              <div className="space-y-2">
                <OutputBlock value={JSON.stringify(decoded.payload, null, 2)} rows={10} />
                <CopyButton text={JSON.stringify(decoded.payload, null, 2)} label={t("Copy payload")} />
              </div>
            ) : null}
          </div>
        </Panel>

        <Panel title={t("Claims")}>
          <div className="space-y-3">
            {claims.length > 0 ? <KeyValues rows={claims} /> : null}

            {decoded.ok && !verifiable ? (
              <Notice tone="info">
                {headerAlg || t("No")} {" "}{t("alg — only HS256/HS384/HS512 can be verified in the browser.")}
              </Notice>
            ) : null}

            <div className="flex flex-wrap gap-1.5">
              <Field label={t("Secret")} className="flex-1 min-w-[200px]">
                <TextInput
                  value={secret}
                  spellCheck={false}
                  onChange={(e) => setSecret(e.target.value)}
                  placeholder={t("signing key")}
                  className="font-mono"
                />
              </Field>
            </div>

            <StatGrid>
              <Stat
                label={t("Signature")}
                value={
                  verdict === "valid"
                    ? "matches ✓"
                    : verdict === "invalid"
                      ? "does not match ✕"
                      : "—"
                }
              />
              <Stat label={t("Header chars")} value={decoded.ok ? decoded.headRaw.length : 0} />
              <Stat label={t("Token chars")} value={token.trim().length} />
            </StatGrid>

            {liveBadge ? <Notice tone={liveBadge.tone}>{liveBadge.text}</Notice> : null}
          </div>
        </Panel>
      </div>

      <Panel
        title={t("Sign")}
        right={
          <div className="flex gap-1.5">
            <CopyButton text={signed} />
            <Button size="sm" variant="ghost" onClick={() => setSigned("")}>
              {t("Clear")}
            </Button>
          </div>
        }
      >
        <div className="grid gap-4 lg:grid-cols-2">
          <Field label={t("Header JSON")}>
            <TextArea
              rows={5}
              spellCheck={false}
              value={headerText}
              onChange={(e) => setHeaderText(e.target.value)}
            />
          </Field>
          <Field label={t("Payload JSON")}>
            <TextArea
              rows={10}
              spellCheck={false}
              value={payloadText}
              onChange={(e) => setPayloadText(e.target.value)}
            />
          </Field>
        </div>

        <div className="flex flex-wrap items-end gap-2">
          <Field label={t("Algorithm")} className="w-32">
            <Select value={signAlg} onChange={(e) => setSignAlg(e.target.value)}>
              {ALGS.map((alg) => (
                <option key={alg.id} value={alg.id}>
                  {alg.id}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        {signed ? (
          <div className="space-y-2">
            <div className="grid grid-cols-1 gap-2">
              <TextInput
                readOnly
                value={signed}
                onFocus={(e) => e.currentTarget.select()}
                className="font-mono text-[12px]"
              />
            </div>
            {signError ? <Notice tone="error">{signError}</Notice> : null}
          </div>
        ) : (
          signError ? <Notice tone="error">{signError}</Notice> : null
        )}
      </Panel>
    </div>
  );
}
