"use client";

/**
 * Parameter form of a node, generated from its catalog metadata (src/lib/workflows/catalog/): every field type, `showIf`
 * visibility, and the Fixed / Expression switch (an expression is stored with a leading `=`; `{{ … }}` parts are
 * JavaScript evaluated per item when the node runs).
 */
import dynamic from "next/dynamic";
import { useEffect, useId, useState } from "react";
import { fetchAccount } from "@/lib/agent-client/api";
import type { ProviderProfileInfo } from "@/lib/agent-client/types";
import { Button, Select, TextArea, TextInput } from "@/components/ui";
import { cx } from "@/lib/format";
import { paramVisible } from "@/lib/workflows/editor-model";
import type { NodeParam } from "@/lib/workflows/types";
import { OPERATORS, UNARY } from "@/lib/workflows/nodes/conditions";
import { useT } from "@/lib/i18n/react";

const CodeEditor = dynamic(() => import("./CodeEditor"), { ssr: false, loading: () => <div className="h-24 animate-pulse rounded-lg bg-raised" /> });

const isExpr = (value: unknown): value is string => typeof value === "string" && value.startsWith("=");
const EXPRESSION_TYPES = new Set(["string", "number", "boolean", "options", "dateTime", "json", "color"]);

const OPERATOR_LABELS: Record<string, string> = {
  exists: "exists", notExists: "does not exist", empty: "is empty", notEmpty: "is not empty", equals: "is equal to", notEquals: "is not equal to",
  contains: "contains", notContains: "does not contain", startsWith: "starts with", notStartsWith: "does not start with", endsWith: "ends with",
  notEndsWith: "does not end with", regex: "matches regex", notRegex: "does not match regex", gt: "is greater than", lt: "is less than",
  gte: "is greater than or equal to", lte: "is less than or equal to", after: "is after", before: "is before", afterOrEquals: "is after or equal to",
  beforeOrEquals: "is before or equal to", true: "is true", false: "is false", lengthEquals: "length equals", lengthNotEquals: "length is not",
  lengthGt: "length greater than", lengthLt: "length less than", lengthGte: "length at least", lengthLte: "length at most",
};
const TYPE_LABELS: Record<string, string> = { string: "Text", number: "Number", dateTime: "Date & time", boolean: "Boolean", array: "List", object: "Object" };

let profilesRequest: Promise<ProviderProfileInfo[]> | null = null;

function loadProfiles(): Promise<ProviderProfileInfo[]> {
  profilesRequest ??= fetchAccount().then((result) => (result.ok ? result.value.providerProfiles : []), () => []);
  return profilesRequest;
}

/** The account's saved AI provider profiles (keys never come here: names, models and hints only). */
function ProfileSelect({ value, onChange, label }: { value: unknown; onChange: (value: unknown) => void; label: string }) {
  const { t } = useT();
  const [profiles, setProfiles] = useState<ProviderProfileInfo[] | null>(null);
  useEffect(() => {
    let alive = true;
    loadProfiles().then((list) => alive && setProfiles(list));
    return () => {
      alive = false;
    };
  }, []);
  const active = profiles?.find((profile) => profile.active);
  return (
    <div className="space-y-1">
      <Select aria-label={label} value={String(value ?? "")} onChange={(event) => onChange(event.target.value)}>
        <option value="">{active ? t("The active profile (now: {name} · {model})", { name: active.name, model: active.model }) : t("The active profile")}</option>
        {(profiles ?? []).map((profile) => (
          <option key={profile.id} value={profile.id}>
            {profile.name} · {profile.model}
          </option>
        ))}
      </Select>
      {profiles && !profiles.length ? <p className="text-[11px] text-warn">{t("No provider saved yet: add one in the assistant's settings (it becomes a profile), or use an AI provider credential.")}</p> : null}
    </div>
  );
}

export interface FieldFocus {
  onFocusField?: (name: string) => void;
}

function ExpressionInput({ value, onChange, label, rows }: { value: string; onChange: (value: string) => void; label: string; rows?: number }) {
  const { t } = useT();
  const text = value.slice(1);
  return (
    <div className="space-y-1">
      {rows || text.length > 60 || text.includes("\n") ? (
        <TextArea aria-label={t("{label} (expression)", { label })} rows={Math.max(2, rows ?? 2)} value={text} onChange={(event) => onChange(`=${event.target.value}`)} className="border-accent/50" />
      ) : (
        <TextInput aria-label={t("{label} (expression)", { label })} value={text} onChange={(event) => onChange(`=${event.target.value}`)} className="border-accent/50 font-mono text-[13px]" />
      )}
      <p className="text-[11px] text-faint">
        {t("Text with")}{" "} <code className="font-mono">{"{{ … }}"}</code> {" "}{t("parts, JavaScript run for each item:")}{" "} <code className="font-mono">{"{{ $json.field }}"}</code>, <code className="font-mono">{'{{ $("Node").item.json.x }}'}</code>, <code className="font-mono">{"{{ $now.toFormat('yyyy-MM-dd') }}"}</code>.
      </p>
    </div>
  );
}

function ConditionsEditor({ value, onChange, label }: { value: unknown; onChange: (value: unknown) => void; label: string }) {
  const { t } = useT();
  const set = (value && typeof value === "object" ? value : {}) as { combinator?: string; conditions?: { leftValue?: unknown; operator?: string; rightValue?: unknown }[] };
  const rows = Array.isArray(set.conditions) ? set.conditions : [];
  const update = (next: Partial<typeof set>) => onChange({ combinator: set.combinator ?? "and", conditions: rows, ...next });
  const text = (v: unknown) => (v === undefined || v === null ? "" : typeof v === "string" ? v : JSON.stringify(v));
  return (
    <div className="space-y-2" role="group" aria-label={label}>
      {rows.map((row, index) => {
        const operator = row.operator ?? "string:equals";
        const [, operation] = operator.split(":");
        return (
          <div key={index} className="grid gap-1.5 rounded-lg border border-line bg-raised/40 p-2 sm:grid-cols-[1fr_auto_1fr_auto]">
            <TextInput aria-label={t("Condition {value} value", { value: index + 1 })} placeholder={t("{{ $json.field }}")} value={text(row.leftValue)} onChange={(event) => update({ conditions: rows.map((r, i) => (i === index ? { ...r, leftValue: event.target.value.includes("{{") && !event.target.value.startsWith("=") ? `=${event.target.value}` : event.target.value } : r)) })} className="h-9 font-mono text-[13px]" />
            <Select aria-label={t("Condition {value} operator", { value: index + 1 })} value={operator} onChange={(event) => update({ conditions: rows.map((r, i) => (i === index ? { ...r, operator: event.target.value } : r)) })} className="h-9 text-[13px]">
              {Object.entries(OPERATORS).map(([type, operations]) => (
                <optgroup key={type} label={TYPE_LABELS[type] ?? type}>
                  {operations.map((op) => (
                    <option key={op} value={`${type}:${op}`}>
                      {TYPE_LABELS[type]}: {OPERATOR_LABELS[op] ?? op}
                    </option>
                  ))}
                </optgroup>
              ))}
            </Select>
            {UNARY.has(operation) ? (
              <span />
            ) : (
              <TextInput aria-label={t("Condition {value} compare to", { value: index + 1 })} placeholder={t("value")} value={text(row.rightValue)} onChange={(event) => update({ conditions: rows.map((r, i) => (i === index ? { ...r, rightValue: event.target.value.includes("{{") && !event.target.value.startsWith("=") ? `=${event.target.value}` : event.target.value } : r)) })} className="h-9 font-mono text-[13px]" />
            )}
            <Button size="sm" variant="ghost" aria-label={t("Remove condition {value}", { value: index + 1 })} onClick={() => update({ conditions: rows.filter((_, i) => i !== index) })}>
              ✕
            </Button>
          </div>
        );
      })}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => update({ conditions: [...rows, { leftValue: "", operator: "string:equals", rightValue: "" }] })}>
          {t("Add condition")}
        </Button>
        {rows.length > 1 ? (
          <Select aria-label={t("Combine conditions")} value={set.combinator ?? "and"} onChange={(event) => update({ combinator: event.target.value })} className="h-7 w-auto text-xs">
            <option value="and">{t("All must match (AND)")}</option>
            <option value="or">{t("Any may match (OR)")}</option>
          </Select>
        ) : null}
      </div>
      <p className="text-[11px] text-faint">{t("Values with")}{" "} {"{{ … }}"} {" "}{t("are expressions. Numbers compare as numbers only when both sides are numbers (or turn on type conversion).")}</p>
    </div>
  );
}

function KeyValueEditor({ value, onChange, label }: { value: unknown; onChange: (value: unknown) => void; label: string }) {
  const { t } = useT();
  const rows = (Array.isArray(value) ? value : []) as { name?: string; value?: unknown }[];
  const set = (index: number, key: "name" | "value", text: string) => onChange(rows.map((row, i) => (i === index ? { ...row, [key]: key === "value" && text.includes("{{") && !text.startsWith("=") ? `=${text}` : text } : row)));
  return (
    <div className="space-y-1.5" role="group" aria-label={label}>
      {rows.map((row, index) => (
        <div key={index} className="flex gap-1.5">
          <TextInput aria-label={t("{label} {value} name", { label, value: index + 1 })} placeholder={t("name")} value={String(row.name ?? "")} onChange={(event) => set(index, "name", event.target.value)} className="h-9 w-2/5 text-[13px]" />
          <TextInput aria-label={t("{label} {value} value", { label, value: index + 1 })} placeholder={t("value or {{ expression }}")} value={String(row.value ?? "")} onChange={(event) => set(index, "value", event.target.value)} className="h-9 flex-1 font-mono text-[13px]" />
          <Button size="sm" variant="ghost" aria-label={t("Remove {label} {value}", { label, value: index + 1 })} onClick={() => onChange(rows.filter((_, i) => i !== index))} className="h-9">
            ✕
          </Button>
        </div>
      ))}
      <Button size="sm" onClick={() => onChange([...rows, { name: "", value: "" }])}>
        {t("Add")}
      </Button>
    </div>
  );
}

function ListEditor({ param, value, onChange, onFocusField }: { param: NodeParam; value: unknown; onChange: (value: unknown) => void } & FieldFocus) {
  const { t } = useT();
  const rows = (Array.isArray(value) ? value : []) as Record<string, unknown>[];
  const fields = param.fields ?? [];
  const blank = () => Object.fromEntries(fields.map((field) => [field.name, field.default ?? ""]));
  return (
    <div className="space-y-2" role="group" aria-label={t(param.label)}>
      {rows.map((row, index) => (
        <div key={index} className="relative space-y-2 rounded-lg border border-line bg-raised/40 p-2.5 pr-10">
          <ParamFields params={fields} values={row} onChange={(name, next) => onChange(rows.map((r, i) => (i === index ? { ...r, [name]: next } : r)))} prefix={`${t(param.label)} ${index + 1}`} compact onFocusField={onFocusField} />
          <Button size="sm" variant="ghost" aria-label={t("Remove {label} {value}", { label: param.label, value: index + 1 })} onClick={() => onChange(rows.filter((_, i) => i !== index))} className="absolute top-2 right-1.5">
            ✕
          </Button>
        </div>
      ))}
      <Button size="sm" onClick={() => onChange([...rows, blank()])}>
        {t("Add {value}", { value: param.label.toLowerCase().replace(/s$/, "") })}
      </Button>
    </div>
  );
}

function CollectionEditor({ param, value, onChange, onFocusField }: { param: NodeParam; value: unknown; onChange: (value: unknown) => void } & FieldFocus) {
  const { t } = useT();
  const values = (value && typeof value === "object" && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
  const fields = param.fields ?? [];
  const set = fields.filter((field) => field.name in values);
  const unset = fields.filter((field) => !(field.name in values));
  return (
    <div className="space-y-2" role="group" aria-label={t(param.label)}>
      {set.map((field) => (
        <div key={field.name} className="relative rounded-lg border border-line bg-raised/40 p-2.5 pr-10">
          <ParamFields params={[field]} values={values} onChange={(name, next) => onChange({ ...values, [name]: next })} prefix={t(param.label)} compact onFocusField={onFocusField} />
          <Button size="sm" variant="ghost" aria-label={t("Remove option {label}", { label: field.label })} onClick={() => onChange(Object.fromEntries(Object.entries(values).filter(([key]) => key !== field.name)))} className="absolute top-2 right-1.5">
            ✕
          </Button>
        </div>
      ))}
      {unset.length ? (
        <Select
          aria-label={t("Add {value}", { value: param.label.toLowerCase() })}
          value=""
          onChange={(event) => {
            const field = fields.find((f) => f.name === event.target.value);
            if (field) onChange({ ...values, [field.name]: field.default ?? "" });
          }}
          className="h-8 w-auto text-xs"
        >
          <option value="">{t("Add option…")}</option>
          {unset.map((field) => (
            <option key={field.name} value={field.name}>
              {t(field.label)}
            </option>
          ))}
        </Select>
      ) : null}
    </div>
  );
}

function FieldInput({ param, value, onChange, label, focus }: { param: NodeParam; value: unknown; onChange: (value: unknown) => void; label: string; focus: FieldFocus }) {
  const { t } = useT();
  const onFocus = () => focus.onFocusField?.(param.name);
  if (isExpr(value) && EXPRESSION_TYPES.has(param.type)) return <ExpressionInput value={value} onChange={onChange} label={label} rows={param.rows} />;
  switch (param.type) {
    case "string":
      return param.rows ? (
        <TextArea aria-label={label} rows={param.rows} value={String(value ?? "")} placeholder={t(param.placeholder)} onFocus={onFocus} onChange={(event) => onChange(event.target.value)} className="font-sans text-sm" />
      ) : (
        <TextInput aria-label={label} value={String(value ?? "")} placeholder={t(param.placeholder)} onFocus={onFocus} onChange={(event) => onChange(event.target.value)} />
      );
    case "number":
      return <TextInput aria-label={label} type="number" min={param.min} max={param.max} value={value === undefined || value === null ? "" : String(value)} onFocus={onFocus} onChange={(event) => onChange(event.target.value === "" ? "" : Number(event.target.value))} />;
    case "boolean":
      return (
        <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-ink">
          <input type="checkbox" className="size-4 accent-[var(--c-accent)]" checked={value === true} onChange={(event) => onChange(event.target.checked)} />
          {label}
        </label>
      );
    case "options":
      return (
        <Select aria-label={label} value={String(value ?? "")} onChange={(event) => onChange(event.target.value)}>
          {(param.options ?? []).map((option) => (
            <option key={option.value} value={option.value} title={t(option.description)}>
              {t(option.label)}
            </option>
          ))}
        </Select>
      );
    case "multiOptions": {
      const list = Array.isArray(value) ? (value as string[]) : [];
      return (
        <div className="flex flex-wrap gap-3" role="group" aria-label={label}>
          {(param.options ?? []).map((option) => (
            <label key={option.value} className="inline-flex items-center gap-1.5 text-sm">
              <input type="checkbox" checked={list.includes(option.value)} onChange={(event) => onChange(event.target.checked ? [...list, option.value] : list.filter((v) => v !== option.value))} />
              {t(option.label)}
            </label>
          ))}
        </div>
      );
    }
    case "json":
      return <CodeEditor key="json" language="json" label={label} value={typeof value === "string" ? value : JSON.stringify(value ?? {}, null, 2)} onChange={onChange} minRows={param.rows ?? 4} />;
    case "code":
      return <CodeEditor key={param.language ?? "javascript"} language={param.language === "text" ? "text" : "javascript"} label={label} value={String(value ?? "")} onChange={onChange} minRows={param.rows ?? 12} />;
    case "conditions":
      return <ConditionsEditor value={value} onChange={onChange} label={label} />;
    case "keyValue":
      return <KeyValueEditor value={value} onChange={onChange} label={label} />;
    case "list":
      return <ListEditor param={param} value={value} onChange={onChange} onFocusField={focus.onFocusField} />;
    case "collection":
      return <CollectionEditor param={param} value={value} onChange={onChange} onFocusField={focus.onFocusField} />;
    case "dateTime":
      return <TextInput aria-label={label} type="datetime-local" value={typeof value === "string" ? value.slice(0, 16) : ""} onChange={(event) => onChange(event.target.value ? new Date(event.target.value).toISOString() : "")} />;
    case "color":
      return <input aria-label={label} type="color" value={String(value ?? "#3366ff")} onChange={(event) => onChange(event.target.value)} />;
    case "providerProfile":
      return <ProfileSelect value={value} onChange={onChange} label={label} />;
    default:
      return null;
  }
}

/** The visible fields of a parameter list, with their labels, hints and the expression switch. */
export function ParamFields({ params, values, onChange, prefix, compact = false, onFocusField }: { params: NodeParam[]; values: Record<string, unknown>; onChange: (name: string, value: unknown) => void; prefix?: string; compact?: boolean } & FieldFocus) {
  const { t } = useT();
  const baseId = useId();
  return (
    <div className={compact ? "space-y-2" : "space-y-4"}>
      {params.map((param) => {
        if (!paramVisible(param, values, params)) return null;
        const value = param.name in values ? values[param.name] : param.default;
        const label = prefix ? `${prefix} ${t(param.label)}` : t(param.label);
        if (param.type === "notice") return <p key={param.name} className="rounded-lg border border-line bg-raised/50 px-3 py-2 text-[13px] text-muted">{t(param.label)}</p>;
        const canExpress = EXPRESSION_TYPES.has(param.type) && !param.noExpression;
        const expression = isExpr(value);
        return (
          <div key={param.name} className="space-y-1.5" data-param={param.name}>
            {param.type !== "boolean" || expression ? (
              <div className="flex items-center justify-between gap-2">
                <span id={`${baseId}-${param.name}`} className={cx("sk-label block", compact && "text-[11px]")}>
                  {t(param.label)}
                  {param.required ? <span className="text-danger"> *</span> : null}
                </span>
                {canExpress ? (
                  <button
                    type="button"
                    aria-pressed={expression}
                    aria-label={`${label}: ${expression ? "switch to a fixed value" : "switch to an expression"}`}
                    title={expression ? t("Fixed value") : t("Expression ({{ … }})")}
                    onClick={() => {
                      if (expression) onChange(param.name, param.type === "number" ? Number(value.slice(1).replace(/[{}\s]/g, "")) || 0 : param.type === "boolean" ? value.includes("true") : value.slice(1));
                      else onChange(param.name, `=${typeof value === "string" ? value : value === undefined || value === null ? "" : `{{ ${JSON.stringify(value)} }}`}`);
                    }}
                    className={cx("rounded-md border px-1.5 font-mono text-[11px] leading-5", expression ? "border-accent/60 bg-accent/15 text-accent-soft" : "border-line text-faint hover:text-ink")}
                  >
                    fx
                  </button>
                ) : null}
              </div>
            ) : null}
            <FieldInput param={param} value={value} onChange={(next) => onChange(param.name, next)} label={label} focus={{ onFocusField }} />
            {param.description ? <p className="text-[11px] leading-snug text-faint">{t(param.description)}</p> : null}
          </div>
        );
      })}
    </div>
  );
}
