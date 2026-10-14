"use client";

import { useMemo, useState } from "react";
import { Field, Notice, Panel, Select, TextInput } from "@/components/ui";

type Version = { major: number; minor: number; patch: number; pre: string[] };
function parseVersion(input: string): Version | null {
  const match = input.trim().replace(/^v/, "").match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) return null;
  const pre = match[4]?.split(".") ?? [];
  if (pre.some((part) => !part || (/^\d+$/.test(part) && part.length > 1 && part.startsWith("0")))) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), pre };
}
function compare(a: Version, b: Version): number {
  for (const key of ["major", "minor", "patch"] as const) if (a[key] !== b[key]) return a[key] - b[key];
  if (!a.pre.length || !b.pre.length) return a.pre.length === b.pre.length ? 0 : a.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i += 1) {
    const left = a.pre[i], right = b.pre[i];
    if (left === undefined || right === undefined) return left === undefined ? -1 : 1;
    if (left === right) continue;
    const ln = /^\d+$/.test(left), rn = /^\d+$/.test(right);
    if (ln && rn) return Number(left) - Number(right);
    if (ln !== rn) return ln ? -1 : 1;
    return left < right ? -1 : 1; // spec: ASCII order, not locale order
  }
  return 0;
}
type Triple = [number, number, number];
const cmpTriple = (v: Version, t: Triple): number => v.major - t[0] || v.minor - t[1] || v.patch - t[2];

/** Partial / wildcard versions ("1", "1.2", "1.x", "*"): numeric prefix, the rest unconstrained. */
function parsePartial(raw: string): (number | null)[] | null {
  const match = raw.match(/^v?(\d+|x|\*)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?$/i);
  if (!match || (match[3] !== undefined && /^\d+$/.test(match[3]) && /^\d+$/.test(match[2]) && /^\d+$/.test(match[1]))) return null; // full versions parse strictly
  const out: (number | null)[] = [];
  let open = false;
  for (const part of [match[1], match[2], match[3]]) {
    if (part === undefined || /^[x*]$/i.test(part)) open = true;
    out.push(open ? null : Number(part));
  }
  return out;
}

function partialMatch(version: Version, operator: string, [a, b]: (number | null)[]): boolean {
  const floor: Triple = [a ?? 0, b ?? 0, 0];
  // First version past the partial (1 -> 2.0.0, 1.2 -> 1.3.0).
  const next: Triple = b === null ? [(a ?? 0) + 1, 0, 0] : [a ?? 0, b + 1, 0];
  if (a === null) return operator === "" || operator === "=" || operator === "^" || operator === "~" || operator === ">=" || operator === "<=";
  if (operator === ">=") return cmpTriple(version, floor) >= 0;
  if (operator === ">") return cmpTriple(version, next) >= 0;
  if (operator === "<=") return cmpTriple(version, next) < 0;
  if (operator === "<") return cmpTriple(version, floor) < 0;
  const inside = cmpTriple(version, floor) >= 0 && cmpTriple(version, next) < 0;
  if (operator === "^") {
    const upper: Triple = a > 0 || b === null ? [a + 1, 0, 0] : [0, b + 1, 0];
    return cmpTriple(version, floor) >= 0 && cmpTriple(version, a === 0 && b === null ? [1, 0, 0] : upper) < 0;
  }
  return inside; // "", "=", "~"
}

function matches(version: Version, input: string): boolean {
  const normalized = input
    .replace(/(\S+)\s+-\s+(\S+)/g, ">=$1 <=$2") // hyphen ranges
    .replace(/(\^|~>?|>=|<=|>|<|=)\s+/g, "$1"); // "> 1.2.3"
  const disjunctions = normalized.split("||").map((part) => part.trim()).filter(Boolean);
  return disjunctions.some((part) => {
    const tokens = part.replace(/,/g, " ").split(/\s+/).filter(Boolean);
    if (!tokens.length) return false;
    const admitted: Triple[] = []; // prereleases only match inside a tuple a comparator names with a prerelease
    const ok = tokens.every((token) => {
      const match = token.match(/^(\^|~>?|>=|<=|>|<|=)?(.+)$/);
      if (!match) return false;
      const operator = (match[1] ?? "").replace("~>", "~");
      const raw = match[2];
      const partial = parsePartial(raw);
      if (partial) return partialMatch(version, operator, partial);
      const target = parseVersion(raw);
      if (!target) return false;
      if (target.pre.length) admitted.push([target.major, target.minor, target.patch]);
      if (operator === "^") {
        const upper = target.major ? { ...target, major: target.major + 1, minor: 0, patch: 0, pre: [] }
          : target.minor ? { ...target, minor: target.minor + 1, patch: 0, pre: [] }
            : { ...target, patch: target.patch + 1, pre: [] };
        return compare(version, target) >= 0 && compare(version, upper) < 0;
      }
      if (operator === "~") {
        const upper = { ...target, minor: target.minor + 1, patch: 0, pre: [] };
        return compare(version, target) >= 0 && compare(version, upper) < 0;
      }
      const order = compare(version, target);
      if (operator === ">=") return order >= 0;
      if (operator === ">") return order > 0;
      if (operator === "<=") return order <= 0;
      if (operator === "<") return order < 0;
      return order === 0;
    });
    if (!ok) return false;
    return !version.pre.length || admitted.some((t) => cmpTriple(version, t) === 0);
  });
}

export default function SemverChecker() {
  const [versionText, setVersionText] = useState("1.8.4");
  const [range, setRange] = useState("^1.4.0 || ~2.0.1");
  const [other, setOther] = useState("2.0.0-rc.1");
  const version = useMemo(() => parseVersion(versionText), [versionText]);
  const comparison = useMemo(() => {
    const parsed = parseVersion(other);
    return version && parsed ? compare(version, parsed) : null;
  }, [other, version]);
  const satisfied = version ? matches(version, range) : null;
  return <Panel title="Semantic version checker">
    <div className="space-y-3"><div className="grid gap-3 sm:grid-cols-2"><Field label="Version"><TextInput spellCheck={false} value={versionText} onChange={(e) => setVersionText(e.target.value)} /></Field><Field label="Range"><TextInput spellCheck={false} value={range} onChange={(e) => setRange(e.target.value)} /></Field></div>
      {version ? <Notice tone={satisfied ? "good" : "info"}>{satisfied ? "Version satisfies this range." : "Version does not satisfy this range."}</Notice> : <Notice tone="error">Version must be a full major.minor.patch semantic version.</Notice>}
      <div className="grid gap-3 sm:grid-cols-2"><Field label="Compare against"><TextInput spellCheck={false} value={other} onChange={(e) => setOther(e.target.value)} /></Field><Field label="Comparison"><Select value="" disabled><option>{comparison === null ? "Enter two valid versions" : comparison < 0 ? "First version is older" : comparison > 0 ? "First version is newer" : "Versions are equal"}</option></Select></Field></div>
      <p className="text-xs text-faint">Supports full semver versions (including prereleases/build metadata), whitespace/comma AND, || OR, exact/comparator, caret, tilde, partial versions (1, 1.2), x/* wildcards and hyphen ranges. This is a common-range checker, not a complete npm range implementation (no loose parsing or includePrerelease).</p>
    </div>
  </Panel>;
}
