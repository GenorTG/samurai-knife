import { detectLang, type DetectedLang } from "../langdetect";
import { postingSections } from "./sections";
import { decodeEntities, findAll, findFirst, parseHtml, plainText, rawText, readableText, tidyText, type HtmlElement } from "./html";
import { msgf } from "@/lib/i18n/msg";

/**
 * Turn a pasted text or a fetched document into a posting draft. Pure (no network, no node APIs); the guarded
 * download lives in `fetch.ts`. Order of preference for a page: schema.org JSON-LD `JobPosting` (structured,
 * reliable) -> readable page text. A page with almost no text is almost always a JS-rendered shell; we say so
 * instead of returning junk, and the assistant asks the user to paste the posting.
 */

export const MIN_TEXT_CHARS = 400;
export const MAX_TEXT_CHARS = 60_000;

export const PASTE_HINT = "Ask the user to paste the full posting text and call knife_cv_job_fetch again with that text.";

/** The posting could not be obtained; the message tells the assistant what to do next. */
export class FetchError extends Error {}

export type PostingSource = "jsonld" | "html" | "paste" | "justjoin" | "nofluffjobs";

/** Structured fields a job board gives besides the text (justjoin.it). */
export interface PostingExtra {
  niceToHave: string[];
  skills: { name: string; level: number | null; required: boolean }[];
  seniority: string;
  workplace: string;
  salary: string;
  languages: string[];
  applyUrl: string;
  companyUrl: string;
}

export interface FetchedPosting {
  url: string;
  title: string;
  company: string;
  location: string;
  lang: DetectedLang;
  text: string;
  /** What the page itself lists (JSON-LD skills / qualifications), else the lines under its "Requirements" heading. */
  requirements: string[];
  source: PostingSource;
  /** Lines under the posting's "Nice to have" heading, plus board fields when the source is a known board. */
  extra?: Partial<PostingExtra>;
}

// --- input classification -------------------------------------------------------------------

const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const BARE_HOST = /^(?:www\.)?[\w-]+(?:\.[\w-]+)+(?:\/\S*)?$/;

export type PostingInput = { kind: "url"; url: string } | { kind: "text"; text: string };

/** URL (single token with an http/https scheme) or pasted text. Other schemes and bare hosts are refused. */
export function classifyInput(urlOrText: string): PostingInput {
  const raw = urlOrText.trim();
  if (!raw) throw new FetchError("empty input. Give a posting URL or paste the posting text.");
  if (!/\s/.test(raw)) {
    if (SCHEME.test(raw)) {
      if (!/^https?:\/\//i.test(raw)) throw new FetchError(msgf("refusing '{value}:': only http(s) URLs are fetched. {PASTE_HINT}", { value: raw.split(":", 1)[0], PASTE_HINT }));
      return { kind: "url", url: raw };
    }
    if (BARE_HOST.test(raw)) throw new FetchError(msgf("'{raw}' has no scheme. Retry with the full URL (https://...).", { raw }));
  }
  return { kind: "text", text: raw.slice(0, MAX_TEXT_CHARS) };
}

/**
 * Pasted postings usually start with a headline like "Title — Company, City (mode)". Take it as a HINT only (the
 * assistant can correct it with knife_cv_job_save): first line <= 140 chars, split on " — ", " – ", " | " or " @ ".
 */
export function guessHeadline(text: string): { title: string; company: string; location: string } {
  const first = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  if (!first || first.length > 140) return { title: "", company: "", location: "" };
  const [title, rest = ""] = first.split(/\s+[—–|@]\s+|\s+-\s+/, 2);
  // "Company Sp. z o.o., Katowice (hybrid)": the company is everything up to the first ", " that follows a letter-dot-free word
  const comma = rest.search(/,\s+(?=[\p{Lu}])/u);
  return {
    title: title.trim(),
    company: (comma >= 0 ? rest.slice(0, comma) : rest).trim(),
    location: comma >= 0 ? rest.slice(comma + 1).trim() : "",
  };
}

export function pastedPosting(text: string): FetchedPosting {
  const head = guessHeadline(text);
  const sections = postingSections(text);
  return { url: "", ...head, lang: detectLang(text), text, requirements: sections.requirements, source: "paste", extra: { niceToHave: sections.niceToHave } };
}

// --- page parsing ---------------------------------------------------------------------------

type JsonObject = Record<string, unknown>;
const isObject = (v: unknown): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);

interface LdFields {
  title: string;
  company: string;
  location: string;
  text: string;
  requirements: string[];
}

function parseLooseJson(source: string): unknown {
  try {
    return JSON.parse(source);
  } catch {
    // Real-world JSON-LD often has raw newlines/tabs inside strings.
    try {
      return JSON.parse(source.replace(/[\u0000-\u001f]/g, " "));
    } catch {
      return undefined;
    }
  }
}

function* walkForJobPosting(node: unknown, depth = 0): Generator<JsonObject> {
  if (depth > 40) return;
  if (Array.isArray(node)) {
    for (const item of node) yield* walkForJobPosting(item, depth + 1);
  } else if (isObject(node)) {
    const kind = node["@type"];
    const kinds = Array.isArray(kind) ? kind : [kind];
    if (kinds.includes("JobPosting")) {
      yield node;
      return;
    }
    for (const value of Object.values(node)) if (typeof value === "object" && value !== null) yield* walkForJobPosting(value, depth + 1);
  }
}

function ldPostings(root: HtmlElement): JsonObject[] {
  const found: JsonObject[] = [];
  for (const script of findAll(root, (el) => el.tag === "script" && /ld\+json/i.test(el.attrs.type ?? ""))) {
    const data = parseLooseJson(rawText(script).trim());
    if (data !== undefined) found.push(...walkForJobPosting(data));
  }
  return found;
}

const plain = (value: unknown): string => (typeof value === "string" ? decodeEntities(value).trim() : "");

/** JSON-LD descriptions are HTML (sometimes entity-escaped HTML) or plain text. */
function fragmentText(value: string): string {
  let v = value;
  if (v.includes("&lt;") && !v.includes("<")) v = decodeEntities(v);
  if (!v.includes("<")) return tidyText(decodeEntities(v));
  return readableText(parseHtml(v));
}

function orgName(org: unknown): string {
  if (isObject(org)) return plain(org.name);
  if (Array.isArray(org) && org.length) return orgName(org[0]);
  return plain(org);
}

function locationOf(posting: JsonObject): string {
  const places = posting.jobLocation;
  const parts: string[] = [];
  for (const place of Array.isArray(places) ? places : [places]) {
    const addr = isObject(place) ? place.address : place;
    if (isObject(addr)) {
      const country = isObject(addr.addressCountry) ? addr.addressCountry.name : addr.addressCountry;
      const bits = [addr.addressLocality, addr.addressRegion, country].filter((b): b is string => typeof b === "string" && b.trim() !== "");
      parts.push(bits.map(plain).join(", "));
    } else if (typeof addr === "string") parts.push(plain(addr));
  }
  if (String(posting.jobLocationType ?? "").toUpperCase() === "TELECOMMUTE") parts.push("Remote");
  return parts.filter(Boolean).join("; ");
}

/** skills / qualifications come as a string, a comma list, or a list of strings/Things. */
function asLines(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(asLines);
  if (isObject(value)) return asLines(value.name ?? value.credentialCategory);
  if (typeof value !== "string" || !value.trim()) return [];
  const text = fragmentText(value);
  if (text.includes("\n")) return text.split("\n").map((ln) => ln.replace(/^-\s*/, "").trim()).filter(Boolean);
  return text.split(/[,;]/).map((p) => p.trim()).filter(Boolean);
}

function fromJsonLd(posting: JsonObject): LdFields {
  const requirements = ["skills", "qualifications", "experienceRequirements", "educationRequirements"].flatMap((key) => asLines(posting[key]));
  return {
    title: plain(posting.title ?? posting.name),
    company: orgName(posting.hiringOrganization),
    location: locationOf(posting),
    text: typeof posting.description === "string" ? fragmentText(posting.description) : "",
    requirements: [...new Set(requirements)],
  };
}

function pageTitle(root: HtmlElement): string {
  const og = findFirst(root, (el) => el.tag === "meta" && el.attrs.property === "og:title" && Boolean(el.attrs.content));
  if (og) return og.attrs.content.trim();
  const h1 = findFirst(root, (el) => el.tag === "h1");
  if (h1) return plainText(h1);
  const title = findFirst(root, (el) => el.tag === "title");
  return title ? rawText(title).trim() : "";
}

function bodyText(root: HtmlElement): string {
  const candidates = [
    findFirst(root, (el) => el.tag === "main"),
    findFirst(root, (el) => el.tag === "article"),
    findFirst(root, (el) => el.attrs.role === "main"),
    findFirst(root, (el) => el.tag === "body"),
  ];
  for (const node of candidates) {
    if (!node) continue;
    const text = readableText(node);
    if (text.length >= MIN_TEXT_CHARS) return text;
  }
  return readableText(root);
}

function shell(url: string, got: number): FetchError {
  return new FetchError(msgf("{value} yielded only {got} characters of text: it is probably rendered by JavaScript or behind a login. {pasteHint}", { value: url || "the page", got, pasteHint: PASTE_HINT }));
}

function assemble(url: string, ld: LdFields | null, fallback: { title: string; text: string }): FetchedPosting {
  // JSON-LD wins unless it is a stub next to a much fuller visible page.
  const useLd = Boolean(ld?.text) && ((ld?.text.length ?? 0) >= MIN_TEXT_CHARS || (ld?.text.length ?? 0) * 2 >= fallback.text.length);
  const text = (useLd ? ld?.text : fallback.text) ?? "";
  if (text.length < MIN_TEXT_CHARS) throw shell(url, text.length);
  const clipped = text.slice(0, MAX_TEXT_CHARS);
  const sections = postingSections(clipped);
  return {
    url,
    title: ld?.title || fallback.title,
    company: ld?.company ?? "",
    location: ld?.location ?? "",
    lang: detectLang(clipped),
    text: clipped,
    requirements: ld?.requirements.length ? ld.requirements : sections.requirements,
    source: useLd ? "jsonld" : "html",
    extra: { niceToHave: sections.niceToHave },
  };
}

export function parsePage(body: string, url = ""): FetchedPosting {
  const root = parseHtml(body);
  const postings = ldPostings(root);
  if (postings.length > 1) {
    throw new FetchError(msgf("{value} lists {postings} postings (a search/listing page). Open ONE posting and give me its URL, or paste its text.", { value: url || "this page", postings: postings.length }));
  }
  const ld = postings.length ? fromJsonLd(postings[0]) : null;
  return assemble(url, ld, { title: pageTitle(root), text: bodyText(root) });
}

/** A `application/json` (or ld+json) document: only a schema.org JobPosting is understood. */
export function parseJsonDocument(body: string, url = ""): FetchedPosting {
  const data = parseLooseJson(body.trim());
  const postings = data === undefined ? [] : [...walkForJobPosting(data)];
  if (postings.length > 1) throw new FetchError(msgf("{value} lists {postings} postings (a search/listing page). Open ONE posting and give me its URL, or paste its text.", { value: url || "this document", postings: postings.length }));
  if (!postings.length) throw new FetchError(msgf("{value} is JSON but not a schema.org JobPosting. {pasteHint}", { value: url || "the document", pasteHint: PASTE_HINT }));
  return assemble(url, fromJsonLd(postings[0]), { title: "", text: "" });
}

/** A `text/plain` document is the posting text as is. */
export function parsePlainDocument(body: string, url = ""): FetchedPosting {
  const text = tidyText(body);
  if (text.length < MIN_TEXT_CHARS) throw shell(url, text.length);
  const clipped = text.slice(0, MAX_TEXT_CHARS);
  return { ...pastedPosting(clipped), url, source: "html" };
}
