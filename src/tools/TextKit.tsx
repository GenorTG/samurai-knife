"use client";

import { useMemo, useState } from "react";
import { Button, CopyButton, Field, Notice, OutputBlock, Panel, Select, Stat, StatGrid, TextArea, WorkStatus } from "@/components/ui";
import { downloadText, formatInt } from "@/lib/format";
import { runTextKit, TEXTKIT_INLINE_LIMIT, TEXTKIT_PREVIEW_LIMIT, type Operation, type TextKitInput } from "@/lib/textkit";
import { runTextKitInWorker } from "@/lib/textkit-client";
import { useAdaptive } from "@/lib/workers/use-offloaded";
import { useT } from "@/lib/i18n/react";
import { msg } from "@/lib/i18n/msg";

const OPERATIONS: { value: Operation; label: string; group: string }[] = [
  { value: "upper", label: "UPPERCASE", group: msg("Case") },
  { value: "lower", label: "lowercase", group: msg("Case") },
  { value: "title", label: msg("Title Case"), group: msg("Case") },
  { value: "sentence", label: msg("Sentence case"), group: msg("Case") },
  { value: "snake", label: "snake_case", group: msg("Case") },
  { value: "kebab", label: "kebab-case", group: msg("Case") },
  { value: "camel", label: "camelCase", group: msg("Case") },
  { value: "slug", label: "slug (ascii, no accents)", group: msg("Case") },
  { value: "dedupe", label: msg("Dedupe lines"), group: msg("Lines") },
  { value: "sort", label: msg("Sort lines A→Z"), group: msg("Lines") },
  { value: "reverse", label: msg("Reverse line order"), group: msg("Lines") },
  { value: "trim", label: msg("Trim + drop blanks"), group: msg("Lines") },
  { value: "number", label: msg("Number lines"), group: msg("Lines") },
  { value: "base64", label: msg("Encode Base64"), group: msg("Encode") },
  { value: "unbase64", label: msg("Decode Base64"), group: msg("Encode") },
  { value: "urlencode", label: "URL-encode", group: msg("Encode") },
  { value: "urldecode", label: "URL-decode", group: msg("Encode") },
  { value: "html", label: msg("Escape HTML entities"), group: msg("Encode") },
  { value: "unhtml", label: msg("Unescape HTML entities"), group: msg("Encode") },
  { value: "strip", label: msg("Strip all whitespace"), group: msg("Encode") },
];

const GROUPS = ["Case", "Lines", "Encode"];

export default function TextKit() {
  const { t } = useT();
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
      <Panel title={t("Transform")}>
        <div className="space-y-4">
          {GROUPS.map((group) => (
            <div key={group} className="space-y-1.5">
              <p className="sk-label">{t(group)}</p>
              <div className="flex flex-wrap gap-1.5">
                {OPERATIONS.filter((o) => o.group === group).map((operation) => (
                  <Button
                    key={operation.value}
                    size="sm"
                    variant={op === operation.value ? "primary" : "subtle"}
                    onClick={() => setOp(operation.value)}
                  >
                    {t(operation.label)}
                  </Button>
                ))}
              </div>
            </div>
          ))}

          <Field label={t("Chain")} hint={t("Applied before the picked transform, in order.")}>
            <Select
              value=""
              onChange={(e) => {
                const value = e.target.value as Operation;
                if (value) setChain((current) => [...current, value]);
              }}
            >
              <option value="">{t("Add a step…")}</option>
              {OPERATIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {t(o.group)} · {t(o.label)}
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
                  title={t("Remove step")}
                  onClick={() => setChain((current) => current.filter((_, i) => i !== index))}
                  className="rounded-md border border-line-strong/60 px-2 py-1 font-mono text-[11px] text-muted hover:border-danger/50 hover:text-danger"
                >
                  {OPERATIONS.find((o) => o.value === step)?.label ?? step} ×
                </button>
              ))}
              <Button size="sm" variant="ghost" onClick={() => setChain([])}>
                {t("Reset chain")}
              </Button>
            </div>
          ) : null}
        </div>
      </Panel>

      <div className="space-y-4">
        <Panel
          title={t("Input")}
          right={
            <div className="flex gap-1.5">
              <Button size="sm" variant="ghost" onClick={() => setInput("")}>{t("Clear")}</Button>
              <Button
                size="sm"
                variant="subtle"
                disabled={!output || running}
                onClick={() => setInput(output)}
              >
                {t("Output → input")}
              </Button>
            </div>
          }
        >
          <TextArea
            rows={9}
            spellCheck={false}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={t("Paste text, lines, lists…\nOne per line works best.")}
          />
        </Panel>

        <Panel
          title={t("Output")}
          right={
            <div className="flex gap-1.5">
              <CopyButton text={running ? "" : output} />
              <Button
                size="sm"
                variant="subtle"
                disabled={!output || running}
                onClick={() => downloadText(output, "text.txt")}
              >
                {t("Save .txt")}
              </Button>
            </div>
          }
        >
          <div className="space-y-3">
            <WorkStatus running={running} elapsedMs={job.elapsedMs} label={t("Transforming text")} cancelLabel={t("Cancel transform")} onCancel={job.cancel} />
            {job.status === "cancelled" ? <Notice>{t("Transform cancelled. Edit the text or pick a transform to run again.")}</Notice> : null}
            {job.status === "error" ? <Notice tone="error">{job.error}</Notice> : null}
            {error ? <Notice tone="error">{error}</Notice> : null}
            <StatGrid>
              <Stat label={t("In · chars")} value={stats.chars} />
              <Stat label={t("In · words")} value={stats.words} />
              <Stat label={t("In · lines")} value={stats.lines} />
              <Stat label={t("Out · chars")} value={stats.outChars} />
            </StatGrid>
            <OutputBlock value={preview} rows={12} empty={t("Pick a transform.")} />
            {output.length > TEXTKIT_PREVIEW_LIMIT ? <p className="text-xs text-faint">{t("Showing the first {textkitPreviewLimit} of {output} characters. Copy and Save .txt use the full output.", { textkitPreviewLimit: formatInt(TEXTKIT_PREVIEW_LIMIT), output: formatInt(output.length) })}</p> : null}
          </div>
        </Panel>
      </div>
    </div>
  );
}
