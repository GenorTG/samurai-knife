"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Button, CopyButton, Field, Notice, Panel, Select, Stat, StatGrid, TextArea, TextInput } from "@/components/ui";
import { cx } from "@/lib/format";
import { RegexRunner } from "@/lib/regex-client";
import type { RegexMatch } from "@/lib/regex-run";
import { buildGeneration, CLASS_LEGEND, type AnchorMode } from "@/lib/regexgen";

const SAMPLES: { label: string; pattern: string; flags: string; text: string }[] = [
  {
    label: "Emails",
    // Capture groups are deliberate: the default replacement template uses $1/$2.
    pattern: "([\\w.+-]+)@([\\w-]+\\.[\\w.-]+)",
    flags: "gi",
    text: "Contact genor@samurai.dev or support+team@mail.example.org.\nBad: @nope, nope@no",
  },
  {
    label: "ISO dates",
    pattern: "(\\d{4})-(\\d{2})-(\\d{2})",
    flags: "g",
    text: "Start 2026-10-01, end 2026-12-24, legacy 1999-01-07",
  },
  {
    label: "Markdown links",
    pattern: "\\[([^\\]]+)\\]\\((https?:\\/\\/[^)]+)\\)",
    flags: "g",
    text: "See [the docs](https://example.com/docs) and [repo](https://github.com/GenorTG).",
  },
];

const FLAG_INFO: Record<string, string> = {
  g: "global — every match, not just the first",
  i: "ignoreCase — case-insensitive",
  m: "multiline — ^ and $ match per line",
  s: "dotAll — . also matches newlines",
  u: "unicode — treat pattern as UTF-16 code points",
  y: "sticky — match only from lastIndex",
};

const GEN_PRESETS: { label: string; positives: string; negatives: string }[] = [
  {
    label: "Emails only",
    positives: "genor@samurai.dev\nsupport+team@mail.example.org",
    negatives: "@nope\nnope@no\nplain text",
  },
  {
    label: "Version tags",
    positives: "v1.2.3\nv10.0.42",
    negatives: "1.2.3\nv1.2\nversion 1.2.3",
  },
  {
    label: "Polish plates",
    positives: "PO 12345\nKR7X91 4",
    negatives: "PO 123\nP0 12345\nABCDEF",
  },
];

const MAX_MATCHES = 5000;
/** The highlighted subject and the replacement preview draw at most this many characters (laying out megabytes of text costs seconds). */
const HIGHLIGHT_LIMIT = 200_000;
/** Matches highlighted with a <mark> each (thousands of elements make every re-render slow). */
const HIGHLIGHT_MARKS = 1000;

type RunState =
  | { status: "idle" }
  | { status: "running"; since: number }
  | { status: "done" }
  | { status: "timeout" | "error"; message: string }
  | { status: "cancelled" };

interface RunResult {
  matches: RegexMatch[];
  truncated: boolean;
  replaced: string;
}
const NO_RESULT: RunResult = { matches: [], truncated: false, replaced: "" };

export default function RegexLab() {
  const [pattern, setPattern] = useState(SAMPLES[0].pattern);
  const [flags, setFlags] = useState(SAMPLES[0].flags);
  const [text, setText] = useState(SAMPLES[0].text);
  const [replacement, setReplacement] = useState("$1 <at> $2");
  const [positiveText, setPositiveText] = useState(GEN_PRESETS[0].positives);
  const [negativeText, setNegativeText] = useState(GEN_PRESETS[0].negatives);
  const [anchor, setAnchor] = useState<AnchorMode>("line");

  const generated = useMemo(
    () => buildGeneration(positiveText, negativeText, anchor),
    [anchor, negativeText, positiveText],
  );

  const compiled = useMemo(() => {
    if (!pattern) return { ok: true as const, re: null };
    try {
      return { ok: true as const, re: new RegExp(pattern, flags) };
    } catch (exc) {
      return { ok: false as const, message: exc instanceof Error ? exc.message : "Invalid pattern." };
    }
  }, [flags, pattern]);

  // The user's pattern runs in a worker with a 1 s budget: a catastrophic one is stopped instead of freezing the tab.
  const runnerRef = useRef<RegexRunner | null>(null);
  const cancelRef = useRef<AbortController | null>(null);
  const [run, setRun] = useState<RunState>({ status: "idle" });
  const [result, setResult] = useState<RunResult>(NO_RESULT);
  const [now, setNow] = useState(0);
  const runnable = compiled.ok && pattern !== "" && text !== "";

  useEffect(() => {
    const runner = new RegexRunner();
    runnerRef.current = runner;
    return () => {
      runner.dispose();
      runnerRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!runnable) return;
    const controller = new AbortController();
    let superseded = false;
    const timer = setTimeout(() => {
      cancelRef.current = controller;
      setRun({ status: "running", since: performance.now() });
      void runnerRef.current?.run({ pattern, flags, text, replacement, maxMatches: MAX_MATCHES }, controller.signal).then((outcome) => {
        if (superseded || cancelRef.current !== controller) return;
        cancelRef.current = null;
        if (outcome.status === "ok") {
          setResult(outcome.output);
          setRun({ status: "done" });
        } else {
          // Stopped runs leave nothing to show: stale matches belong to an older pattern.
          setResult(NO_RESULT);
          setRun(outcome.status === "cancelled" ? { status: "cancelled" } : { status: outcome.status, message: outcome.message });
        }
      });
    }, 40);
    return () => {
      superseded = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [flags, pattern, replacement, runnable, text]);

  const running = run.status === "running";
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(performance.now()), 250);
    return () => clearInterval(timer);
  }, [running]);

  const shown = runnable ? result : NO_RESULT;
  const matches = shown.matches;
  const replaced = runnable ? shown.replaced : "";

  const hasGroups = matches.some((m) => m.groups.length > 0);

  return (
    <div className="space-y-4">
      <Panel
        title="Generator — examples in, regex out"
        right={
          <div className="flex flex-wrap gap-1.5">
            <CopyButton text={generated?.pattern ?? ""} label="Copy regex" />
            <Button
              size="sm"
              variant="subtle"
              disabled={!generated}
              onClick={() => {
                if (!generated) return;
                setPattern(generated.pattern);
                setFlags(generated.flags);
              }}
            >
              Use in pattern
            </Button>
            <Button
              size="sm"
              variant="subtle"
              disabled={!generated}
              onClick={() => setText(generated!.positives.join("\n"))}
            >
              Load as subject
            </Button>
          </div>
        }
      >
        <div className="space-y-3">
          <div className="grid gap-3 lg:grid-cols-2">
            <Field label="Must match" hint="One example per line. These define the shape.">
              <TextArea
                rows={5}
                spellCheck={false}
                value={positiveText}
                onChange={(e) => setPositiveText(e.target.value)}
                placeholder={"genor@samurai.dev\nsupport+team@mail.example.org"}
                className="font-mono text-[13px]"
              />
            </Field>
            <Field label="Must NOT match" hint="Used to build look-ahead guards.">
              <TextArea
                rows={5}
                spellCheck={false}
                value={negativeText}
                onChange={(e) => setNegativeText(e.target.value)}
                placeholder={"@nope\nnope@no"}
                className="font-mono text-[13px]"
              />
            </Field>
          </div>

          <div className="flex flex-wrap items-end gap-2">
            <Select
              value={anchor}
              onChange={(e) => setAnchor(e.target.value as AnchorMode)}
              className="w-44"
            >
              <option value="line">Whole line (^…$)</option>
              <option value="string">Whole string</option>
              <option value="off">Anywhere</option>
            </Select>
            <div className="flex flex-wrap gap-1.5 pb-1">
              {GEN_PRESETS.map((preset) => (
                <Button
                  key={preset.label}
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setPositiveText(preset.positives);
                    setNegativeText(preset.negatives);
                  }}
                >
                  {preset.label}
                </Button>
              ))}
            </div>
          </div>

          {generated ? (
            <div className="space-y-3">
              <pre className="sk-input overflow-auto px-3 py-2.5 font-mono text-[13px] leading-relaxed whitespace-pre-wrap break-all text-accent-soft">
                /{generated.pattern}/{generated.flags}
              </pre>

              <StatGrid>
                <Stat
                  label="Positives matched"
                  value={`${generated.positiveHits.filter(Boolean).length}/${generated.positives.length}`}
                />
                <Stat
                  label="Negatives rejected"
                  value={`${generated.negatives.length - generated.negativeHits.filter(Boolean).length}/${generated.negatives.length}`}
                />
                <Stat label="Guards" value={generated.guards.length} />
              </StatGrid>

              {generated.clean ? (
                <Notice tone="good">Every positive matches and no negative does — verified against these examples.</Notice>
              ) : (
                <Notice tone="error">
                  Not clean. The examples below show exactly which ones fail — add a positive to
                  teach the shape, or a negative to sharpen the guard.
                </Notice>
              )}

              <div className="grid gap-2 sm:grid-cols-2">
                <ul className="space-y-1">
                  {generated.positives.map((sample, index) => (
                    <li
                      key={`p-${index}`}
                      className={cx(
                        "rounded-md border px-2 py-1 font-mono text-[12px] break-all",
                        generated.positiveHits[index]
                          ? "border-good/30 bg-good/10 text-ink"
                          : "border-danger/40 bg-danger/10 text-danger",
                      )}
                    >
                      {generated.positiveHits[index] ? "✓ " : "✗ "}
                      {sample}
                    </li>
                  ))}
                </ul>
                <ul className="space-y-1">
                  {generated.negatives.map((sample, index) => (
                    <li
                      key={`n-${index}`}
                      className={cx(
                        "rounded-md border px-2 py-1 font-mono text-[12px] break-all",
                        generated.negativeHits[index]
                          ? "border-danger/40 bg-danger/10 text-danger"
                          : "border-good/30 bg-good/10 text-ink",
                      )}
                    >
                      {generated.negativeHits[index] ? "✗ matches" : "✓ rejected"} {sample}
                    </li>
                  ))}
                </ul>
              </div>

              {generated.notes.length ? (
                <ul className="space-y-1 text-xs text-muted">
                  {generated.notes.map((note, index) => (
                    <li key={index}>• {note}</li>
                  ))}
                </ul>
              ) : null}

              <details className="text-xs text-faint">
                <summary className="cursor-pointer">What the atoms mean</summary>
                <ul className="mt-2 space-y-1">
                  {CLASS_LEGEND.map(([atom, meaning]) => (
                    <li key={atom}>
                      <code className="font-mono text-ink">{atom}</code> — {meaning}
                    </li>
                  ))}
                </ul>
                <p className="mt-2">
                  A guard is a look-ahead that rejects any string containing that exact
                  substring. It is the shortest one that separates the negatives from the positives.
                </p>
              </details>
            </div>
          ) : (
            <p className="text-sm text-faint">Add at least one positive example.</p>
          )}
        </div>
      </Panel>

      <Panel title="Pattern">
        <div className="space-y-3">
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Regex" className="min-w-[240px] flex-1">
              <TextInput
                value={pattern}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                onChange={(e) => setPattern(e.target.value)}
                placeholder="pattern…"
                className="font-mono"
              />
            </Field>
            <Field label="Flags" className="w-28">
              <TextInput
                value={flags}
                spellCheck={false}
                autoCapitalize="off"
                onChange={(e) => setFlags(e.target.value.replace(/[^gimsuy]/g, ""))}
                placeholder="gi"
                className="font-mono"
              />
            </Field>
          </div>

          <div className="flex flex-wrap gap-1.5">
            {Object.entries(FLAG_INFO).map(([flag, info]) => (
              <button
                autoComplete="off"
                key={flag}
                type="button"
                title={info}
                onClick={() => setFlags((current) => (current.includes(flag) ? current.replace(flag, "") : current + flag))}
                className={cx(
                  "rounded-md border px-2 py-1 font-mono text-[11px] transition-colors",
                  flags.includes(flag)
                    ? "border-accent/40 bg-accent/10 text-accent-soft"
                    : "border-line bg-surface text-faint hover:text-ink",
                )}
              >
                {flag}
              </button>
            ))}
            <span className="ml-auto font-mono text-[11px] text-faint">
              {compiled.ok ? `${matches.length} match${matches.length === 1 ? "" : "es"}` : "—"}
            </span>
          </div>

          {!compiled.ok ? <Notice tone="error">{compiled.message}</Notice> : null}

          <div role="status" aria-live="polite" data-agent-region="match-status" className="space-y-2">
            {runnable && run.status === "running" && now - run.since > 300 ? (
              <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
                <span>Matching… {((now - run.since) / 1000).toFixed(1)} s (stops automatically after 1 s)</span>
                <Button size="sm" variant="danger" onClick={() => cancelRef.current?.abort()}>Cancel matching</Button>
              </div>
            ) : null}
            {runnable && run.status === "cancelled" ? <Notice>Matching cancelled. Edit the pattern or subject to run again.</Notice> : null}
            {runnable && shown.truncated ? <Notice tone="warn">Showing the first {MAX_MATCHES.toLocaleString("en-US")} matches only.</Notice> : null}
          </div>
          {runnable && (run.status === "timeout" || run.status === "error") ? (
            <div role="alert">
              <Notice tone="error">{run.message}</Notice>
            </div>
          ) : null}

          <div className="flex flex-wrap gap-1.5">
            {SAMPLES.map((sample) => (
              <Button
                key={sample.label}
                size="sm"
                variant="subtle"
                onClick={() => {
                  setPattern(sample.pattern);
                  setFlags(sample.flags);
                  setText(sample.text);
                }}
              >
                {sample.label}
              </Button>
            ))}
          </div>
        </div>
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Subject">
          <TextArea
            rows={12}
            spellCheck={false}
            value={text}
            onChange={(e) => setText(e.target.value)}
            aria-label="Subject text"
            placeholder="Paste the text to test against…"
          />
        </Panel>

        <Panel
          title="Highlighted"
          right={<span className="font-mono text-[11px] text-faint">{matches.length} hits</span>}
        >
          <pre className="sk-input max-h-[42vh] overflow-auto px-3 py-2.5 font-mono text-[12px] leading-relaxed whitespace-pre-wrap break-words">
            {(() => {
              const visible = text.length > HIGHLIGHT_LIMIT ? text.slice(0, HIGHLIGHT_LIMIT) : text;
              if (matches.length === 0) {
                return <span className="text-faint">{visible || "No text."}</span>;
              }
              const nodes: React.ReactNode[] = [];
              let cursor = 0;
              for (const [index, match] of matches.entries()) {
                if (index >= HIGHLIGHT_MARKS || match.index + match.length > visible.length) break;
                if (match.index > cursor) nodes.push(visible.slice(cursor, match.index));
                nodes.push(
                  <mark
                    key={`${match.index}-${index}`}
                    className="rounded bg-accent/25 px-0.5 text-accent-soft"
                  >
                    {match.value}
                  </mark>,
                );
                cursor = match.index + match.length;
              }
              nodes.push(visible.slice(cursor));
              return nodes;
            })()}
          </pre>
          {text.length > HIGHLIGHT_LIMIT || matches.length > HIGHLIGHT_MARKS ? (
            <p className="mt-2 text-xs text-faint" data-agent-region="highlight-limit">
              Highlighting shows at most the first {HIGHLIGHT_LIMIT.toLocaleString("en-US")} characters and {HIGHLIGHT_MARKS.toLocaleString("en-US")} matches; all {matches.length.toLocaleString("en-US")} matches are still counted and listed.
            </p>
          ) : null}
        </Panel>
      </div>

      {hasGroups ? (
        <Panel title="Capture groups" bodyClassName="p-0">
          <div className="max-h-[32vh] overflow-auto">
            <table className="w-full border-collapse text-left text-[13px]">
              <thead className="sticky top-0 bg-raised">
                <tr>
                  <th className="border-b border-line px-3 py-2 font-mono text-[11px] text-faint uppercase">#</th>
                  <th className="border-b border-line px-3 py-2 font-mono text-[11px] text-faint uppercase">Match</th>
                  {Array.from({ length: Math.max(...matches.map((m) => m.groups.length)) }, (_, i) => (
                    <th key={i} className="border-b border-line px-3 py-2 font-mono text-[11px] text-faint uppercase">
                      ${i + 1}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {matches.slice(0, 300).map((match, index) => (
                  <tr key={`${match.index}-${index}`} className="odd:bg-surface/60">
                    <td className="border-b border-line/60 px-3 py-1.5 font-mono text-[12px] text-faint tabular-nums">
                      {index + 1}
                    </td>
                    <td className="border-b border-line/60 px-3 py-1.5 font-mono text-[12px] text-ink break-all">
                      {match.value}
                    </td>
                    {match.groups.map((group, groupIndex) => (
                      <td
                        key={groupIndex}
                        className="border-b border-line/60 px-3 py-1.5 font-mono text-[12px] text-accent-soft break-all"
                      >
                        {group}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      ) : null}

      <Panel
        title="Replace"
        right={
          <div className="flex gap-1.5">
            <CopyButton text={replaced} />
            <Button size="sm" variant="subtle" disabled={!replaced} onClick={() => setText(replaced)}>
              Apply to subject
            </Button>
          </div>
        }
      >
        <div className="space-y-3">
          <Field label="Replacement" hint="Use $1, $2… for groups. $& is the whole match, $` the text before, $' after.">
            <TextInput
              value={replacement}
              spellCheck={false}
              onChange={(e) => setReplacement(e.target.value)}
              placeholder="$1 — $2"
              className="font-mono"
            />
          </Field>
          <StatGrid>
            <Stat label="Input chars" value={text.length} />
            <Stat label="Output chars" value={replaced.length} />
            <Stat label="Replacements" value={flags.includes("g") ? matches.length : Math.min(1, matches.length)} />
          </StatGrid>
          <pre className="sk-input max-h-[32vh] overflow-auto px-3 py-2.5 font-mono text-[12px] leading-relaxed whitespace-pre-wrap break-words">
            {replaced ? (replaced.length > HIGHLIGHT_LIMIT ? replaced.slice(0, HIGHLIGHT_LIMIT) : replaced) : <span className="text-faint">Nothing replaced.</span>}
          </pre>
          {replaced.length > HIGHLIGHT_LIMIT ? (
            <p className="text-xs text-faint">
              Preview shows the first {HIGHLIGHT_LIMIT.toLocaleString("en-US")} characters; Copy and Apply use the full {replaced.length.toLocaleString("en-US")}.
            </p>
          ) : null}
        </div>
      </Panel>
    </div>
  );
}
