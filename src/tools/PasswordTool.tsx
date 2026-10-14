"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, CopyButton, Field, KeyValues, Notice, OutputBlock, Panel, Select, Stat, StatGrid, TextArea, TextInput } from "@/components/ui";
import { clamp, plural } from "@/lib/format";

/**
 * Password workbench. Everything is generated from `crypto.getRandomValues` in
 * the browser — no word ever leaves this machine, and the entropy readout is
 * computed from the actual wordlist length rather than an assumed 8 bits/word.
 */

const WORDS = (
  "abandon account achieve acoustic acrylic action actual adapt address adjust " +
  "admit advice aerial afraid agent agony agree airplane aisle alarm album alert " +
  "alike alley almond almost alpha already amazing amber amount amused anchor " +
  "ancient angel animal answer antenna anyone apple april arcade armor arrow " +
  "artist aspect assault astronaut athlete atlas atom auburn author autumn avenue " +
  "awake away baby badge bakery balance bamboo banana banner barrel basic basket " +
  "battle beacon beauty bedroom beetle begins behind believe bench berry beyond " +
  "bicycle billion bird bishop bitter blanket blossom blue board boat body bonus " +
  "book border bottle bottom bounce bracket brain branch bravo breathe brick " +
  "bridge bright bronze broom brother brown brush bubble bucket budget buffer " +
  "builder bullet bundle bunny bureau burger cabin cable camera canvas canyon " +
  "capital captain carbon careful cargo castle cattle cause celery cellar cement " +
  "cereal chair chaos charge chase check cheese cherry child chill church circle " +
  "city class cliff climate clock close cloth cloud coal cobra coffee coin cold " +
  "college color column comedy comfort common concert condition config connect " +
  "control cookie copper cosmic cotton count country course cover crab craft " +
  "crash create credit cricket crisis crop cross crowd crown crust crystal cube " +
  "cup curl curtain curve cushion custom cycle daily damage danger dark dart dash " +
  "date dawn deal death debt decade decide decline decrease degree delay demand " +
  "dense deposit depth desert detail device diagram diamond dice diet dirt dirty " +
  "dish divide doctor domain donkey door double doubt dozen draft drag drain draw " +
  "dream dress drift drink drive drop drum dry dull dust"
).split(/\s+/).filter(Boolean);

const DIGITS = "0123456789";
const HEX = "0123456789abcdef";
const SYMBOLS = "!?-_+.#";
const LOWER = "abcdefghijklmnopqrstuvwxyz";
const UPPER = LOWER.toUpperCase();

/** Whole numeric input -> integer in [min, max]; blank/garbage falls back instead of becoming NaN. */
function intIn(raw: string, min: number, max: number, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && raw.trim() !== "" ? clamp(Math.trunc(value), min, max) : fallback;
}

function pickFrom(alphabet: string, count: number): string {
  // Unique code points: duplicates would bias the draw and UTF-16 indexing would split emoji.
  const symbols = Array.from(new Set(Array.from(alphabet)));
  if (!symbols.length || !(count > 0)) return "";
  const range = 2 ** 32;
  const max = range - (range % symbols.length);
  const words = new Uint32Array(Math.max(count, 8));
  let out = "";
  let filled = 0;
  while (filled < count) {
    void globalThis.crypto.getRandomValues(words);
    for (const word of words) {
      if (filled >= count) break;
      if (word < max) {
        out += symbols[word % symbols.length];
        filled += 1;
      }
    }
  }
  return out;
}

/** Uniform pick from a word list, rejection-sampled to avoid modulo bias. */
function pickWord(words: string[]): string {
  if (!words.length) return "";
  const max = 256 - (256 % words.length);
  const byte = new Uint8Array(1);
  for (;;) {
    void globalThis.crypto.getRandomValues(byte);
    if (byte[0] < max) return words[byte[0] % words.length];
  }
}

function shuffleString(text: string): string {
  const chars = [...text];
  if (chars.length < 2) return text;
  const max = 256 - (256 % chars.length);
  const bytes = new Uint8Array(chars.length);
  for (let i = chars.length - 1; i > 0; i -= 1) {
    void globalThis.crypto.getRandomValues(bytes);
    let j = 0;
    while (j < bytes.length && bytes[j] >= max) j += 1;
    const roll = j < bytes.length ? bytes[j] % chars.length : 0;
    [chars[i], chars[roll]] = [chars[roll], chars[i]];
  }
  return chars.join("");
}

function humanTime(seconds: number): string {
  if (seconds < 1) return "under a second";
  const units: [number, string][] = [
    [60, "minutes"],
    [3600, "hours"],
    [86400, "days"],
    [2_592_000, "months"],
    [31_536_000, "years"],
    [3_153_600_000, "centuries"],
  ];
  let value = seconds;
  let label = "seconds";
  for (const [size, name] of units) {
    if (seconds < size) break;
    value = seconds / size;
    label = name;
  }
  if (value >= 1e9) return "longer than anyone can wait for";
  return `${value < 100 ? value.toFixed(1) : Math.round(value)} ${label}`;
}

function poolFor(text: string): number {
  let pool = 0;
  if (/[\p{Ll}]/u.test(text)) pool += 26;
  if (/[\p{Lu}]/u.test(text)) pool += 26;
  if (/\d/.test(text)) pool += 10;
  if (/[^A-Za-z0-9\s]/.test(text)) pool += 32;
  if (/\s/.test(text)) pool += 1;
  if (/\p{L}/u.test(text) && !/[\p{Ll}\p{Lu}]/u.test(text)) pool += 26;
  return pool;
}

export default function PasswordTool() {
  const [wordCount, setWordCount] = useState("4");
  const [separator, setSeparator] = useState("-");
  const [extraDigits, setExtraDigits] = useState("1");
  const [extraSymbol, setExtraSymbol] = useState("1");
  const [capitalize, setCapitalize] = useState("on");
  const [candidate, setCandidate] = useState("");
  const [alphabet, setAlphabet] = useState(LOWER + DIGITS);
  const [stringLength, setStringLength] = useState("24");
  const [batchCount, setBatchCount] = useState("5");
  const [error, setError] = useState<string | null>(null);
  const [batch, setBatch] = useState<string[]>([]);

  const generate = useCallback(() => {
    setError(null);
    const words = WORDS
      .map((word) => (
        capitalize === "on" ? word[0].toUpperCase() + word.slice(1)
          : capitalize === "upper" ? word.toUpperCase()
            : word
      ))
      .filter(() => true);
    const chosen: string[] = [];
    for (let i = 0; i < intIn(wordCount, 1, 10, 4); i += 1) {
      chosen.push(pickWord(words));
    }
    // Shuffle only the extras, then append: shuffling the whole string would scramble the words.
    const extras = shuffleString(
      pickFrom(DIGITS, intIn(extraDigits, 0, 6, 1)) + pickFrom(SYMBOLS, intIn(extraSymbol, 0, 4, 1)),
    );
    setCandidate(`${chosen.join(separator || " ")}${extras}`);
  }, [capitalize, extraDigits, extraSymbol, separator, wordCount]);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (!candidate) setError(null);
      else if (candidate.length < 12) setError("Short — the meter below will say why.");
      else setError(null);
    }, 140);
    return () => clearTimeout(timer);
  }, [candidate]);

  const passphraseBits = useMemo(() => {
    const perWord = Math.log2(WORDS.length);
    const words = intIn(wordCount, 1, 10, 4);
    const digits = intIn(extraDigits, 0, 6, 1);
    const symbols = intIn(extraSymbol, 0, 4, 1);
    // A fixed case rule (every word capitalised/upper) adds no entropy.
    return words * perWord + digits * Math.log2(DIGITS.length) + symbols * Math.log2(SYMBOLS.length);
  }, [extraDigits, extraSymbol, wordCount]);

  const inspected = useMemo(() => {
    if (!candidate) return null;
    const chars = [...candidate];
    const unique = new Set(chars).size;
    const pool = poolFor(candidate);
    const naive = chars.length * Math.log2(Math.max(pool, 2));
    const honest = chars.length * Math.log2(Math.max(unique, 2));
    const bits = Math.min(naive, honest);
    const seconds = 2 ** Math.min(bits, 200) / 2 / 1e10;
    return { bits, pool, unique, naive, honest, seconds, chars: chars.length };
  }, [candidate]);

  useEffect(() => {
    const count = intIn(batchCount, 1, 20, 5);
    const length = intIn(stringLength, 1, 128, 24);
    const frame = requestAnimationFrame(() => {
      setBatch(Array.from({ length: count }, () => pickFrom(alphabet, length)));
    });
    return () => cancelAnimationFrame(frame);
  }, [alphabet, batchCount, stringLength]);

  const batchBits = useMemo(() => {
    const unique = new Set(Array.from(alphabet)).size;
    const length = intIn(stringLength, 1, 128, 24);
    return unique > 1 ? length * Math.log2(unique) : 0;
  }, [alphabet, stringLength]);

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel
          title="Passphrase"
          right={
            <div className="flex flex-wrap gap-1.5">
              <Button size="sm" onClick={generate}>
                Generate
              </Button>
              <CopyButton text={candidate} label="Copy" />
            </div>
          }
        >
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <Field label="Words">
                <Select
                  value={wordCount}
                  onChange={(e) => setWordCount(e.target.value)}
                  className="w-16"
                >
                  <option value="3">3</option>
                  <option value="4">4</option>
                  <option value="5">5</option>
                  <option value="6">6</option>
                  <option value="8">8</option>
                </Select>
              </Field>
              <Field label="Separator">
                <TextInput
                  value={separator}
                  onChange={(e) => setSeparator(e.target.value)}
                  placeholder="- or space"
                  className="font-mono w-16"
                />
              </Field>
            </div>

            <div className="grid grid-cols-3 gap-2">
              <Field label="Digits">
                <TextInput
                  value={extraDigits}
                  onChange={(e) => setExtraDigits(e.target.value)}
                  className="font-mono w-12"
                />
              </Field>
              <Field label="Symbol">
                <TextInput
                  value={extraSymbol}
                  onChange={(e) => setExtraSymbol(e.target.value)}
                  className="font-mono w-12"
                />
              </Field>
              <Field label="Case">
                <Select
                  value={capitalize}
                  onChange={(e) => setCapitalize(e.target.value)}
                  className="w-20"
                >
                  <option value="on">Capitalise</option>
                  <option value="upper">UPPER</option>
                  <option value="off">lower</option>
                </Select>
              </Field>
            </div>

            {error ? <Notice tone="error">{error}</Notice> : null}

            <OutputBlock value={candidate} rows={3} empty="Press Generate — nothing is stored, nothing is sent." />

            <StatGrid>
              <Stat label="Entropy" value={`${passphraseBits.toFixed(0)} bits`} />
              <Stat label="Words in list" value={WORDS.length} />
              <Stat label="Bits per word" value={Math.log2(WORDS.length).toFixed(2)} />
            </StatGrid>
            <p className="text-xs text-faint">
              The wordlist ships with the app; the picker uses rejection sampling over
              <code>crypto.getRandomValues</code>, so no modulo bias.
            </p>
          </div>
        </Panel>

        <Panel
          title="Measure what you typed"
          right={
            <div className="flex flex-wrap gap-1.5">
              <CopyButton text={candidate} label="Copy" />
            </div>
          }
        >
          <div className="space-y-3">
            <Field label="Any candidate" hint="Read locally — this box never posts anywhere.">
              <TextArea
                value={candidate}
                onChange={(e) => setCandidate(e.target.value)}
                placeholder="type or paste a candidate…"
                className="font-mono text-[13px]"
              />
            </Field>

            {inspected ? (
              <div className="space-y-3">
                <StatGrid>
                  <Stat label="Naive bits" value={inspected.naive.toFixed(0)} />
                  <Stat label="Unique-char bits" value={inspected.honest.toFixed(0)} />
                  <Stat label="Reported" value={inspected.bits.toFixed(0)} />
                </StatGrid>
                <KeyValues
                  rows={[
                    ["Length", String(inspected.chars)],
                    ["Character pool", String(inspected.pool)],
                    ["Distinct chars", String(inspected.unique)],
                    ["Crack time @ 10¹⁰/s", humanTime(inspected.seconds)],
                  ]}
                />
                <div className="rounded-tool border border-line p-3 text-[13px]">
                  {inspected.bits >= 60
                    ? "Above 60 bits: a brute-force search is out of reach on current hardware."
                    : inspected.bits >= 40
                      ? "Usable, but a targeted attack (known format, leaked fragments) still fits."
                      : "Too small. Length or pool needs to grow before this is a password."}
                </div>
                <p className="text-xs text-faint">
                  Reported takes the lower of the two estimates — repeats in a candidate
                  shrink the real pool, and the naive formula ignores that.
                </p>
              </div>
            ) : (
              <p className="text-sm text-faint">Type a candidate above to measure it.</p>
            )}
          </div>
        </Panel>
      </div>

      <Panel
        title="Random string"
        right={
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" onClick={() => setAlphabet(LOWER + UPPER + DIGITS + SYMBOLS)}>
              Full charset
            </Button>
            <Button size="sm" onClick={() => setAlphabet(LOWER + DIGITS)}>
              Lower + digits
            </Button>
            <Button size="sm" onClick={() => setAlphabet(HEX)}>
              Hex only
            </Button>
            <CopyButton text={batch.join("\n")} label="Copy all" />
          </div>
        }
      >
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-[minmax(0,1fr)_6rem_6rem]">
            <Field label="Alphabet" className="col-span-2 sm:col-span-1">
              <TextInput
                value={alphabet}
                onChange={(e) => setAlphabet(e.target.value)}
                className="font-mono"
              />
            </Field>
            <Field label="Length">
              <TextInput
                value={stringLength}
                onChange={(e) => setStringLength(e.target.value)}
                className="font-mono w-16"
              />
            </Field>
            <Field label="How many">
              <TextInput
                value={batchCount}
                onChange={(e) => setBatchCount(e.target.value)}
                className="font-mono w-16"
              />
            </Field>
          </div>

          <OutputBlock value={batch.join("\n")} rows={20} empty="Nothing generated." />

          <StatGrid>
            <Stat label="Alphabet size" value={new Set(Array.from(alphabet)).size} />
            <Stat label="Bits per string" value={batchBits.toFixed(0)} />
          </StatGrid>
          <p className="text-xs text-faint">
            {plural(new Set(Array.from(alphabet)).size, "symbol")} in the alphabet — ambiguous glyphs
            are your call, the meter counts what you asked for.
          </p>
        </div>
      </Panel>
    </div>
  );
}
