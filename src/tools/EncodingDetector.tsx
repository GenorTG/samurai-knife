"use client";
import { useState, type ChangeEvent } from "react";
import { Field, Notice, Panel, Stat, StatGrid } from "@/components/ui";
import { useT } from "@/lib/i18n/react";
import { formatInt } from "@/lib/format";
const LIMIT = 8 * 1024 * 1024;
export default function EncodingDetector() {
  const { t } = useT();
  const [result, setResult] = useState<{ label: string; detail: string; sample: string } | null>(null), [error, setError] = useState("");
  const inspect = async (event: ChangeEvent<HTMLInputElement>) => { const file = event.target.files?.[0]; if (!file) return; if (file.size > LIMIT) { setError(t("File exceeds the 8 MiB inspection limit.")); setResult(null); return; } const bytes = new Uint8Array(await file.arrayBuffer()); const hasNull = bytes.includes(0); const controls = [...bytes].filter((b) => b < 32 && ![9, 10, 12, 13].includes(b)).length; const ratio = bytes.length ? controls / bytes.length : 0;
    const starts = (prefix: number[]) => prefix.every((b, i) => bytes[i] === b);
    try { let encoding = "UTF-8", offset = 0; if (starts([0xef, 0xbb, 0xbf])) offset = 3; else if (starts([0xff, 0xfe])) { encoding = "UTF-16 LE"; offset = 2; } else if (starts([0xfe, 0xff])) { encoding = "UTF-16 BE"; offset = 2; }
      const decoder = new TextDecoder(encoding === "UTF-16 LE" ? "utf-16le" : encoding === "UTF-16 BE" ? "utf-16be" : "utf-8", { fatal: true }); const decoded = decoder.decode(bytes.slice(offset));
      setResult({ label: hasNull && encoding === "UTF-8" ? t("Binary or UTF-16 candidate") : encoding, detail: offset ? t("{bytes} bytes; {controls} non-whitespace control bytes. Valid {encoding} sequence with BOM.", { bytes: formatInt(bytes.length), controls, encoding }) : t("{bytes} bytes; {controls} non-whitespace control bytes. Valid {encoding} sequence without BOM.", { bytes: formatInt(bytes.length), controls, encoding }), sample: decoded.slice(0, 400) }); setError("");
    } catch { setResult({ label: t("Not valid UTF-8 / UTF-16"), detail: t("{bytes} bytes; {percent}% control bytes. Could be a legacy code page or binary data.", { bytes: formatInt(bytes.length), percent: Math.round(ratio * 100) }), sample: "" }); setError(""); }
  };
  return (
    <Panel title={t("Text file encoding detector")}>
      <div className="space-y-3">
        <Field label={t("Local file (read-only)")}><input className="sk-input w-full px-3 py-2 text-sm" type="file" onChange={(e) => void inspect(e)} /></Field>
        {error && <Notice tone="error">{error}</Notice>}
        {result && (
          <>
            <StatGrid><Stat label={t("Detection")} value={result.label} /><Stat label={t("Bytes")} value={result.detail} /></StatGrid>
            {result.sample ? <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-raised p-3 text-xs">{result.sample}</pre> : null}
          </>
        )}
        <p className="text-xs text-faint">{t("Byte patterns identify BOMs and validate UTF-8/UTF-16. Without a BOM, many single-byte encodings are indistinguishable; this is not probabilistic language-based detection.")}</p>
      </div>
    </Panel>
  );
}
