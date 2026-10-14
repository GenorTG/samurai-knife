"use client";

import { useMemo, useState } from "react";
import { Button, CopyButton, Field, Notice, Panel, Select, Stat, StatGrid, TextArea } from "@/components/ui";
import { downloadText } from "@/lib/format";

const SAMPLE = "A👩‍💻e\u0301\tline one\nline\u00a0two\u200b";
const MAX_INPUT_LENGTH = 20_000;
const MAX_PREVIEW_GRAPHEMES = 2_000;

const NAMED_CHARACTERS: Readonly<Record<number, string>> = {
  0x0009: "TAB",
  0x000a: "LINE FEED",
  0x000d: "CARRIAGE RETURN",
  0x00a0: "NO-BREAK SPACE",
  0x00ad: "SOFT HYPHEN",
  0x034f: "COMBINING GRAPHEME JOINER",
  0x061c: "ARABIC LETTER MARK",
  0x115f: "HANGUL CHOSEONG FILLER",
  0x1160: "HANGUL JUNGSEONG FILLER",
  0x1680: "OGHAM SPACE MARK",
  0x180e: "MONGOLIAN VOWEL SEPARATOR",
  0x200b: "ZERO WIDTH SPACE",
  0x200c: "ZERO WIDTH NON-JOINER",
  0x200d: "ZERO WIDTH JOINER",
  0x2028: "LINE SEPARATOR",
  0x2029: "PARAGRAPH SEPARATOR",
  0x202a: "LEFT-TO-RIGHT EMBEDDING",
  0x202b: "RIGHT-TO-LEFT EMBEDDING",
  0x202c: "POP DIRECTIONAL FORMATTING",
  0x202d: "LEFT-TO-RIGHT OVERRIDE",
  0x202e: "RIGHT-TO-LEFT OVERRIDE",
  0x202f: "NARROW NO-BREAK SPACE",
  0x2060: "WORD JOINER",
  0x2066: "LEFT-TO-RIGHT ISOLATE",
  0x2067: "RIGHT-TO-LEFT ISOLATE",
  0x2068: "FIRST STRONG ISOLATE",
  0x2069: "POP DIRECTIONAL ISOLATE",
  0x3000: "IDEOGRAPHIC SPACE",
  0xfeff: "BOM / ZERO WIDTH NO-BREAK SPACE",
};

interface CharacterOccurrence {
  codePoint: number;
  label: string;
  count: number;
  positions: number[];
}

function codePointLabel(value: number): string {
  return `U+${value.toString(16).toUpperCase().padStart(4, "0")}`;
}

function describeCharacter(value: number): string | null {
  const named = NAMED_CHARACTERS[value];
  if (named) return named;
  const character = String.fromCodePoint(value);
  if (/\p{Cc}/u.test(character)) return "CONTROL CHARACTER";
  if (/\p{Cf}/u.test(character)) return "FORMAT CHARACTER";
  if (/\p{Zs}/u.test(character) && value !== 0x20) return "UNICODE SPACE";
  return null;
}

function graphemes(text: string): string[] {
  if (typeof Intl.Segmenter === "function") {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    return Array.from(segmenter.segment(text), (part) => part.segment);
  }
  return Array.from(text);
}

function visualize(text: string): string {
  return Array.from(text).map((character) => {
    if (character === " ") return "·";
    if (character === "\t") return "⇥";
    if (character === "\n") return "↵\n";
    if (character === "\r") return "␍";
    const value = character.codePointAt(0) ?? 0;
    const label = describeCharacter(value);
    return label ? `⟦${label}⟧` : character;
  }).join("");
}

function inspectCharacters(text: string): CharacterOccurrence[] {
  const occurrences = new Map<number, CharacterOccurrence>();
  let position = 0;
  for (const character of text) {
    const value = character.codePointAt(0) ?? 0;
    const label = describeCharacter(value);
    if (label) {
      const current = occurrences.get(value) ?? {
        codePoint: value,
        label,
        count: 0,
        positions: [],
      };
      current.count += 1;
      if (current.positions.length < 8) current.positions.push(position + 1);
      occurrences.set(value, current);
    }
    position += 1;
  }
  return [...occurrences.values()].sort((a, b) => a.positions[0] - b.positions[0]);
}

export default function CharacterInspector() {
  const [input, setInput] = useState("");
  const [normalization, setNormalization] = useState<"NFC" | "NFD" | "NFKC" | "NFKD">("NFC");

  const clusters = useMemo(() => graphemes(input), [input]);
  const unusual = useMemo(() => inspectCharacters(input), [input]);
  const output = useMemo(() => input.normalize(normalization), [input, normalization]);
  const previewWasTruncated = clusters.length > MAX_PREVIEW_GRAPHEMES;
  const visiblePreview = useMemo(
    () => visualize(clusters.slice(0, MAX_PREVIEW_GRAPHEMES).join("")),
    [clusters],
  );

  return (
    <div className="space-y-4">
      <Panel
        title="Input"
        right={
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => setInput("")}>Clear</Button>
            <Button size="sm" variant="subtle" onClick={() => setInput(SAMPLE)}>Sample</Button>
          </div>
        }
      >
        <div className="space-y-3">
          <Field label="Text to inspect" hint={`Analysis is capped at ${MAX_INPUT_LENGTH.toLocaleString("en-US")} UTF-16 units.`}>
            <TextArea
              value={input}
              maxLength={MAX_INPUT_LENGTH}
              spellCheck={false}
              onChange={(event) => setInput(event.target.value)}
              placeholder="Paste text to inspect graphemes, whitespace, and invisible characters…"
              rows={7}
            />
          </Field>
          <StatGrid>
            <Stat label="Graphemes" value={clusters.length} />
            <Stat label="Code points" value={Array.from(input).length} />
            <Stat label="UTF-16 units" value={input.length} />
            <Stat label="UTF-8 bytes" value={new TextEncoder().encode(input).length} />
          </StatGrid>
        </div>
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Whitespace & invisible characters">
          {input ? (
            <div className="space-y-3">
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-bg p-3 font-mono text-[13px] leading-relaxed text-ink">{visiblePreview}</pre>
              {previewWasTruncated ? <p className="text-xs text-faint">Preview limited to {MAX_PREVIEW_GRAPHEMES.toLocaleString("en-US")} graphemes.</p> : null}
              {unusual.length ? (
                <div className="overflow-x-auto rounded-lg border border-line">
                  <table className="w-full min-w-[440px] text-left text-xs">
                    <thead className="bg-raised text-faint"><tr><th className="px-3 py-2">Character</th><th className="px-3 py-2">Code point</th><th className="px-3 py-2">Count</th><th className="px-3 py-2">Positions</th></tr></thead>
                    <tbody>{unusual.map((item) => <tr key={item.codePoint} className="border-t border-line">
                      <td className="px-3 py-2 text-ink">{item.label}</td>
                      <td className="px-3 py-2 font-mono text-ink">{codePointLabel(item.codePoint)}</td>
                      <td className="px-3 py-2 font-mono text-ink">{item.count}</td>
                      <td className="px-3 py-2 font-mono text-muted">{item.positions.join(", ")}{item.count > item.positions.length ? ", …" : ""}</td>
                    </tr>)}</tbody>
                  </table>
                </div>
              ) : <Notice>No invisible or unusual spacing characters found.</Notice>}
              <p className="text-xs text-faint">Positions count Unicode code points, starting at 1. Regular spaces appear as · and line breaks as ↵.</p>
            </div>
          ) : <p className="text-sm text-faint">Spaces and line breaks become visible here. Hidden formatting characters are listed below the preview.</p>}
        </Panel>

        <Panel
          title="Unicode normalization"
          right={
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Form" className="w-24">
                <Select value={normalization} onChange={(event) => setNormalization(event.target.value as typeof normalization)}>
                  <option>NFC</option><option>NFD</option><option>NFKC</option><option>NFKD</option>
                </Select>
              </Field>
              <CopyButton text={output} />
              <Button size="sm" variant="subtle" disabled={!input} onClick={() => downloadText(output, "normalized.txt")}>Save</Button>
            </div>
          }
        >
          {input ? (
            <div className="space-y-3">
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-bg p-3 font-mono text-[13px] leading-relaxed text-ink">{output}</pre>
              <StatGrid>
                <Stat label="Original code points" value={Array.from(input).length} />
                <Stat label={`${normalization} code points`} value={Array.from(output).length} />
              </StatGrid>
              <p className="text-xs text-faint">Normalization creates a copy; the input is left untouched.</p>
            </div>
          ) : <p className="text-sm text-faint">Choose a normalization form to prepare a copy of your text.</p>}
        </Panel>
      </div>
    </div>
  );
}
