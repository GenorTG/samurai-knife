"use client";

import { useMemo, useState } from "react";
import { Button, CopyButton, Field, Notice, OutputBlock, Panel, Select, Stat, StatGrid, TextArea, WorkStatus } from "@/components/ui";
import { downloadText, formatInt } from "@/lib/format";
import { runTextKit, TEXTKIT_INLINE_LIMIT, TEXTKIT_PREVIEW_LIMIT, type Operation, type TextKitInput } from "@/lib/textkit";
import { runTextKitInWorker } from "@/lib/textkit-client";
import { useAdaptive } from "@/lib/workers/use-offloaded";

const OPERATIONS: { value: Operation; label: string; group: string }[] = [
  { value: "upper", label: "UPPERCASE", group: "Case" },
  { value: "lower", label: "lowercase", group: "Case" },
  { value: "title", label: "Title Case", group: "Case" },
  { value: "sentence", label: "Sentence case", group: "Case" },
  { value: "snake", label: "snake_case", group: "Case" },
  { value: "kebab", label: "kebab-case", group: "Case" },
  { value: "camel", label: "camelCase", group: "Case" },
  { value: "slug", label: "slug (ascii, no accents)", group: "Case" },
  { value: "dedupe", label: "Dedupe lines", group: "Lines" },
  { value: "sort", label: "Sort lines A→Z", group: "Lines" },
  { value: "reverse", label: "Reverse line order", group: "Lines" },
  { value: "trim", label: "Trim + drop blanks", group: "Lines" },
  { value: "number", label: "Number lines", group: "Lines" },
  { value: "base64", label: "Encode Base64", group: "Encode" },
  { value: "unbase64", label: "Decode Base64", group: "Encode" },
  { value: "urlencode", label: "URL-encode", group: "Encode" },
  { value: "urldecode", label: "URL-decode", group: "Encode" },
  { value: "html", label: "Escape HTML entities", group: "Encode" },
  { value: "unhtml", label: "Unescape HTML entities", group: "Encode" },
  { value: "strip", label: "Strip all whitespace", group: "Encode" },
];

const GROUPS = ["Case", "Lines", "Encode"];

export default function TextKit() {
  const [input, setInput] = useState("");
  const [op, setOp] = useState<Operation>("title");
  const [chain, setChain] = useState<Operation[]>([]);

  const request = useMemo<TextKitInput>(() => ({ text: input, steps: [...chain, op] }), [chain, input, op]);
  const job = useAdaptive(runTextKit, runTextKitInWorker, request, input.length <= TEXTKIT_INLINE_LIMIT);
  const result = job.value;
  const running = job.status === "running";
  const output = result?.output ?? "";
  const error = result?.error ?? null;
  const preview = output.length > TEXTKIT_PREVIEW_LIMIT ? output.slice(0, TEXTKIT_PREVIEW_LIMIT) : output;
  const stats = { chars: result?.chars ?? 0, words: result?.words ?? 0, lines: result?.lines ?? 0, outChars: result?.outChars ?? 0 };

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,300px)_minmax(0,1fr)]">
      <Panel title="Transform">
        <div className="space-y-4">
          {GROUPS.map((group) => (
            <div key={group} className="space-y-1.5">
              <p className="sk-label">{group}</p>
              <div className="flex flex-wrap gap-1.5">
                {OPERATIONS.filter((o) => o.group === group).map((operation) => (
                  <Button
                    key={operation.value}
                    size="sm"
                    variant={op === operation.value ? "primary" : "subtle"}
                    onClick={() => setOp(operation.value)}
                  >
                    {operation.label}
                  </Button>
                ))}
              </div>
            </div>
          ))}

          <Field label="Chain" hint="Applied before the picked transform, in order.">
            <Select
              value=""
              onChange={(e) => {
                const value = e.target.value as Operation;
                if (value) setChain((current) => [...current, value]);
              }}
            >
              <option value="">Add a step…</option>
              {OPERATIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.group} · {o.label}
                </option>
              ))}
            </Select>
          </Field>

          {chain.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5">
              {chain.map((step, index) => (
                <button
                  autoComplete="off"
                  key={`${step}-${index}`}
                  type="button"
                  title="Remove step"
                  onClick={() => setChain((current) => current.filter((_, i) => i !== index))}
                  className="rounded-md border border-line-strong/60 px-2 py-1 font-mono text-[11px] text-muted hover:border-danger/50 hover:text-danger"
                >
                  {OPERATIONS.find((o) => o.value === step)?.label ?? step} ×
                </button>
              ))}
              <Button size="sm" variant="ghost" onClick={() => setChain([])}>
                Reset chain
              </Button>
            </div>
          ) : null}
        </div>
      </Panel>

      <div className="space-y-4">
        <Panel
          title="Input"
          right={
            <div className="flex gap-1.5">
              <Button size="sm" variant="ghost" onClick={() => setInput("")}>Clear</Button>
              <Button
                size="sm"
                variant="subtle"
                disabled={!output || running}
                onClick={() => setInput(output)}
              >
                Output → input
              </Button>
            </div>
          }
        >
          <TextArea
            rows={9}
            spellCheck={false}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={"Paste text, lines, lists…\nOne per line works best."}
          />
        </Panel>

        <Panel
          title="Output"
          right={
            <div className="flex gap-1.5">
              <CopyButton text={running ? "" : output} />
              <Button
                size="sm"
                variant="subtle"
                disabled={!output || running}
                onClick={() => downloadText(output, "text.txt")}
              >
                Save .txt
              </Button>
            </div>
          }
        >
          <div className="space-y-3">
            <WorkStatus running={running} elapsedMs={job.elapsedMs} label="Transforming text" cancelLabel="Cancel transform" onCancel={job.cancel} />
            {job.status === "cancelled" ? <Notice>Transform cancelled. Edit the text or pick a transform to run again.</Notice> : null}
            {job.status === "error" ? <Notice tone="error">{job.error}</Notice> : null}
            {error ? <Notice tone="error">{error}</Notice> : null}
            <StatGrid>
              <Stat label="In · chars" value={stats.chars} />
              <Stat label="In · words" value={stats.words} />
              <Stat label="In · lines" value={stats.lines} />
              <Stat label="Out · chars" value={stats.outChars} />
            </StatGrid>
            <OutputBlock value={preview} rows={12} empty="Pick a transform." />
            {output.length > TEXTKIT_PREVIEW_LIMIT ? <p className="text-xs text-faint">Showing the first {formatInt(TEXTKIT_PREVIEW_LIMIT)} of {formatInt(output.length)} characters. Copy and Save .txt use the full output.</p> : null}
          </div>
        </Panel>
      </div>
    </div>
  );
}
