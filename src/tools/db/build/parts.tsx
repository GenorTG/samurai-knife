"use client";

import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";
import { Button } from "@/components/ui";
import { cx } from "@/lib/format";
import { formatLoose, formatLooseList, parseLoose, parseLooseList } from "@/lib/sql/spec-values";
import { COMPARISON_OPS, type SpecCondition, type SpecValue } from "@/lib/sql/types";

/** Dense controls for the builder rows (the shared TextInput is 40px tall; rows of them would sprawl). */
export function DenseInput({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cx("sk-input h-8 min-w-0 px-2 font-mono text-[13px]", className)} spellCheck={false} autoComplete="off" {...rest} />;
}

export function DenseSelect({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cx("sk-input h-8 pl-2 text-[13px]", className)} {...rest}>
      {children}
    </select>
  );
}

export function SectionLabel({ children, hint }: { children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="space-y-0.5">
      <h3 className="sk-label">{children}</h3>
      {hint ? <p className="text-xs text-faint">{hint}</p> : null}
    </div>
  );
}

export const VALUE_HINT = "Values: text, 12, true, null, :param, @column, 'quoted text', =NOW()";

export function ValueInput({ label, value, onChange, className, listId }: { label: string; value: SpecValue | undefined; onChange: (v: SpecValue) => void; className?: string; listId?: string }) {
  return <DenseInput aria-label={label} className={className} list={listId} value={formatLoose(value)} onChange={(e) => onChange(parseLoose(e.target.value))} />;
}

export function RemoveButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button size="sm" variant="ghost" aria-label={label} title={label} onClick={onClick} className="shrink-0 px-2 text-danger">
      Remove
    </Button>
  );
}

/* ------------------------------------------------------------- condition tree */

const OP_LABEL: Record<(typeof COMPARISON_OPS)[number], string> = {
  "=": "=",
  "!=": "!=",
  "<": "<",
  "<=": "<=",
  ">": ">",
  ">=": ">=",
  like: "LIKE",
  ilike: "ILIKE",
  in: "IN",
  "not in": "NOT IN",
  between: "BETWEEN",
  "is null": "IS NULL",
  "is not null": "IS NOT NULL",
};

const blankComparison = (): SpecCondition => ({ col: "", op: "=", value: "" });

/**
 * Recursive editor for the and/or/not/comparison tree. `onChange(undefined)` asks the parent to drop this node.
 * `label` prefixes every control's aria-label so assistants can tell conditions apart ("Where 1.2 column").
 */
export function ConditionEditor({
  value,
  onChange,
  label,
  columnsList,
}: {
  value: SpecCondition;
  onChange: (next: SpecCondition | undefined) => void;
  label: string;
  columnsList: string;
}) {
  if ("and" in value || "or" in value) {
    const kind = "and" in value ? "and" : "or";
    const children = "and" in value ? value.and : value.or;
    const rebuild = (nextKind: "and" | "or", list: SpecCondition[]): SpecCondition => (nextKind === "and" ? { and: list } : { or: list });
    const setChildren = (list: SpecCondition[]) => (list.length ? onChange(rebuild(kind, list)) : onChange(undefined));
    return (
      <div role="group" aria-label={`${label} group`} className="space-y-2 rounded-lg border border-line bg-raised/30 p-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <DenseSelect aria-label={`${label} match mode`} value={kind} onChange={(e) => onChange(rebuild(e.target.value as "and" | "or", children))}>
            <option value="and">Match ALL (and)</option>
            <option value="or">Match ANY (or)</option>
          </DenseSelect>
          <Button size="sm" onClick={() => setChildren([...children, blankComparison()])} aria-label={`${label} add condition`}>Add condition</Button>
          <Button size="sm" onClick={() => setChildren([...children, { or: [blankComparison()] }])} aria-label={`${label} add nested group`}>Add group</Button>
          <RemoveButton label={`Remove ${label} group`} onClick={() => onChange(undefined)} />
        </div>
        <div className="space-y-2 border-l-2 border-line-strong pl-3">
          {children.map((child, i) => (
            <ConditionEditor
              key={i}
              value={child}
              label={`${label}.${i + 1}`}
              columnsList={columnsList}
              onChange={(next) => setChildren(next ? children.map((c, j) => (j === i ? next : c)) : children.filter((_, j) => j !== i))}
            />
          ))}
        </div>
      </div>
    );
  }

  if ("not" in value) {
    return (
      <div role="group" aria-label={`${label} not`} className="space-y-2 rounded-lg border border-warn/40 bg-warn/5 p-2.5">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs font-semibold text-warn">NOT</span>
          <Button size="sm" variant="ghost" onClick={() => onChange(value.not)} aria-label={`${label} remove the NOT`}>Unwrap NOT</Button>
          <RemoveButton label={`Remove ${label} condition`} onClick={() => onChange(undefined)} />
        </div>
        <div className="border-l-2 border-warn/40 pl-3">
          <ConditionEditor value={value.not} label={`${label}.not`} columnsList={columnsList} onChange={(next) => onChange(next ? { not: next } : undefined)} />
        </div>
      </div>
    );
  }

  const op = value.op;
  const needsNone = op === "is null" || op === "is not null";
  const list = op === "in" || op === "not in";
  const between = op === "between";
  const raw = value.value;
  const pair = Array.isArray(raw) ? raw : [];
  return (
    <div role="group" aria-label={`${label} comparison`} className="flex flex-wrap items-center gap-2">
      <DenseInput aria-label={`${label} column`} list={columnsList} className="w-40" placeholder="column" value={value.col} onChange={(e) => onChange({ ...value, col: e.target.value })} />
      <DenseSelect
        aria-label={`${label} operator`}
        value={op}
        onChange={(e) => {
          const next = e.target.value as (typeof COMPARISON_OPS)[number];
          const base = { col: value.col, op: next };
          if (next === "is null" || next === "is not null") onChange(base);
          else if (next === "in" || next === "not in") onChange({ ...base, value: Array.isArray(raw) ? raw : raw === undefined ? [] : [raw] });
          else if (next === "between") onChange({ ...base, value: [pair[0] ?? 0, pair[1] ?? 0] });
          else onChange({ ...base, value: Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? "") });
        }}
      >
        {COMPARISON_OPS.map((o) => (
          <option key={o} value={o}>{OP_LABEL[o]}</option>
        ))}
      </DenseSelect>
      {needsNone ? null : between ? (
        <>
          <ValueInput label={`${label} from value`} className="w-28" value={pair[0]} onChange={(v) => onChange({ ...value, value: [v, pair[1] ?? 0] })} />
          <span className="text-xs text-faint">and</span>
          <ValueInput label={`${label} to value`} className="w-28" value={pair[1]} onChange={(v) => onChange({ ...value, value: [pair[0] ?? 0, v] })} />
        </>
      ) : list ? (
        <DenseInput aria-label={`${label} values (comma separated)`} className="w-56" placeholder="a, b, 3" value={formatLooseList(raw as SpecValue[] | undefined)} onChange={(e) => onChange({ ...value, value: parseLooseList(e.target.value) })} />
      ) : (
        <ValueInput label={`${label} value`} className="w-44" value={Array.isArray(raw) ? raw[0] : raw} onChange={(v) => onChange({ ...value, value: v })} />
      )}
      <Button size="sm" variant="ghost" aria-label={`${label} wrap in a group`} onClick={() => onChange({ and: [value] })} className="px-2">Group</Button>
      <Button size="sm" variant="ghost" aria-label={`${label} wrap in NOT`} onClick={() => onChange({ not: value })} className="px-2">NOT</Button>
      <RemoveButton label={`Remove ${label} condition`} onClick={() => onChange(undefined)} />
    </div>
  );
}

/** Optional condition slot (where / having / join on): shows an "Add" button until a condition exists. */
export function OptionalCondition({
  value,
  onChange,
  label,
  columnsList,
  addLabel,
}: {
  value: SpecCondition | undefined;
  onChange: (next: SpecCondition | undefined) => void;
  label: string;
  columnsList: string;
  addLabel: string;
}) {
  if (!value) {
    return (
      <div>
        <Button size="sm" onClick={() => onChange(blankComparison())}>{addLabel}</Button>
      </div>
    );
  }
  return <ConditionEditor value={value} label={label} columnsList={columnsList} onChange={onChange} />;
}
