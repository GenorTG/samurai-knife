import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { readAccountText } from "@/lib/storage/sealed";
import * as z from "zod/v4";
import { removeAccountPath, writeAccountFile } from "@/lib/storage/quota";
import { accountScope, ensurePrivateDir } from "@/lib/storage/scope";
import type { TranscriptMessage } from "./types";
import { msg, msgf } from "@/lib/i18n/msg";

const toolCallSchema = z.object({
  id: z.string(),
  type: z.literal("function"),
  function: z.object({ name: z.string(), arguments: z.string() }),
});
const transcriptMessageSchema = z.discriminatedUnion("role", [
  z.object({ role: z.literal("user"), content: z.string() }),
  z.object({ role: z.literal("assistant"), content: z.string().nullable(), tool_calls: z.array(toolCallSchema).optional() }),
  z.object({ role: z.literal("tool"), tool_call_id: z.string(), content: z.string() }),
  z.object({ role: z.literal("notice"), level: z.enum(["error", "info", "usage"]), content: z.string() }).passthrough(),
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
export const conversationSchema = conversationContentSchema.extend({
  // Third-party text has entered this conversation (server-tool-policy.ts): sticky until Clear. Absent in older files.
  untrusted: z.boolean().default(false),
});

export interface ConversationContent {
  version: 1;
  messages: TranscriptMessage[];
  actions: string[];
}

export interface DurableConversation extends ConversationContent {
  /** Server-owned taint flag (see conversationSchema); optional for values built by older callers. */
  untrusted?: boolean;
}

export function emptyConversation(): DurableConversation {
  return { version: 1, messages: [], actions: [], untrusted: false };
}

export function providerConversationId(baseUrl: string, model: string): string {
  return createHash("sha256").update(baseUrl).update("\0").update(model).digest("hex").slice(0, 32);
}

/**
 * One file per provider (baseUrl + model) under `conversations/<account>/` (path from `accountScope`). Retention: a new
 * provider file evicts all but the KEEP_CONVERSATIONS most recently written ones, so switching models cannot grow the
 * directory without bound.
 */
export const KEEP_CONVERSATIONS = 5;
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

export function resetConversation(accountId: string, providerId: string): void {
  writeConversation(accountId, providerId, emptyConversation());
}

/** Browser-owned fields only; the taint flag is kept as stored. */
export function saveConversationContent(accountId: string, providerId: string, content: ConversationContent): void {
  updateConversation(accountId, providerId, (value) => {
    value.messages = content.messages;
    value.actions = content.actions;
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
