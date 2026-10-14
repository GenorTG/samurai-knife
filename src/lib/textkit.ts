/** Text transforms for the Text kit. Pure: runs inline for small text and in textkit.worker.ts for large text. */

export type Operation =
  | "upper"
  | "lower"
  | "title"
  | "sentence"
  | "snake"
  | "kebab"
  | "camel"
  | "slug"
  | "dedupe"
  | "sort"
  | "reverse"
  | "trim"
  | "number"
  | "base64"
  | "unbase64"
  | "urlencode"
  | "urldecode"
  | "html"
  | "unhtml"
  | "strip";

/** Input above this many characters is transformed in the worker. */
export const TEXTKIT_INLINE_LIMIT = 200_000;
/** The output pane renders at most this many characters; Copy / Save / "Output → input" always use the full output. */
export const TEXTKIT_PREVIEW_LIMIT = 200_000;

export interface TextKitInput {
  text: string;
  /** Applied in order: the chain, then the picked transform. */
  steps: Operation[];
}

export interface TextKitOutput {
  output: string;
  error: string | null;
  chars: number;
  words: number;
  lines: number;
  outChars: number;
}

export type TextKitTasks = { transform: { payload: TextKitInput; result: TextKitOutput } };

const LINE_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function words(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

/** Split into lowercase-able words: camelCase boundaries, whitespace, punctuation, `_` and `-` all separate words. */
function identifierWords(text: string): string[] {
  return text
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

const SLUG_LETTERS: Record<string, string> = { "ł": "l", "ø": "o", "đ": "d", "ð": "d", "ħ": "h", "ı": "i", "ß": "ss", "æ": "ae", "œ": "oe", "þ": "th" };

function codePointOr(code: number, fallback: string): string {
  return Number.isInteger(code) && code >= 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : fallback;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function apply(op: Operation, input: string): string {
  switch (op) {
    case "upper":
      return input.toUpperCase();
    case "lower":
      return input.toLowerCase();
    case "title":
      return input.toLowerCase().replace(/(^|\s|[-_(])\p{L}/gu, (m) => m.toUpperCase());
    case "sentence":
      return input
        .toLowerCase()
        .replace(/(^\s*\p{L}|[.?!]\s+\p{L})/gu, (m) => m.toUpperCase());
    case "snake":
      return identifierWords(input).join("_").toLowerCase();
    case "kebab":
      return identifierWords(input).join("-").toLowerCase();
    case "camel":
      return identifierWords(input)
        .map((word, index) => (index === 0 ? word.toLowerCase() : word.slice(0, 1).toUpperCase() + word.slice(1).toLowerCase()))
        .join("");
    case "slug":
      return input
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[łøđðħıßæœþ]/g, (c) => SLUG_LETTERS[c] ?? c)
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
    case "dedupe": {
      const seen = new Set<string>();
      return input
        .split("\n")
        .filter((line) => {
          const key = line.trim();
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .join("\n");
    }
    case "sort":
      return input.split("\n").sort((a, b) => LINE_COLLATOR.compare(a, b)).join("\n");
    case "reverse":
      return input.split("\n").reverse().join("\n");
    case "trim":
      return input.split("\n").map((l) => l.trim()).filter(Boolean).join("\n");
    case "number":
      return input
        .split("\n")
        .map((line, index) => `${String(index + 1).padStart(2, " ")}. ${line}`)
        .join("\n");
    case "base64":
      return bytesToBase64(new TextEncoder().encode(input));
    case "unbase64": {
      const clean = input.replace(/\s+/g, "");
      if (!/^[A-Za-z0-9+/=]*$/.test(clean)) throw new Error("That is not valid Base64.");
      const bytes = Uint8Array.from(atob(clean), (c) => c.charCodeAt(0));
      return new TextDecoder().decode(bytes);
    }
    case "urlencode":
      return encodeURIComponent(input);
    case "urldecode":
      try {
        return decodeURIComponent(input);
      } catch {
        throw new Error("Malformed percent-encoding.");
      }
    case "html":
      return input.replace(/[&<>"']/g, (c) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
      );
    case "unhtml":
      return input
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&(?:#39|apos);/g, "'")
        .replace(/&#x([0-9a-f]+);/gi, (m, h: string) => codePointOr(parseInt(h, 16), m))
        .replace(/&#(\d+);/g, (m, d: string) => codePointOr(Number(d), m))
        .replace(/&amp;/g, "&");
    case "strip":
      return input.replace(/\s+/g, "");
    default:
      return input;
  }
}

export function runTextKit({ text, steps }: TextKitInput): TextKitOutput {
  const chars = text.length;
  const wordCount = words(text).length;
  const lines = text.split("\n").length;
  try {
    let value = text;
    for (const step of steps) value = apply(step, value);
    return { output: value, error: null, chars, words: wordCount, lines, outChars: value.length };
  } catch (exc) {
    return { output: "", error: exc instanceof Error ? exc.message : "Transform failed.", chars, words: wordCount, lines, outChars: 0 };
  }
}
