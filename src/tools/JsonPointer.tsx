"use client";

import { useMemo, useState } from "react";
import { Button, CopyButton, Field, Notice, OutputBlock, Panel, Stat, StatGrid, TextArea, TextInput } from "@/components/ui";
import { resolveJsonPointer } from "@/lib/json-pointer";

const SAMPLE = JSON.stringify({
  service: "payments",
  "metadata/region": "eu-central",
  teams: [{ name: "platform", members: [{ name: "Ada", role: "owner" }] }],
}, null, 2);

type PointerState =
  | { kind: "empty" }
  | { kind: "json-error"; message: string }
  | { kind: "pointer-error"; message: string }
  | { kind: "found"; value: unknown; tokens: string[] };

function valueType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

export default function JsonPointer() {
  const [jsonText, setJsonText] = useState("");
  const [pointer, setPointer] = useState("");

  const result = useMemo<PointerState>(() => {
    if (!jsonText.trim()) return { kind: "empty" };
    let document: unknown;
    try {
      document = JSON.parse(jsonText) as unknown;
    } catch (error) {
      return { kind: "json-error", message: error instanceof Error ? error.message : String(error) };
    }
    const resolved = resolveJsonPointer(document, pointer);
    return resolved.found
      ? { kind: "found", value: resolved.value, tokens: resolved.tokens }
      : { kind: "pointer-error", message: resolved.error };
  }, [jsonText, pointer]);

  const output = result.kind === "found" ? JSON.stringify(result.value, null, 2) : "";
  const summary = result.kind === "found"
    ? result.value && typeof result.value === "object"
      ? Array.isArray(result.value) ? `${result.value.length} items` : `${Object.keys(result.value).length} keys`
      : "Scalar value"
    : "";

  return (
    <div className="space-y-4">
      <Notice>
        Resolve an RFC 6901 JSON Pointer without uploading data. Use an empty pointer for the entire document; escape `/` as `~1` and `~` as `~0` inside property names.
      </Notice>
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel
          title="JSON document"
          right={<Button size="sm" variant="subtle" onClick={() => { setJsonText(SAMPLE); setPointer("/teams/0/members/0/name"); }}>Load sample</Button>}
        >
          <TextArea
            rows={20}
            spellCheck={false}
            maxLength={200_000}
            value={jsonText}
            onChange={(event) => setJsonText(event.target.value)}
            placeholder="Paste an API response or JSON document…"
            aria-label="JSON document"
          />
        </Panel>
        <div className="space-y-4">
          <Panel title="Pointer">
            <Field label="RFC 6901 JSON Pointer" hint="Examples: /users/0/email · /metadata~1region · empty string = root">
              <TextInput
                value={pointer}
                onChange={(event) => setPointer(event.target.value)}
                spellCheck={false}
                maxLength={2_048}
                placeholder="/users/0/email"
                className="font-mono"
              />
            </Field>
          </Panel>

          <Panel title="Selected value" right={<CopyButton text={output} label="Copy value" />}>
            {result.kind === "empty" ? <Notice>Paste JSON to inspect a value by pointer.</Notice> : null}
            {result.kind === "json-error" ? <Notice tone="error">Invalid JSON: {result.message}</Notice> : null}
            {result.kind === "pointer-error" ? <Notice tone="error">Pointer did not resolve: {result.message}</Notice> : null}
            {result.kind === "found" ? (
              <div className="space-y-3">
                <StatGrid>
                  <Stat label="JSON type" value={valueType(result.value)} />
                  <Stat label="Path segments" value={result.tokens.length} />
                </StatGrid>
                <p className="text-xs text-faint">{summary}</p>
                <OutputBlock value={output} rows={12} />
              </div>
            ) : null}
          </Panel>
        </div>
      </div>
    </div>
  );
}
