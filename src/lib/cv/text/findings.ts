/** The one result type every text check returns. Findings are hints: the user and the model decide what to change. */

export type Severity = "info" | "warn" | "error";
export const SEVERITIES: readonly Severity[] = ["error", "warn", "info"];

export interface Finding {
  rule: string;
  severity: Severity;
  message: string;
  /** [start, end) offsets (UTF-16 code units) into the checked text. Absent for whole-text and list-level findings. */
  span?: [number, number];
  hint: string;
}

export type SeverityCounts = Record<Severity, number>;

export function countBySeverity(findings: Iterable<Finding>): SeverityCounts {
  const counts: SeverityCounts = { error: 0, warn: 0, info: 0 };
  for (const f of findings) counts[f.severity] += 1;
  return counts;
}

export function countByRule(findings: Iterable<Finding>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const f of findings) counts[f.rule] = (counts[f.rule] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** Build a finding without an explicit `span: undefined` key (keeps JSON and deepEqual output clean). */
export function finding(rule: string, severity: Severity, message: string, hint = "", span?: [number, number]): Finding {
  return span ? { rule, severity, message, span, hint } : { rule, severity, message, hint };
}
