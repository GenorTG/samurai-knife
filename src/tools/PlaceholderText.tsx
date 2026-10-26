"use client";

import { useMemo, useState } from "react";
import { Button, CopyButton, Field, NumberField, Panel, Select, Stat, StatGrid, TextArea } from "@/components/ui";
import { downloadText } from "@/lib/format";
import { useT } from "@/lib/i18n/react";
import { msg } from "@/lib/i18n/msg";

type PlaceholderMode = "paragraphs" | "sentences" | "words" | "headings";

const MODES: { value: PlaceholderMode; label: string; unit: string }[] = [
  { value: "paragraphs", label: msg("Paragraphs"), unit: "paragraphs" },
  { value: "sentences", label: msg("Sentences"), unit: "sentences" },
  { value: "words", label: msg("Word list"), unit: "words" },
  { value: "headings", label: msg("Heading outline"), unit: "headings" },
];

const WORDS = `lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua enim ad minim veniam quis nostrud exercitation ullamco laboris nisi aliquip ex ea commodo consequat duis aute irure reprehenderit voluptate velit esse cillum fugiat nulla pariatur excepteur sint occaecat cupidatat non proident sunt culpa officia deserunt mollit anim id est laborum`.split(" ");

function pickWords(count: number, offset: number): string[] {
  return Array.from({ length: count }, (_, index) => WORDS[(offset + index) % WORDS.length]);
}

function sentence(count: number, offset: number): string {
  const words = pickWords(count, offset);
  return `${words[0][0].toUpperCase()}${words[0].slice(1)} ${words.slice(1).join(" ")}.`;
}

function generate(mode: PlaceholderMode, amount: number, offset: number): string {
  switch (mode) {
    case "paragraphs":
      return Array.from({ length: amount }, (_, index) => {
        const base = offset + index * 43;
        return [sentence(14, base), sentence(16, base + 14), sentence(13, base + 30)].join(" ");
      }).join("\n\n");
    case "sentences":
      return Array.from({ length: amount }, (_, index) => sentence(8 + (index % 8), offset + index * 9)).join(" ");
    case "words":
      return pickWords(amount, offset).join("\n");
    case "headings":
      return Array.from({ length: amount }, (_, index) => `${index % 3 === 0 ? "##" : "###"} ${pickWords(3 + (index % 3), offset + index * 4).map((word) => `${word[0].toUpperCase()}${word.slice(1)}`).join(" ")}`).join("\n\n");
  }
}

export default function PlaceholderText() {
  const { t } = useT();
  const [mode, setMode] = useState<PlaceholderMode>("paragraphs");
  const [amount, setAmount] = useState(3);
  const [offset, setOffset] = useState(0);
  const output = useMemo(() => generate(mode, amount, offset), [amount, mode, offset]);
  const wordCount = output.trim() ? output.trim().split(/\s+/).length : 0;
  const selectedMode = MODES.find((item) => item.value === mode) ?? MODES[0];

  return (
    <div className="space-y-4">
      <Panel title={t("Build placeholder text")} right={<div className="flex gap-1.5"><CopyButton text={output} /><Button size="sm" variant="subtle" disabled={!output} onClick={() => downloadText(output, "placeholder.txt")}>{t("Save .txt")}</Button></div>}>
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem_auto] sm:items-end">
            <Field label={t("Shape")}>
              <Select value={mode} onChange={(event) => setMode(event.target.value as PlaceholderMode)}>
                {MODES.map((item) => <option key={item.value} value={item.value}>{t(item.label)}</option>)}
              </Select>
            </Field>
            <Field label={selectedMode.unit}>
              <NumberField className="py-2" min={1} max={mode === "words" ? 200 : mode === "sentences" ? 40 : 12} integer value={amount} onValueChange={setAmount} />
            </Field>
            <Button variant="primary" onClick={() => setOffset((current) => (current + 37) % WORDS.length)}>{t("Regenerate")}</Button>
          </div>
          <StatGrid>
            <Stat label={t("Words")} value={wordCount} />
            <Stat label={t("Characters")} value={output.length} />
            <Stat label={t("Lines")} value={output ? output.split("\n").length : 0} />
            <Stat label={t("Mode")} value={selectedMode.label} />
          </StatGrid>
          <TextArea aria-label={t("Generated placeholder text")} readOnly value={output} rows={16} className="font-mono text-[13px]" />
        </div>
      </Panel>
      <Panel title={t("About this text")}>
        <p className="text-sm leading-relaxed text-muted">{t("Classic Lorem Ipsum-style filler, generated locally from a bundled word list. It is useful for layout and typography previews; it is not meaningful prose and makes no network requests.")}</p>
      </Panel>
    </div>
  );
}
