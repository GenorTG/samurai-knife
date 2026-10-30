import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync, utimesSync } from "node:fs";
import { readAccountText } from "@/lib/storage/sealed";
import * as z from "zod/v4";
import { removeAccountPath, writeAccountFile } from "@/lib/storage/quota";
import { accountScope, ensurePrivateDir } from "@/lib/storage/scope";
import type { TranscriptMessage } from "./types";
import { msg, msgf } from "@/lib/i18n/msg";
import { providerProfilesOf, type Account } from "@/lib/accounts/store";
import { usedModels } from "@/lib/accounts/usage-ledger";

const toolCallSchema = z.object({
  id: z.string(),
  type: z.literal("function"),
  function: z.object({ name: z.string(), arguments: z.string() }),
});
const transcriptMessageSchema = z.discriminatedUnion("role", [
  z.object({ role: z.literal("user"), content: z.string() }),
  z.object({ role: z.literal("assistant"), content: z.string().nullable(), tool_calls: z.array(toolCallSchema).optional() }),
  z.object({ role: z.literal("tool"), tool_call_id: z.string(), content: z.string() }),
  z.object({ role: z.literal("notice"), level: z.enum(["error", "info", "usage", "summary"]), content: z.string() }).passthrough(),
]);

/** What the browser owns and writes (PUT): the transcript and the action journal. */
export const conversationContentSchema = z.object({
  version: z.literal(1),
  messages: z.array(transcriptMessageSchema).max(200),
  actions: z.array(z.string().max(240)).max(40),
});

/**
 * The whole file. `untrusted` is the conversation's taint, owned by the server alone (`/api/agent/chat`); a PUT never
 * touches it. Files written before 2026-10-25 also hold `responseId`/`sessionId`/`pendingCallIds` (the removed
 * Responses continuation): zod strips them on read and the next write drops them.
 */
const FILE_ID = /^[a-f0-9]{32}$/;
const CHAT_ID = /^[a-zA-Z0-9_-]{1,64}$/;

export const conversationSchema = conversationContentSchema.extend({
  // Third-party text has entered this conversation (server-tool-policy.ts): sticky until Clear. Absent in older files.
  untrusted: z.boolean().default(false),
  // Server-owned bookkeeping of the move from provider-scoped files (before 0.13.0.22) to one file per chat:
  /** The chat id of a chat-scoped file (stamped on read/write; older files have none). */
  chatId: z.string().regex(CHAT_ID).optional(),
  /** Provider-scoped copies of this chat were looked for (adopted or none); a cleared chat never re-adopts. */
  legacyChecked: z.boolean().default(false),
  /** On a chat file: the provider-scoped file it took its transcript from. */
  adoptedFrom: z.string().regex(FILE_ID).optional(),
  /** On a provider-scoped file: the chat file that took it over (kept until it is evicted). */
  adoptedInto: z.string().regex(FILE_ID).optional(),
  /** The provider host and model of the chat's latest round (server-owned; for knife_chat_list). */
  lastModel: z.object({ host: z.string().max(253), model: z.string().max(200) }).optional(),
});

export interface ConversationContent {
  version: 1;
  messages: TranscriptMessage[];
  actions: string[];
}

export interface DurableConversation extends ConversationContent {
  /** Server-owned taint flag (see conversationSchema); optional for values built by older callers. */
  untrusted?: boolean;
  chatId?: string;
  legacyChecked?: boolean;
  adoptedFrom?: string;
  adoptedInto?: string;
  lastModel?: { host: string; model: string };
}

export function emptyConversation(): DurableConversation {
  return { version: 1, messages: [], actions: [], untrusted: false };
}

export function providerConversationId(baseUrl: string, model: string, chatId = "default"): string {
  const hash = createHash("sha256").update(baseUrl).update("\0").update(model);
  if (chatId !== "default") hash.update("\0").update(chatId);
  return hash.digest("hex").slice(0, 32);
}

/** Stable server scope for a chat, deliberately independent of provider/model. */
export function chatConversationId(chatId = "default"): string {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(chatId)) throw new Error("invalid chat id");
  return createHash("sha256").update("samurai-knife-chat\0").update(chatId).digest("hex").slice(0, 32);
}

/**
 * One file per account/chat under `conversations/<account>/`, using chatConversationId rather than providerConversationId.
 * Retention is bounded to the widget's 50-chat limit; creating a new chat evicts the least recently used chats.
 */
export const KEEP_CONVERSATIONS = 50;
const PROVIDER_ID = /^[a-f0-9]{32}$/;

function conversationPath(accountId: string, providerId: string): string {
  if (!PROVIDER_ID.test(providerId)) throw new Error("invalid conversation id");
  const scope = accountScope(accountId);
  ensurePrivateDir(scope.conversations);
  return scope.join("conversations", `${providerId}.json`);
}

function pruneConversations(accountId: string, keep: string): void {
  const dir = accountScope(accountId).conversations;
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".json") && name !== `${keep}.json`)
    .map((name) => ({ name, at: statSync(accountScope(accountId).join("conversations", name)).mtimeMs }))
    .sort((a, b) => b.at - a.at);
  for (const old of files.slice(KEEP_CONVERSATIONS - 1)) removeAccountPath(accountId, accountScope(accountId).join("conversations", old.name));
}

export function readConversation(accountId: string, providerId: string): DurableConversation {
  const path = conversationPath(accountId, providerId);
  if (!existsSync(path)) {
    const initial = emptyConversation();
    writeConversation(accountId, providerId, initial);
    pruneConversations(accountId, providerId);
    return initial;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readAccountText(accountId, path)) as unknown;
  } catch (error) {
    throw new Error(msgf("Conversation file is not valid JSON: {value}", { value: error instanceof Error ? error.message : String(error) }));
  }
  const parsed = conversationSchema.safeParse(raw);
  if (!parsed.success) throw new Error(msg("Conversation file has an invalid shape."));
  return parsed.data as DurableConversation;
}

/**
 * `enforce` = the write carries the user's transcript (a PUT) and is refused with QuotaExceededError when it would not
 * fit; the server's own bookkeeping (the taint flag) is never refused mid-round.
 */
export function writeConversation(accountId: string, providerId: string, value: DurableConversation, options: { enforce?: boolean } = {}): void {
  const parsed = conversationSchema.parse(value as unknown);
  writeAccountFile(accountId, conversationPath(accountId, providerId), `${JSON.stringify(parsed)}\n`, { enforce: options.enforce ?? false });
}

/**
 * Read-modify-write. Synchronous on purpose: Node runs it without interleaving, so a transcript PUT
 * and the taint update from a concurrent chat round can never overwrite each other's fields.
 */
function updateConversation<T>(accountId: string, providerId: string, mutate: (value: DurableConversation) => T, options: { enforce?: boolean } = {}): T {
  const value = readConversation(accountId, providerId);
  const result = mutate(value);
  writeConversation(accountId, providerId, value, options);
  return result;
}

/** Clear: an empty chat that never adopts an older provider-scoped copy again. */
export function resetConversation(accountId: string, providerId: string, chatId?: string): void {
  writeConversation(accountId, providerId, { ...emptyConversation(), legacyChecked: true, ...(chatId ? { chatId } : {}) });
}

/** Browser-owned fields only; the taint flag is kept as stored. */
export function saveConversationContent(accountId: string, providerId: string, content: ConversationContent, chatId?: string): void {
  updateConversation(accountId, providerId, (value) => {
    value.messages = content.messages;
    value.actions = content.actions;
    if (chatId) value.chatId = chatId;
  }, { enforce: true });
}

/**
 * The conversation's sticky taint (server-tool-policy.ts): `seen` = this round's messages carry third-party text. Set
 * once and kept until Clear (resetConversation), because the model keeps seeing that text in later turns. Writes only
 * on the first change. Returns the flag after the update.
 */
export function noteUntrusted(accountId: string, providerId: string, seen: boolean): boolean {
  const current = readConversation(accountId, providerId);
  if (current.untrusted || !seen) return current.untrusted === true;
  updateConversation(accountId, providerId, (value) => {
    value.untrusted = true;
  });
  return true;
}

/**
 * One chat round's bookkeeping: the chat id (stamped once), and the provider host + model that answered (written only
 * when they change). Never touches the transcript.
 */
export function noteRoundModel(accountId: string, providerId: string, chatId: string, model: { host: string; model: string }): void {
  const current = readConversation(accountId, providerId);
  if (current.chatId === chatId && current.lastModel?.host === model.host && current.lastModel?.model === model.model) return;
  updateConversation(accountId, providerId, (value) => {
    value.chatId = chatId;
    value.lastModel = { host: model.host.slice(0, 253), model: model.model.slice(0, 200) };
  });
}

/* ------------------------------------------------- reading chats from outside (knife_chat_list / knife_chat_read) */

export interface ChatFile {
  chatId: string;
  conversation: DurableConversation;
  updatedAt: string;
}

/** Every chat file of the account (provider-scoped files from before 0.13.0.22 excluded), newest first. Creates nothing. */
export function listChatFiles(accountId: string): ChatFile[] {
  const dir = accountScope(accountId).conversations;
  if (!existsSync(dir)) return [];
  const out: ChatFile[] = [];
  for (const name of readdirSync(dir)) {
    const id = name.replace(/\.json$/, "");
    if (!PROVIDER_ID.test(id) || !name.endsWith(".json")) continue;
    let conversation: DurableConversation;
    try {
      conversation = conversationSchema.parse(JSON.parse(readAccountText(accountId, accountScope(accountId).join("conversations", name)))) as DurableConversation;
    } catch {
      continue;
    }
    const chatId = conversation.chatId;
    // A chat file is named after its chat id; anything else is an older provider-scoped copy.
    if (!chatId || chatConversationId(chatId) !== id) continue;
    out.push({ chatId, conversation, updatedAt: new Date(statSync(accountScope(accountId).join("conversations", name)).mtimeMs).toISOString() });
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** The chat's file, or null when the account has no such chat. Creates nothing. */
export function peekChat(accountId: string, chatId: string): ChatFile | null {
  if (!CHAT_ID.test(chatId)) return null;
  return listChatFiles(accountId).find((c) => c.chatId === chatId) ?? null;
}

/* ------------------------------------------------- recovery of provider-scoped chats (before 0.13.0.22) */

/** A provider (or saved profile) the account has used: its provider-scoped files are named after base URL + model. */
export interface LegacySource {
  baseUrl: string;
  model: string;
}

/**
 * Where provider-scoped chats of older releases may live: every base URL the account has saved (profiles and the active
 * provider) with every model it has saved there or run rounds with (usage ledger), so a model changed inside one profile
 * is still found.
 */
export function legacySourcesOf(account: Account): LegacySource[] {
  const configs = [...providerProfilesOf(account).map((profile) => profile.config), ...(account.provider ? [account.provider] : [])];
  const models = new Set([...configs.map((config) => config.model), ...usedModels(account.id)]);
  const urls = new Set(configs.map((config) => config.baseUrl));
  const out: LegacySource[] = [];
  for (const baseUrl of urls) for (const model of models) if (baseUrl && model) out.push({ baseUrl, model });
  return out.slice(0, 400);
}

interface LegacyFile {
  id: string;
  value: DurableConversation;
  mtimeMs: number;
}

function hasTranscript(value: DurableConversation): boolean {
  return value.messages.some((m) => m.role === "user" || m.role === "assistant");
}

function readIfPresent(accountId: string, id: string): LegacyFile | null {
  const path = conversationPath(accountId, id);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readAccountText(accountId, path)) as unknown;
    const parsed = conversationSchema.safeParse(raw);
    return parsed.success ? { id, value: parsed.data as DurableConversation, mtimeMs: statSync(path).mtimeMs } : null;
  } catch {
    return null;
  }
}

/** Mark a provider-scoped file as taken over without changing its age (eviction stays least-recently-used). */
function markAdopted(accountId: string, legacy: LegacyFile, into: string): void {
  const path = conversationPath(accountId, legacy.id);
  writeConversation(accountId, legacy.id, { ...legacy.value, adoptedInto: into });
  const at = new Date(legacy.mtimeMs);
  try {
    utimesSync(path, at, at);
  } catch {
    /* only the eviction order */
  }
}

function legacyCandidates(sources: readonly LegacySource[], chatId: string): string[] {
  const ids = new Set<string>();
  for (const source of sources) if (source.baseUrl && source.model) ids.add(providerConversationId(source.baseUrl, source.model, chatId));
  return [...ids];
}

/**
 * The chat's conversation for GET. When its file is missing or empty and has never looked for older copies, the most
 * recently written non-empty provider-scoped file of the same chat (any of the account's providers/profiles) is copied
 * in: transcript, action journal and taint (an adopted transcript keeps its third-party mark). The older file stays,
 * marked `adoptedInto`, until the normal eviction removes it.
 */
export function openChatConversation(accountId: string, chatId: string, sources: readonly LegacySource[]): DurableConversation {
  const id = chatConversationId(chatId);
  const current = readConversation(accountId, id);
  if (current.legacyChecked && current.chatId === chatId) return current;
  if (!current.legacyChecked && !hasTranscript(current)) {
    const found = legacyCandidates(sources, chatId)
      .map((candidate) => readIfPresent(accountId, candidate))
      .filter((file): file is LegacyFile => file !== null && hasTranscript(file.value) && !file.value.adoptedInto)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
    if (found) {
      current.messages = found.value.messages;
      current.actions = found.value.actions;
      current.untrusted = current.untrusted === true || found.value.untrusted === true;
      current.adoptedFrom = found.id;
      markAdopted(accountId, found, id);
    }
  }
  current.legacyChecked = true;
  current.chatId = chatId;
  writeConversation(accountId, id, current);
  return current;
}

export interface EarlierChat {
  /** File id (32 hex): pass to importEarlierChat. */
  file: string;
  /** Model and provider host the file was written with, when one of the account's providers matches; else null. */
  model: string | null;
  host: string | null;
  /** The chat id it belonged to, when known; else null. */
  chatId: string | null;
  modifiedAt: string;
  /** User + assistant messages (tool calls and notices not counted). */
  messages: number;
  /** The first user message, shortened. */
  preview: string;
  /** Third-party text entered it (the taint follows an import). */
  untrusted: boolean;
}

function hostOf(baseUrl: string): string | null {
  try {
    return new URL(baseUrl).host;
  } catch {
    return null;
  }
}

/**
 * Provider-scoped transcripts of the account that no chat took over: a chat's own file (stamped, or the chat id of one
 * of `chatIds`) is never listed. Newest first.
 */
export function listEarlierChats(accountId: string, sources: readonly LegacySource[], chatIds: readonly string[]): EarlierChat[] {
  const dir = accountScope(accountId).conversations;
  if (!existsSync(dir)) return [];
  const known = new Set(["default", ...chatIds].filter((c) => CHAT_ID.test(c)));
  const own = new Set([...known].map((c) => chatConversationId(c)));
  const named = new Map<string, { source: LegacySource; chatId: string }>();
  for (const source of sources) for (const chatId of known) {
    if (source.baseUrl && source.model) named.set(providerConversationId(source.baseUrl, source.model, chatId), { source, chatId });
  }
  const out: EarlierChat[] = [];
  for (const name of readdirSync(dir)) {
    const id = name.replace(/\.json$/, "");
    if (!name.endsWith(".json") || !FILE_ID.test(id) || own.has(id)) continue;
    const file = readIfPresent(accountId, id);
    if (!file || file.value.chatId || file.value.adoptedInto || !hasTranscript(file.value)) continue;
    const firstUser = file.value.messages.find((m) => m.role === "user");
    const match = named.get(id);
    out.push({
      file: id,
      model: match?.source.model ?? null,
      host: match ? hostOf(match.source.baseUrl) : null,
      chatId: match?.chatId ?? null,
      modifiedAt: new Date(file.mtimeMs).toISOString(),
      messages: file.value.messages.filter((m) => m.role === "user" || m.role === "assistant").length,
      preview: firstUser && typeof firstUser.content === "string" ? firstUser.content.replace(/\s+/g, " ").trim().slice(0, 160) : "",
      untrusted: file.value.untrusted === true,
    });
  }
  return out.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

export class EarlierChatError extends Error {
  readonly code: "not_found" | "chat_not_empty";
  constructor(code: "not_found" | "chat_not_empty") {
    super(code);
    this.code = code;
  }
}

/** "Open as a new chat": copy an earlier transcript (journal and taint included) into `chatId`, which must be empty. */
export function importEarlierChat(accountId: string, file: string, chatId: string): DurableConversation {
  if (!FILE_ID.test(file) || !CHAT_ID.test(chatId)) throw new EarlierChatError("not_found");
  const id = chatConversationId(chatId);
  if (file === id) throw new EarlierChatError("not_found");
  const legacy = readIfPresent(accountId, file);
  if (!legacy || legacy.value.chatId || legacy.value.adoptedInto || !hasTranscript(legacy.value)) throw new EarlierChatError("not_found");
  const target = readConversation(accountId, id);
  if (hasTranscript(target)) throw new EarlierChatError("chat_not_empty");
  const value: DurableConversation = {
    version: 1,
    messages: legacy.value.messages,
    actions: legacy.value.actions,
    untrusted: target.untrusted === true || legacy.value.untrusted === true,
    chatId,
    legacyChecked: true,
    adoptedFrom: file,
  };
  writeConversation(accountId, id, value, { enforce: true });
  markAdopted(accountId, legacy, id);
  return value;
}
