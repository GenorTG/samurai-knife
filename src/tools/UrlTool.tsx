"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, CopyButton, Field, KeyValues, Notice, OutputBlock, Panel, Select, Stat, StatGrid, TextArea, TextInput } from "@/components/ui";
import { dataUriByteLength } from "@/lib/data-uri";
import { downloadText, plural } from "@/lib/format";

/**
 * URL workbench: parse, edit query parameters in place, percent-encode/decode,
 * and inspect data: URIs. The rebuild is explicit — parameters are kept as
 * ordered pairs so the tool never silently reorders a signed URL.
 */

const SAFE_UNRESERVED = "-._/?:@#[]!$&'()*+,;=";

function parseUrl(input: string): URL | null {
  const url = parseUrlLoose(input);
  // Chrome percent-encodes forbidden host characters (e.g. a space) instead of throwing; treat that as invalid.
  return url && /^https?:$/.test(url.protocol) && url.hostname.includes("%") ? null : url;
}

function parseUrlLoose(input: string): URL | null {
  const value = input.trim();
  if (!value) return null;
  // "localhost:3000/x" parses as scheme "localhost:" — treat host:port as a web address instead.
  if (/^[^/:\s@]+:\d+(?:[/?#]|$)/.test(value)) {
    try {
      return new URL(`https://${value}`);
    } catch {
      return null;
    }
  }
  try {
    return new URL(value);
  } catch {
    try {
      return new URL(`https://${value}`);
    } catch {
      return null;
    }
  }
}

function percentEncode(text: string, keepExtra: string): string {
  let out = "";
  for (const ch of text) {
    let encoded: string;
    try {
      encoded = encodeURIComponent(ch);
    } catch {
      encoded = "%EF%BF%BD"; // lone surrogate: encode as U+FFFD like TextEncoder does
    }
    out += encoded === ch ? ch : (keepExtra.includes(ch) ? ch : encoded);
  }
  return out;
}

function percentDecode(text: string): string {
  try {
    return decodeURIComponent(text.replace(/\+/g, " "));
  } catch {
    return text;
  }
}

function isValidPercent(text: string): boolean {
  try {
    decodeURIComponent(text.replace(/\+/g, " "));
    return true;
  } catch {
    return false;
  }
}

function parseDataUri(input: string): Record<string, string> | null {
  const match = /^data:([^;]*)(;([^=]*))?[;,](.*)$/s.exec(input);
  if (!match) return null;
  const payload = match[4];
  const isBase64 = (match[3] ?? "").toLowerCase() === "base64";
  return {
    "Media type": match[1] || "—",
    "Modifier": match[3] ?? "—",
    "Base64": isBase64 ? "yes" : "no",
    "Payload chars": String(payload.length),
    "Decoded bytes": String(dataUriByteLength(payload, isBase64)),
    "Payload preview": payload.length > 400 ? `${payload.slice(0, 400)}…` : payload,
  };
}

export default function UrlTool() {
  const [raw, setRaw] = useState("https://samurai.dev/search?q=knife&lang=pl#top");
  const [paramText, setParamText] = useState("");
  const [encodeOn, setEncodeOn] = useState(true);
  const [keepExtra, setKeepExtra] = useState(SAFE_UNRESERVED);
  const [sample, setSample] = useState("https://samurai.dev/search?q=knife");
  const [decoded, setDecoded] = useState("");
  const [dataUri, setDataUri] = useState("");
  const [error, setError] = useState<string | null>(null);

  const parsed = useMemo(() => parseUrl(raw), [raw]);

  const params = useMemo(() => {
    if (!parsed) return [];
    return [...parsed.searchParams.entries()];
  }, [parsed]);

  const rebuilt = useMemo(() => {
    if (!parsed) return "";
    const url = parsed;
    const params = new URLSearchParams();
    const lines = paramText.split("\n").map((line) => line.trim()).filter(Boolean);
    for (const line of lines) {
      const eq = line.indexOf("=");
      const key = eq === -1 ? line : line.slice(0, eq);
      const value = eq === -1 ? "" : line.slice(eq + 1);
      if (encodeOn) {
        params.append(key, value);
      } else {
        // Manual composition: keep the author's exact bytes and order.
        params.append(key, value);
      }
    }
    const manual = lines.map((line) => {
      const eq = line.indexOf("=");
      return eq === -1 ? percentEncode(line, keepExtra) : `${percentEncode(line.slice(0, eq), keepExtra)}=${percentEncode(line.slice(eq + 1), keepExtra)}`;
    });
    const query = encodeOn ? params.toString() : manual.join("&");
    const base = url.href.split(/[?#]/)[0]; // keeps scheme/credentials/port; origin is "null" for mailto:, file:, data:
    return query ? `${base}?${query}${url.hash}` : `${base}${url.hash}`;
  }, [encodeOn, keepExtra, paramText, parsed]);

  const loadParams = useCallback(() => {
    if (!parsed) return;
    setParamText(params.map(([key, value]) => (value ? `${key}=${value}` : key)).join("\n"));
  }, [parsed, params]);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (!raw.trim()) setError(null);
      else if (!parsed) setError(`"${raw.trim()}" is not a URL this browser can parse.`);
      else setError(null);
    }, 140);
    return () => clearTimeout(timer);
  }, [raw, parsed]);

  const encodedSample = useMemo(() => percentEncode(sample, keepExtra), [keepExtra, sample]);

  const dataRows = useMemo(() => {
    const rows = parseDataUri(dataUri);
    if (!rows) return [];
    return Object.entries(rows);
  }, [dataUri]);

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel
          title="Parse"
          right={
            <div className="flex gap-1.5">
              <CopyButton text={raw} label="Copy URL" />
              <Button size="sm" variant="ghost" onClick={() => { setRaw(""); setParamText(""); }}>
                Clear
              </Button>
            </div>
          }
        >
          <div className="space-y-3">
            <Field label="URL">
              <TextInput
                value={raw}
                spellCheck={false}
                onChange={(e) => setRaw(e.target.value)}
                placeholder="https://…"
                className="font-mono"
              />
            </Field>

            {error ? <Notice tone="error">{error}</Notice> : null}

            {parsed ? (
              <div className="space-y-3">
                <KeyValues
                  rows={[
                    ["Protocol", parsed.protocol],
                    ["Host", parsed.host],
                    ["Origin", parsed.origin],
                    ["Path", parsed.pathname],
                    ["Query", parsed.search || "—"],
                    ["Hash", parsed.hash || "—"],
                  ]}
                />
                <StatGrid>
                  <Stat label="Parameters" value={params.length} />
                  <Stat label="Chars" value={raw.trim().length} />
                  <Stat label="Secure" value={parsed.protocol === "https:" ? "yes" : "no"} />
                </StatGrid>
              </div>
            ) : null}
          </div>
        </Panel>

        <Panel
          title="Edit parameters"
          right={
            <div className="flex gap-1.5">
              <Button size="sm" variant="subtle" onClick={loadParams}>
                Load current
              </Button>
              <CopyButton text={rebuilt} label="Copy rebuilt" />
              <Button size="sm" variant="subtle" disabled={!rebuilt} onClick={() => downloadText(rebuilt, "url.txt")}>
                Save
              </Button>
            </div>
          }
        >
          <div className="space-y-3">
            <Field label="One `key=value` per line" hint="Order is preserved. Blank values are allowed; a bare key becomes a flag.">
              <TextArea
                value={paramText}
                spellCheck={false}
                onChange={(e) => setParamText(e.target.value)}
                placeholder={parsed ? "one per line…" : "press Load current first"}
                className="font-mono text-[12px]"
              />
            </Field>

            <div className="flex flex-wrap items-end gap-2">
              <Field label="Encoding" className="w-36">
                <Select value={encodeOn ? "browser" : "manual"} onChange={(e) => setEncodeOn(e.target.value !== "manual")}>
                  <option value="browser">browser</option>
                  <option value="manual">manual</option>
                </Select>
              </Field>
              <Field label="Never escape" className="w-48 flex-1">
                <TextInput
                  value={keepExtra}
                  onChange={(e) => setKeepExtra(e.target.value)}
                  placeholder="characters to leave literal"
                  className="font-mono"
                />
              </Field>
            </div>

            <p className="text-xs text-faint">
              {encodeOn
                ? "Browser mode normalises with URLSearchParams — canonical, but it reorders and re-encodes."
                : "Manual mode keeps your exact bytes and order — right for signed URLs and cache-busters."}
            </p>

            {parsed ? (
              <div className="space-y-2">
                <OutputBlock value={rebuilt} rows={4} empty="Nothing rebuilt." />
                <StatGrid>
                  <Stat label="Params" value={plural(paramText.split("\n").filter((l) => l.trim()).length, "param")} />
                  <Stat label="Rebuilt chars" value={rebuilt.length} />
                </StatGrid>
              </div>
            ) : null}
          </div>
        </Panel>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel
          title="Percent encode"
          right={
            <div className="flex gap-1.5">
              <CopyButton text={encodedSample} />
            </div>
          }
        >
          <div className="space-y-3">
            <Field label="Text to encode">
              <TextInput
                value={sample}
                spellCheck={false}
                onChange={(e) => setSample(e.target.value)}
                className="font-mono"
              />
            </Field>
            <Field label="Leave literal">
              <TextInput
                value={keepExtra}
                onChange={(e) => setKeepExtra(e.target.value)}
                className="font-mono"
              />
            </Field>
            <OutputBlock value={encodedSample} rows={4} empty="Type something above." />
          </div>
        </Panel>

        <Panel
          title="Decode · inspect"
          right={
            <div className="flex gap-1.5">
              <CopyButton text={decoded} />
            </div>
          }
        >
          <div className="space-y-3">
            <Field label="Percent-encoded or a data: URI">
              <TextInput
                value={decoded || dataUri}
                spellCheck={false}
                onChange={(e) => {
                  const next = e.target.value;
                  if (/^data:/i.test(next)) {
                    setDataUri(next);
                    setDecoded("");
                  } else {
                    setDecoded(next);
                    setDataUri("");
                  }
                }}
                placeholder="%E2%80%A6 · data:image/png;base64,…"
                className="font-mono"
              />
            </Field>

            {dataUri ? (
              <KeyValues rows={dataRows} />
            ) : decoded ? (
              <>
                {!isValidPercent(decoded) ? <Notice tone="error">Malformed percent-encoding; showing the text unchanged.</Notice> : null}
                <OutputBlock value={percentDecode(decoded)} rows={4} />
              </>
            ) : null}
          </div>
        </Panel>
      </div>
    </div>
  );
}
