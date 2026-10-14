import type { CvLang, Profile } from "../schema";
import { countByRule, countBySeverity, type Finding, type SeverityCounts } from "./findings";
import { lintList, lintText, type TextKind } from "./lint";
import { checkPair } from "./translation";
import { biFields, sideOf, type BiField } from "./walk";

/** Profile-level and ad-hoc audits: the payloads behind `knife_cv_audit`, `knife_cv_translation_audit`, `knife_cv_lint_text` and `GET /api/cv/audit`. */

export interface AuditResult {
  lang: CvLang;
  scope: string;
  fieldsChecked: number;
  counts: SeverityCounts;
  byRule: Record<string, number>;
  /** Keyed by the editable path (`.../text/en`), in profile order. */
  findings: Record<string, Finding[]>;
}

export interface TranslationAuditResult {
  scope: string;
  pairsChecked: number;
  counts: SeverityCounts;
  byRule: Record<string, number>;
  /** Keyed by the path of the {pl,en} field (append /pl or /en to edit a side). */
  findings: Record<string, Finding[]>;
  /** Fields with text in EN but none in PL (and vice versa): the translation backlog. */
  missingPl: string[];
  missingEn: string[];
}

export interface LintTextResult {
  lang: CvLang;
  kind: TextKind;
  items: number;
  counts: SeverityCounts;
  findings: (Finding & { item?: number })[];
}

function summarize(grouped: Record<string, Finding[]>): { counts: SeverityCounts; byRule: Record<string, number> } {
  const flat = Object.values(grouped).flat();
  return { counts: countBySeverity(flat), byRule: countByRule(flat) };
}

/** Rules about typography only: the renderer fixes them automatically, so profile audits leave them out unless asked. */
const TYPOGRAPHY_RULES: ReadonlySet<string> = new Set(["nbsp-orphan"]);

/** Lint all profile text in one language. Bullet lists are linted as lists so list-level rules can fire. */
export function auditProfile(profile: Profile, lang: CvLang, scope = "/", options: { includeTypography?: boolean } = {}): AuditResult {
  const fields = biFields(profile, scope).filter((f) => sideOf(f, lang).trim());
  const grouped = new Map<string, Finding[]>();
  const lists = new Map<string, BiField[]>();
  for (const f of fields) {
    if (f.group !== null) {
      lists.set(f.group, [...(lists.get(f.group) ?? []), f]);
    } else {
      const found = lintText(sideOf(f, lang), lang, f.kind);
      if (found.length) grouped.set(`${f.path}/${lang}`, found);
    }
  }
  for (const members of lists.values()) {
    const perItem = lintList(members.map((m) => sideOf(m, lang)), lang);
    members.forEach((member, i) => {
      if (perItem[i].length) grouped.set(`${member.path}/${lang}`, perItem[i]);
    });
  }
  const order = new Map(fields.map((f, i) => [`${f.path}/${lang}`, i]));
  const keep = (list: Finding[]): Finding[] => (options.includeTypography ? list : list.filter((f) => !TYPOGRAPHY_RULES.has(f.rule)));
  const findings = Object.fromEntries(
    [...grouped]
      .sort(([a], [b]) => (order.get(a) ?? 0) - (order.get(b) ?? 0))
      .map(([path, list]) => [path, keep(list)] as const)
      .filter(([, list]) => list.length),
  );
  return { lang, scope, fieldsChecked: fields.length, ...summarize(findings), findings };
}

/** `checkPair` on every field with both sides; fields missing a side go to missingPl / missingEn. */
export function auditTranslation(profile: Profile, scope = "/"): TranslationAuditResult {
  const fields = biFields(profile, scope);
  const findings: Record<string, Finding[]> = {};
  const missingPl: string[] = [];
  const missingEn: string[] = [];
  let pairs = 0;
  for (const f of fields) {
    const hasPl = f.pl.trim() !== "";
    const hasEn = f.en.trim() !== "";
    if (hasPl && hasEn) {
      pairs += 1;
      const found = checkPair(f.pl, f.en);
      if (found.length) findings[f.path] = found;
    } else if (hasPl) {
      missingEn.push(f.path);
    } else if (hasEn) {
      missingPl.push(f.path);
    }
  }
  return { scope, pairsChecked: pairs, ...summarize(findings), findings, missingPl, missingEn };
}

const BULLET_MARK = /^\s*(?:[-*•]\s+)/;

/** Lint ad-hoc text. For kind=bullet, several lines are linted as a list (one bullet per line, markers stripped). */
export function lintAdHoc(text: string, lang: CvLang, kind: TextKind = "bullet"): LintTextResult {
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).map((l) => l.replace(BULLET_MARK, "").trim());
  if (kind === "bullet" && lines.length > 1) {
    const perItem = lintList(lines, lang);
    const findings = perItem.flatMap((fs, i) => fs.map((f) => ({ item: i + 1, ...f })));
    return { lang, kind, items: lines.length, counts: countBySeverity(perItem.flat()), findings };
  }
  const found = lintText(text, lang, kind);
  return { lang, kind, items: kind === "bullet" ? lines.length : 1, counts: countBySeverity(found), findings: found };
}
