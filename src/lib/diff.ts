/**
 * Line diff, shared by the Diff tool UI and the MCP surface.
 *
 * Myers' O(ND) edit script over lines, then a word-level pass inside changed
 * pairs so the reader sees *what* changed, not just that it did. This module is
 * data-only — no React, no DOM — so a route handler can call it directly.
 */

export type DiffKind = "same" | "del" | "ins";

export interface DiffOp {
  kind: DiffKind;
  text: string;
  /** The line is the last one of its side and has no line terminator (the patch says so with `\ No newline at end of file`). */
  noEol?: boolean;
}

export interface MarkedWord {
  word: string;
  mark: boolean;
}

export interface DiffRow {
  kind: "same" | "del" | "ins" | "change";
  left: MarkedWord[];
  right: MarkedWord[];
}

export const MAX_DIFF_LINES = 2000;

function backtrack(trace: Int32Array[], a: string[], b: string[]): DiffOp[] {
  const ops: DiffOp[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = trace.length - 1; d > 0; d -= 1) {
    const v = trace[d];
    const offset = a.length + b.length;
    const k = x - y;
    const prevK = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? k + 1 : k - 1;
    const prevX = v[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ kind: "same", text: a[x - 1] });
      x -= 1;
      y -= 1;
    }
    if (x === prevX) {
      ops.push({ kind: "ins", text: b[prevY] });
      y -= 1;
    } else {
      ops.push({ kind: "del", text: a[prevX] });
      x -= 1;
    }
  }
  while (x > 0 && y > 0) {
    ops.push({ kind: "same", text: a[x - 1] });
    x -= 1;
    y -= 1;
  }
  while (x > 0) {
    ops.push({ kind: "del", text: a[x - 1] });
    x -= 1;
  }
  while (y > 0) {
    ops.push({ kind: "ins", text: b[y - 1] });
    y -= 1;
  }
  return ops.reverse();
}

export function diffLines(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max;
  const v = new Int32Array(2 * max + 1);
  const trace: Int32Array[] = [];

  for (let d = 0; d <= max; d += 1) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])
        ? v[offset + k + 1]
        : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, a, b);
    }
  }
  return backtrack(trace, a, b);
}

/** Word-level marks: trim the common prefix/suffix, mark the middle. */
export function wordMarks(left: string, right: string): { left: MarkedWord[]; right: MarkedWord[] } {
  const split = (line: string) => line.match(/\s+|\S+/g) ?? [];
  const a = split(left);
  const b = split(right);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail += 1;
  }
  const pack = (words: string[]): MarkedWord[] => [
    ...words.slice(0, head).map((word) => ({ word, mark: false })),
    ...words.slice(head, words.length - tail).map((word) => ({ word, mark: true })),
    ...words.slice(words.length - tail).map((word) => ({ word, mark: false })),
  ];
  return { left: pack(a), right: pack(b) };
}

/** Group consecutive del/ins runs into side-by-side rows with word marks. */
export function diffRows(ops: DiffOp[]): DiffRow[] {
  const rows: DiffRow[] = [];
  let index = 0;
  while (index < ops.length) {
    const op = ops[index];
    if (op.kind === "same") {
      rows.push({
        kind: "same",
        left: [{ word: op.text, mark: false }],
        right: [{ word: op.text, mark: false }],
      });
      index += 1;
      continue;
    }
    const dels: string[] = [];
    const inss: string[] = [];
    while (index < ops.length && ops[index].kind === "del") {
      dels.push(ops[index].text);
      index += 1;
    }
    while (index < ops.length && ops[index].kind === "ins") {
      inss.push(ops[index].text);
      index += 1;
    }
    const pairs = Math.max(dels.length, inss.length);
    for (let i = 0; i < pairs; i += 1) {
      const leftLine = dels[i];
      const rightLine = inss[i];
      if (leftLine !== undefined && rightLine !== undefined) {
        const marks = wordMarks(leftLine, rightLine);
        rows.push({ kind: "change", left: marks.left, right: marks.right });
      } else if (leftLine !== undefined) {
        rows.push({ kind: "del", left: [{ word: leftLine, mark: true }], right: [] });
      } else {
        rows.push({ kind: "ins", left: [], right: [{ word: rightLine as string, mark: true }] });
      }
    }
  }
  return rows;
}

export function diffStats(ops: DiffOp[]): { added: number; removed: number; unchanged: number } {
  let added = 0;
  let removed = 0;
  let unchanged = 0;
  for (const op of ops) {
    if (op.kind === "ins") added += 1;
    else if (op.kind === "del") removed += 1;
    else unchanged += 1;
  }
  return { added, removed, unchanged };
}

export const PATCH_CONTEXT_LINES = 3;
const NO_EOL_MARKER = "\\ No newline at end of file";

/** `start` or `start,len` the way `diff -u` writes a hunk range (the length is dropped when it is 1). */
function hunkRange(start: number, length: number): string {
  return length === 1 ? `${start}` : `${start},${length}`;
}

/**
 * A real unified diff that `patch` and `git apply` accept: `---`/`+++` headers, `@@ -a,b +c,d @@` hunks with
 * `context` lines around every change (hunks whose context touches are merged), a "no newline" marker where a side's
 * last line has no terminator, and a final newline. Identical inputs give "" like `diff -u` (no headers, no hunks).
 */
export function unifiedPatch(ops: DiffOp[], labelA = "left", labelB = "right", context = PATCH_CONTEXT_LINES): string {
  // Old/new line counts before each op: they give every hunk its start lines.
  const oldBefore: number[] = [];
  const newBefore: number[] = [];
  let oldCount = 0;
  let newCount = 0;
  for (const op of ops) {
    oldBefore.push(oldCount);
    newBefore.push(newCount);
    if (op.kind !== "ins") oldCount += 1;
    if (op.kind !== "del") newCount += 1;
  }

  // Each change claims `context` ops on both sides; claims that touch or overlap become one hunk.
  const ranges: { from: number; to: number }[] = [];
  ops.forEach((op, index) => {
    if (op.kind === "same") return;
    const from = Math.max(0, index - context);
    const to = Math.min(ops.length - 1, index + context);
    const last = ranges[ranges.length - 1];
    if (last && from <= last.to + 1) last.to = Math.max(last.to, to);
    else ranges.push({ from, to });
  });
  if (!ranges.length) return "";

  const lines: string[] = [`--- ${labelA}`, `+++ ${labelB}`];
  for (const { from, to } of ranges) {
    const slice = ops.slice(from, to + 1);
    const oldLength = slice.filter((op) => op.kind !== "ins").length;
    const newLength = slice.filter((op) => op.kind !== "del").length;
    // An empty side is addressed by the line before the hunk (0 at the top of the file).
    const oldStart = oldLength === 0 ? oldBefore[from] : oldBefore[from] + 1;
    const newStart = newLength === 0 ? newBefore[from] : newBefore[from] + 1;
    lines.push(`@@ -${hunkRange(oldStart, oldLength)} +${hunkRange(newStart, newLength)} @@`);
    for (const op of slice) {
      const prefix = op.kind === "same" ? " " : op.kind === "del" ? "-" : "+";
      lines.push(`${prefix}${op.text}`);
      if (op.noEol) lines.push(NO_EOL_MARKER);
    }
  }
  return `${lines.join("\n")}\n`;
}

/** "2 added · 2 removed · 2 unchanged": the words are invariant, they are not nouns to pluralise. */
export function diffSummary({ added, removed, unchanged }: { added: number; removed: number; unchanged: number }): string {
  return `${added} added · ${removed} removed · ${unchanged} unchanged`;
}

/**
 * Lines of a text as diff tokens. A trailing newline ends the last line instead of starting an empty one; a last line
 * without one gets a "\n" suffix — it can never occur inside a line — so "b" and "b⏎" are different lines, as in `diff`.
 */
function lineTokens(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  else lines[lines.length - 1] += "\n";
  return lines;
}

function tokenOps(a: string[], b: string[]): DiffOp[] {
  return diffLines(a, b).map(({ kind, text }): DiffOp =>
    text.endsWith("\n") ? { kind, text: text.slice(0, -1), noEol: true } : { kind, text },
  );
}

export interface DiffResult {
  ok: boolean;
  error?: string;
  ops: DiffOp[];
  rows: DiffRow[];
  patch: string;
  added: number;
  removed: number;
  unchanged: number;
}

/** One entry point for both UI and server callers. */
export function computeDiff(leftText: string, rightText: string, maxLines = MAX_DIFF_LINES): DiffResult {
  const a = lineTokens(leftText);
  const b = lineTokens(rightText);
  if (a.length > maxLines || b.length > maxLines) {
    return {
      ok: false,
      error: `Too many lines (${Math.max(a.length, b.length)}); the cap is ${maxLines} per side.`,
      ops: [],
      rows: [],
      patch: "",
      added: 0,
      removed: 0,
      unchanged: 0,
    };
  }
  const ops = tokenOps(a, b);
  const { added, removed, unchanged } = diffStats(ops);
  return {
    ok: true,
    ops,
    rows: diffRows(ops),
    patch: unifiedPatch(ops),
    added,
    removed,
    unchanged,
  };
}
