"use client";

/** One node on the workflow canvas (React Flow custom node): inputs on the left, outputs on the right, run status. */
import { translator, type Translator } from "@/lib/i18n/core";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { memo } from "react";
import { cx } from "@/lib/format";
import { outputLabels, type NodeMeta, type WorkflowNode } from "@/lib/workflows/types";
import { useT } from "@/lib/i18n/react";

export interface NodeStatus {
  state: "running" | "success" | "error" | "waiting";
  counts?: number[];
  error?: string;
}

export type CardData = {
  node: WorkflowNode;
  meta: NodeMeta | undefined;
  status?: NodeStatus;
  onOpen: (name: string) => void;
};

export type CardNode = Node<CardData, "wf">;

function hostOf(value: unknown): string {
  const text = String(value ?? "");
  if (text.startsWith("=")) return "expression";
  try {
    return new URL(text).host;
  } catch {
    return text.slice(0, 28);
  }
}

/** "5 minutes" with the reader's plural forms; an unknown unit is shown as stored. */
function span(amount: number, unit: string, tn: Translator["tn"]): string {
  switch (unit) {
    case "seconds": return tn("{n} second", "{n} seconds", amount);
    case "minutes": return tn("{n} minute", "{n} minutes", amount);
    case "hours": return tn("{n} hour", "{n} hours", amount);
    case "days": return tn("{n} day", "{n} days", amount);
    case "weeks": return tn("{n} week", "{n} weeks", amount);
    case "months": return tn("{n} month", "{n} months", amount);
    default: return `${amount} ${unit}`;
  }
}

/** One line under the node name: what it is set to do. */
export function nodeSummary(node: WorkflowNode, meta: NodeMeta | undefined, { t, tn }: Pick<Translator, "t" | "tn"> = translator("en")): string {
  const p = node.parameters;
  switch (node.type) {
    case "core.http-request":
      return `${String(p.method ?? "GET")} ${hostOf(p.url)}`.trim();
    case "core.webhook":
      return `${String(p.httpMethod ?? "POST")} /${String(p.path ?? "")}`;
    case "core.schedule-trigger": {
      const rule = Array.isArray(p.rules) ? (p.rules[0] as Record<string, unknown> | undefined) : undefined;
      if (!rule) return t("every 15 minutes");
      return rule.every === "cron" ? `cron ${String(rule.cron ?? "")}` : t("every {span}", { span: span(Number(rule.amount ?? 1), String(rule.every ?? "minutes"), tn) });
    }
    case "core.code":
      return p.mode === "runOnceForEachItem" ? t("JavaScript, each item") : t("JavaScript, all items");
    case "core.set": {
      const count = Array.isArray(p.assignments) ? p.assignments.length : 0;
      return p.mode === "raw" ? "JSON" : tn("{n} field", "{n} fields", count);
    }
    case "core.wait":
      return p.resume === "webhook" ? t("until called") : p.resume === "specificTime" ? t("until a date") : span(Number(p.amount ?? 5), String(p.unit ?? "seconds"), tn);
    case "core.merge":
      return String(p.mode ?? "append");
    default:
      return meta?.label ? t(meta.label) : node.type;
  }
}

function hueOf(meta: NodeMeta | undefined): number {
  return meta?.hue ?? 220;
}

export const NodeCard = memo(function NodeCard({ data, selected }: NodeProps<CardNode>) {
  const i18nT = useT();
  const { t, tn } = i18nT;
  const { node, meta, status } = data;
  const inputs = meta?.inputs ?? 1;
  const outputs = meta ? outputLabels(meta, node.parameters) : ["main"];
  const allOutputs = node.onError === "errorOutput" ? [...outputs, "error"] : outputs;
  const trigger = inputs === 0;
  const hue = hueOf(meta);
  return (
    <div
      onDoubleClick={() => data.onOpen(node.name)}
      data-wf-node={node.name}
      className={cx(
        "group relative w-48 border bg-surface px-3 py-2.5 shadow-card transition-[box-shadow,border-color]",
        trigger ? "rounded-l-[2rem] rounded-r-xl" : "rounded-xl",
        selected ? "border-accent shadow-[0_0_0_2px_color-mix(in_oklab,var(--c-accent)_45%,transparent)]" : "border-line-strong",
        status?.state === "error" && "border-danger",
        status?.state === "success" && !selected && "border-good/70",
        node.disabled && "opacity-50",
      )}
      style={{ minHeight: Math.max(56, 22 * Math.max(inputs, allOutputs.length) + 12) }}
    >
      {Array.from({ length: inputs }, (_, index) => (
        <Handle key={`in-${index}`} id={`in-${index}`} type="target" position={Position.Left} style={{ top: `${((index + 1) / (inputs + 1)) * 100}%` }} className="!size-3 !border-2 !border-surface !bg-faint" />
      ))}
      <div className="flex items-start gap-2">
        <span
          aria-hidden
          className="mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-lg text-[13px] font-bold"
          style={{ color: `oklch(from var(--c-accent) l c ${hue})`, backgroundColor: `oklch(from var(--c-accent) l c ${hue} / 0.14)` }}
        >
          {trigger ? "⚡" : (meta?.label ?? "?").slice(0, 1)}
        </span>
        <div className="min-w-0 flex-1">
          <p className={cx("truncate text-[13px] font-semibold text-ink", node.disabled && "line-through")} title={node.name}>
            {node.name}
          </p>
          <p className="truncate text-[11px] text-muted" title={nodeSummary(node, meta, i18nT)}>
            {nodeSummary(node, meta, i18nT)}
          </p>
        </div>
      </div>
      {status ? (
        <p
          role="status"
          className={cx(
            "mt-1.5 truncate text-[11px] font-medium",
            status.state === "error" ? "text-danger" : status.state === "running" ? "text-accent-soft" : status.state === "waiting" ? "text-warn" : "text-good",
          )}
          title={status.error}
        >
          {status.state === "running" ? t("Running…") : status.state === "waiting" ? t("Waiting") : status.state === "error" ? (status.error ?? t("Failed")) : tn("{n} item", "{n} items", (status.counts ?? []).reduce((a, b) => a + b, 0))}
        </p>
      ) : null}
      {allOutputs.map((label, index) => (
        <div key={`out-${index}`} className="pointer-events-none absolute right-0 translate-x-full pl-2" style={{ top: `calc(${((index + 1) / (allOutputs.length + 1)) * 100}% - 8px)` }}>
          {allOutputs.length > 1 ? (
            <span className={cx("text-[10px] whitespace-nowrap", label === "error" ? "text-danger" : "text-faint")}>
              {label}
              {status?.counts?.[index] !== undefined ? ` · ${status.counts[index]}` : ""}
            </span>
          ) : null}
        </div>
      ))}
      {allOutputs.map((label, index) => (
        <Handle key={`h-out-${index}`} id={`out-${index}`} type="source" position={Position.Right} style={{ top: `${((index + 1) / (allOutputs.length + 1)) * 100}%` }} className={cx("!size-3 !border-2 !border-surface", label === "error" ? "!bg-danger" : "!bg-accent")} />
      ))}
    </div>
  );
});
