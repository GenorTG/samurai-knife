export interface ParsedCronField {
  values: ReadonlySet<number>;
  any: boolean;
}

export interface ParsedCron {
  minute: ParsedCronField;
  hour: ParsedCronField;
  dayOfMonth: ParsedCronField;
  month: ParsedCronField;
  dayOfWeek: ParsedCronField;
}

export type CronParseResult =
  | { ok: true; value: ParsedCron }
  | { ok: false; error: string };

interface FieldSpec {
  label: string;
  min: number;
  max: number;
  sundayAlias?: boolean;
}

const FIELD_SPECS: readonly FieldSpec[] = [
  { label: "minute", min: 0, max: 59 },
  { label: "hour", min: 0, max: 23 },
  { label: "day of month", min: 1, max: 31 },
  { label: "month", min: 1, max: 12 },
  { label: "day of week", min: 0, max: 7, sundayAlias: true },
];

function parseField(raw: string, spec: FieldSpec): ParsedCronField | string {
  const values = new Set<number>();
  const parts = raw.split(",");
  if (parts.some((part) => !part)) return `Empty item in ${spec.label}.`;

  for (const part of parts) {
    const [range, stepText, ...extra] = part.split("/");
    if (extra.length || !range || (stepText !== undefined && !/^\d+$/.test(stepText))) {
      return `Invalid ${spec.label} item “${part}”.`;
    }

    const step = stepText === undefined ? 1 : Number(stepText);
    if (step < 1) return `The ${spec.label} step must be at least 1.`;

    let start = spec.min;
    let end = spec.max;
    if (range !== "*") {
      const rangeMatch = /^(\d+)(?:-(\d+))?$/.exec(range);
      if (!rangeMatch) return `Invalid ${spec.label} range “${range}”.`;
      start = Number(rangeMatch[1]);
      end = rangeMatch[2] === undefined ? (stepText === undefined ? start : spec.max) : Number(rangeMatch[2]);
      if (start < spec.min || start > spec.max || end < spec.min || end > spec.max) {
        return `${spec.label} values must be between ${spec.min} and ${spec.max}${spec.sundayAlias ? " (7 also means Sunday)" : ""}.`;
      }
      if (start > end) return `The ${spec.label} range must go from low to high.`;
    }

    for (let value = start; value <= end; value += step) {
      values.add(spec.sundayAlias && value === 7 ? 0 : value);
    }
  }

  return { values, any: raw === "*" };
}

export function parseCron(expression: string): CronParseResult {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    return { ok: false, error: "Use five fields: minute hour day-of-month month day-of-week." };
  }

  const parsed = fields.map((field, index) => parseField(field, FIELD_SPECS[index]));
  const issue = parsed.find((field): field is string => typeof field === "string");
  if (issue) return { ok: false, error: issue };

  return {
    ok: true,
    value: {
      minute: parsed[0] as ParsedCronField,
      hour: parsed[1] as ParsedCronField,
      dayOfMonth: parsed[2] as ParsedCronField,
      month: parsed[3] as ParsedCronField,
      dayOfWeek: parsed[4] as ParsedCronField,
    },
  };
}

export function matchesCronDate(cron: ParsedCron, date: Date): boolean {
  if (!cron.minute.values.has(date.getMinutes())) return false;
  if (!cron.hour.values.has(date.getHours())) return false;
  if (!cron.month.values.has(date.getMonth() + 1)) return false;

  const monthDayMatches = cron.dayOfMonth.values.has(date.getDate());
  const weekDayMatches = cron.dayOfWeek.values.has(date.getDay());
  if (cron.dayOfMonth.any && cron.dayOfWeek.any) return true;
  if (cron.dayOfMonth.any) return weekDayMatches;
  if (cron.dayOfWeek.any) return monthDayMatches;
  return monthDayMatches || weekDayMatches;
}

export function findNextCronRuns(
  cron: ParsedCron,
  count: number,
  after = new Date(),
): Date[] {
  const cursor = new Date(after);
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);

  const matches: Date[] = [];
  const limit = cursor.getTime() + 366 * 24 * 60 * 60 * 1000;
  while (cursor.getTime() <= limit && matches.length < count) {
    if (matchesCronDate(cron, cursor)) matches.push(new Date(cursor));
    cursor.setTime(cursor.getTime() + 60_000);
  }
  return matches;
}
