import { randomInt } from "node:crypto";
import { deflateSync } from "node:zlib";
import { providerPost, type ProviderNet } from "@/lib/accounts/provider";
import type { ProviderConfig } from "@/lib/accounts/store";

/**
 * Vision detection (docs/ACCOUNTS.md "Vision detection"): when a provider's /models does not say whether a model takes
 * images, one tiny real request finds out. The picture is a 64x32 PNG whose left and right halves have two different
 * colours picked at random by the server; the model is asked to name them. Naming both, in order, means it saw the
 * picture (a text-only model guessing has a 1-in-30 chance); an HTTP 4xx about images, or an answer saying there is no
 * image, means text-only; anything else (timeouts, 5xx, 401/429, an unclear answer) is "unknown" and never cached.
 */

/** Per-model wait (reasoning models think before they answer); KNIFE_VISION_PROBE_TIMEOUT_MS overrides, 5-180 s. */
export const PROBE_TIMEOUT_MS = (() => {
  const configured = Number.parseInt(process.env.KNIFE_VISION_PROBE_TIMEOUT_MS ?? "", 10);
  return Number.isInteger(configured) && configured >= 5_000 && configured <= 180_000 ? configured : 60_000;
})();
/** Probes of one account running at once (a "check all" sends a few per request; a second tab waits its turn). */
export const PROBE_CONCURRENCY = 3;
/** Models one request may check (the settings page sends batches and shows progress). */
export const MAX_PROBE_MODELS = 6;
/**
 * Completion budget of one probe. A reasoning model thinks before it names the colours, so the first try leaves room;
 * an answer cut off with nothing written (finish_reason "length") is retried once with PROBE_RETRY_MAX_TOKENS, and if it
 * is still empty the verdict is "unclear" (unknown), never "text only".
 */
export const PROBE_MAX_TOKENS = 2_000;
export const PROBE_RETRY_MAX_TOKENS = 8_000;

export const PROBE_COLOURS = {
  red: [220, 30, 30],
  green: [30, 170, 60],
  blue: [30, 70, 220],
  yellow: [240, 210, 20],
  black: [0, 0, 0],
  white: [255, 255, 255],
} as const satisfies Record<string, readonly [number, number, number]>;
export type ProbeColour = keyof typeof PROBE_COLOURS;
const COLOUR_NAMES = Object.keys(PROBE_COLOURS) as ProbeColour[];

export type ProbeReason =
  /** Named both colours in order: it sees images. */
  | "saw"
  /** HTTP 4xx naming images / multimodal input / content types. */
  | "rejected"
  /** Answered, saying there is no image or it cannot see one. */
  | "no_image"
  /** Answered something else (wrong colours, empty, a reasoning model out of tokens). */
  | "unclear"
  /** The request failed for another reason (status kept): key, rate limit, server error, timeout, network. */
  | "error";

export interface ProbeVerdict {
  vision: boolean | null;
  reason: ProbeReason;
  /** Upstream HTTP status when there was one. */
  status: number | null;
}

/* ---------------------------------------------------------------------------------------------------- the picture */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** A width x height RGB PNG, left half one colour, right half the other. */
export function twoColourPng(left: ProbeColour, right: ProbeColour, width = 64, height = 32): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1);
    rows[row] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = PROBE_COLOURS[x < width / 2 ? left : right];
      rows.set([r, g, b], row + 1 + x * 3);
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

/** Two different colours at random (server-chosen, so an endpoint cannot know them in advance). */
export function pickColours(pick: (max: number) => number = randomInt): [ProbeColour, ProbeColour] {
  const left = COLOUR_NAMES[pick(COLOUR_NAMES.length)];
  const rest = COLOUR_NAMES.filter((name) => name !== left);
  return [left, rest[pick(rest.length)]];
}

export const PROBE_PROMPT =
  "This message contains an image split into a left half and a right half, each one solid colour. Reply with exactly two words: the colour of the left half, then the colour of the right half (choose from red, green, blue, yellow, black, white). If you cannot see any image, reply NO_IMAGE.";

/* -------------------------------------------------------------------------------------------------- classifying */

const IMAGE_ERROR = /image|vision|multimodal|multi-modal|modalit|image_url|content[ _-]?type|content part|unsupported content|non-text|not support.{0,40}(input|content)/i;
const NO_IMAGE_ANSWER = [
  /\bNO_IMAGE\b/i,
  /\b(can(?:no|')?t|cannot|unable to|not able to|am not able to)\s+(?:see|view|process|read|access|analy[sz]e|interpret|display|open)\b/i,
  /\b(?:no|don'?t see an?|do not see an?|there is no|there's no|didn'?t receive an?|haven'?t received an?|not received an?)\s+(?:image|picture|attachment|photo)/i,
  /\btext[- ]only\b/i,
  /\bonly (?:process|handle|understand|read|work with) text\b/i,
];

/** Where a colour word first appears in the answer, or -1. */
function colourAt(answer: string, colour: ProbeColour): number {
  const match = new RegExp(`\\b${colour}\\b`, "i").exec(answer);
  return match ? match.index : -1;
}

/** Classify one probe answer. Pure: the tests drive it with recorded shapes. */
export function classifyProbe(
  response: { ok: true; status: number; text: string } | { ok: false; failure: string },
  expected: readonly [ProbeColour, ProbeColour],
): ProbeVerdict {
  if (!response.ok) return { vision: null, reason: "error", status: null };
  const { status, text } = response;
  if (status < 200 || status >= 300) {
    // 401/403 (key), 404 (model), 408/409, 429 (rate limit): no evidence about images either way.
    const meaningful = status >= 400 && status < 500 && ![401, 403, 404, 408, 409, 429].includes(status);
    if (meaningful && IMAGE_ERROR.test(errorText(text))) return { vision: false, reason: "rejected", status };
    return { vision: null, reason: "error", status };
  }
  const answer = answerText(text);
  if (answer === null) return { vision: null, reason: "unclear", status };
  const left = colourAt(answer, expected[0]);
  const right = colourAt(answer, expected[1]);
  if (left >= 0 && right > left) return { vision: true, reason: "saw", status };
  if (NO_IMAGE_ANSWER.some((pattern) => pattern.test(answer))) return { vision: false, reason: "no_image", status };
  return { vision: null, reason: "unclear", status };
}

/** The provider's error message (JSON `error` / `error.message`, else the raw text, clipped). */
function errorText(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: unknown; message?: unknown; detail?: unknown };
    const inner = parsed.error;
    if (typeof inner === "string") return inner.slice(0, 2_000);
    if (inner && typeof inner === "object") return JSON.stringify(inner).slice(0, 2_000);
    if (typeof parsed.message === "string") return parsed.message.slice(0, 2_000);
    if (typeof parsed.detail === "string") return parsed.detail.slice(0, 2_000);
  } catch {
    // not JSON
  }
  return text.slice(0, 2_000);
}

/** The first choice's text content of an OpenAI chat completion, or null. */
function answerText(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as { choices?: { message?: { content?: unknown } }[] };
    const content = parsed.choices?.[0]?.message?.content;
    if (typeof content === "string") return content.trim() ? content.slice(0, 2_000) : null;
    if (Array.isArray(content)) {
      const joined = content.map((part: unknown) => (part && typeof part === "object" && "text" in part && typeof part.text === "string" ? part.text : "")).join("");
      return joined.trim() ? joined.slice(0, 2_000) : null;
    }
  } catch {
    // not JSON
  }
  return null;
}

/** A completion whose first choice stopped at the token limit before writing any text. */
export function cutOffEmpty(text: string): boolean {
  try {
    const parsed = JSON.parse(text) as { choices?: { finish_reason?: unknown }[] };
    return parsed.choices?.[0]?.finish_reason === "length" && answerText(text) === null;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------------------------------------------ probing */

function probeBody(model: string, png: Buffer, tokenField: "max_tokens" | "max_completion_tokens", maxTokens: number): string {
  return JSON.stringify({
    model,
    stream: false,
    temperature: 0,
    [tokenField]: maxTokens,
    messages: [{
      role: "user",
      content: [
        { type: "text", text: PROBE_PROMPT },
        { type: "image_url", image_url: { url: `data:image/png;base64,${png.toString("base64")}` } },
      ],
    }],
  });
}

/** One real probe of `model` at the config's endpoint, with its key. */
export async function probeVision(config: ProviderConfig, net: ProviderNet, model: string, options: { colours?: [ProbeColour, ProbeColour]; timeoutMs?: number } = {}): Promise<ProbeVerdict> {
  const colours = options.colours ?? pickColours();
  const png = twoColourPng(colours[0], colours[1]);
  const timeout = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const target = { ...config, model };
  let tokenField: "max_tokens" | "max_completion_tokens" = "max_tokens";
  let response = await providerPost(target, net, "/chat/completions", probeBody(model, png, tokenField, PROBE_MAX_TOKENS), timeout);
  // Newer OpenAI reasoning models reject max_tokens (the same retry as a chat round).
  if (response.ok && response.status === 400 && response.text.includes("max_completion_tokens")) {
    tokenField = "max_completion_tokens";
    response = await providerPost(target, net, "/chat/completions", probeBody(model, png, tokenField, PROBE_MAX_TOKENS), timeout);
  }
  // A reasoning model that ran out of tokens before answering: once more with a larger budget.
  if (response.ok && response.status >= 200 && response.status < 300 && cutOffEmpty(response.text)) {
    response = await providerPost(target, net, "/chat/completions", probeBody(model, png, tokenField, PROBE_RETRY_MAX_TOKENS), timeout);
  }
  return classifyProbe(response, colours);
}

/* ------------------------------------------------------------------------------------------- per-account gating */

const running = new Map<string, number>();
const waiting = new Map<string, (() => void)[]>();

/** Run `work` once fewer than PROBE_CONCURRENCY probes of this account are in flight. */
export async function withProbeSlot<T>(accountId: string, work: () => Promise<T>): Promise<T> {
  while ((running.get(accountId) ?? 0) >= PROBE_CONCURRENCY) {
    await new Promise<void>((resolve) => waiting.set(accountId, [...(waiting.get(accountId) ?? []), resolve]));
  }
  running.set(accountId, (running.get(accountId) ?? 0) + 1);
  try {
    return await work();
  } finally {
    const left = (running.get(accountId) ?? 1) - 1;
    if (left > 0) running.set(accountId, left);
    else running.delete(accountId);
    const queue = waiting.get(accountId) ?? [];
    const next = queue.shift();
    if (queue.length) waiting.set(accountId, queue);
    else waiting.delete(accountId);
    next?.();
  }
}
