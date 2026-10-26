"use client";

import { useMemo, useState } from "react";
import { Button, CopyButton, Notice, Panel, TextArea } from "@/components/ui";
import { validateJsonSchema } from "@/lib/json-schema";
import { useT } from "@/lib/i18n/react";
import { msg } from "@/lib/i18n/msg";

const SAMPLE_SCHEMA = JSON.stringify({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["name", "email", "roles"],
  properties: {
    name: { type: "string", minLength: 1 },
    email: { type: "string", format: "email" },
    roles: { type: "array", items: { enum: ["admin", "editor", "viewer"] } },
  },
}, null, 2);

const SAMPLE_VALUE = JSON.stringify({
  name: msg("Ada Lovelace"),
  email: "ada@example.com",
  roles: ["admin", "viewer"],
}, null, 2);

type ValidationState =
  | { kind: "empty" }
  | { kind: "input-error"; message: string }
  | { kind: "invalid-schema"; message: string }
  | { kind: "result"; valid: boolean; issues: ReturnType<typeof validateJsonSchema>["issues"] };

export default function JsonSchemaValidator() {
  const { t, tn } = useT();
  const [schemaText, setSchemaText] = useState("");
  const [valueText, setValueText] = useState("");

  const result = useMemo<ValidationState>(() => {
    if (!schemaText.trim() && !valueText.trim()) return { kind: "empty" };
    if (!schemaText.trim()) return { kind: "input-error", message: t("Enter a JSON Schema.") };
    if (!valueText.trim()) return { kind: "input-error", message: t("Enter a JSON value to validate.") };

    let schema: unknown;
    let value: unknown;
    try {
      schema = JSON.parse(schemaText) as unknown;
      value = JSON.parse(valueText) as unknown;
    } catch (error) {
      return { kind: "input-error", message: error instanceof Error ? error.message : String(error) };
    }

    try {
      const validation = validateJsonSchema(schema, value);
      return { kind: "result", ...validation };
    } catch (error) {
      return { kind: "invalid-schema", message: error instanceof Error ? error.message : String(error) };
    }
  }, [t, schemaText, valueText]);

  const issueOutput = result.kind === "result" && !result.valid
    ? JSON.stringify(result.issues, null, 2)
    : "";

  return (
    <div className="space-y-4">
      <Notice>
        {t("Validate JSON locally against JSON Schema Draft 2020-12. Common formats such as email, URI, date and date-time are checked too; remote references are not fetched.")}
      </Notice>
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel
          title={t("JSON Schema")}
          right={<Button size="sm" variant="subtle" onClick={() => { setSchemaText(SAMPLE_SCHEMA); setValueText(SAMPLE_VALUE); }}>{t("Load sample")}</Button>}
        >
          <TextArea
            rows={18}
            spellCheck={false}
            value={schemaText}
            onChange={(event) => setSchemaText(event.target.value)}
            placeholder={t("{\n  \"$schema\": \"https://json-schema.org/draft/2020-12/schema\",\n  \"type\": \"object\"\n}")}
            aria-label={t("JSON Schema")}
          />
        </Panel>
        <Panel title={t("JSON value")}>
          <TextArea
            rows={18}
            spellCheck={false}
            value={valueText}
            onChange={(event) => setValueText(event.target.value)}
            placeholder={t("Paste the JSON instance to validate…")}
            aria-label={t("JSON value to validate")}
          />
        </Panel>
      </div>

      <Panel title={t("Validation")}>
        {result.kind === "empty" ? <Notice>{t("Paste a schema and JSON value to see validation results.")}</Notice> : null}
        {result.kind === "input-error" ? <Notice tone="error">{result.message}</Notice> : null}
        {result.kind === "invalid-schema" ? (
          <Notice tone="error">{t("Schema could not be compiled:")}{" "} {result.message}</Notice>
        ) : null}
        {result.kind === "result" && result.valid ? <Notice tone="good">{t("Valid — the JSON value matches the schema.")}</Notice> : null}
        {result.kind === "result" && !result.valid ? (
          <div className="space-y-3">
            <Notice tone="error">{tn("Invalid — {n} validation issue found.", "Invalid — {n} validation issues found.", result.issues.length)}</Notice>
            <div className="flex justify-end"><CopyButton text={issueOutput} label={t("Copy issues")} /></div>
            <div className="space-y-2">
              {result.issues.map((issue, index) => (
                <div key={`${issue.schemaPath}-${index}`} className="rounded-lg border border-line bg-raised/40 px-3 py-2">
                  <p className="font-mono text-xs text-ink"><span className="text-accent-soft">{issue.instancePath}</span> · {issue.message}</p>
                  <p className="mt-1 break-all font-mono text-[10px] text-faint">{issue.keyword} · {issue.schemaPath}</p>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </Panel>
    </div>
  );
}
