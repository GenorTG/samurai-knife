import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as z from "zod/v4";
import { dataDir, writePrivateFile } from "@/lib/accounts/store";
import type { TranscriptMessage } from "./types";

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
 * The whole file. `sessionId`, `responseId` and `pendingCallIds` are the OpenClaw continuation
 * state and are owned by the server alone (`/api/agent/chat`); a PUT never touches them.
 */
export const conversationSchema = conversationContentSchema.extend({
  responseId: z.string().max(256).nullable(),
  sessionId: z.string().uuid(),
  // Function calls the head response asked for; the next delta must answer all of them. Absent in pre-2026-10-11 files.
  pendingCallIds: z.array(z.string().max(256)).max(64).default([]),
});

export interface ConversationContent {
  version: 1;
  messages: TranscriptMessage[];
  actions: string[];
}

export interface DurableConversation extends ConversationContent {
  responseId: string | null;
  sessionId: string;
  pendingCallIds: string[];
}

export function emptyConversation(): DurableConversation {
  return {
    version: 1,
    messages: [],
    actions: [],
    responseId: null,
    sessionId: randomUUID(),
    pendingCallIds: [],
  };
}

export function providerConversationId(baseUrl: string, model: string): string {
  return createHash("sha256").update(baseUrl).update("\0").update(model).digest("hex").slice(0, 32);
}

export function openClawUser(accountId: string, providerId: string, sessionId: string): string {
  return `samurai-knife:${accountId}:${providerId}:${sessionId}`;
}

function conversationPath(accountId: string, providerId: string): string {
  const dir = join(dataDir(), "conversations", accountId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return join(dir, `${providerId}.json`);
}

export function readConversation(accountId: string, providerId: string): DurableConversation {
  const path = conversationPath(accountId, providerId);
  if (!existsSync(path)) {
    const initial = emptyConversation();
    writeConversation(accountId, providerId, initial);
    return initial;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`Conversation file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = conversationSchema.safeParse(raw);
  if (!parsed.success) throw new Error("Conversation file has an invalid shape.");
  return parsed.data as DurableConversation;
}

export function writeConversation(accountId: string, providerId: string, value: DurableConversation): void {
  const parsed = conversationSchema.parse(value as unknown);
  writePrivateFile(conversationPath(accountId, providerId), `${JSON.stringify(parsed)}\n`);
}

/**
 * Read-modify-write. Synchronous on purpose: Node runs it without interleaving, so a transcript PUT
 * and a continuation commit from a concurrent chat round can never overwrite each other's fields.
 */
function updateConversation<T>(accountId: string, providerId: string, mutate: (value: DurableConversation) => T): T {
  const value = readConversation(accountId, providerId);
  const result = mutate(value);
  writeConversation(accountId, providerId, value);
  return result;
}

export function resetConversation(accountId: string, providerId: string): void {
  writeConversation(accountId, providerId, emptyConversation());
}

/** Browser-owned fields only; the continuation state is kept as stored. */
export function saveConversationContent(accountId: string, providerId: string, content: ConversationContent): void {
  updateConversation(accountId, providerId, (value) => {
    value.messages = content.messages;
    value.actions = content.actions;
  });
}

/* ------------------------------------------------------------------ OpenClaw continuation state machine
 *
 * Invariant: a gateway session receives the full history exactly once (the seed), afterwards only deltas
 * chained by previous_response_id. Therefore:
 *   - a seed (no previous id) always runs in a FRESH session (new `user` scope), never one that already
 *     holds part of the conversation;
 *   - a delta is accepted only if it chains from the stored head and answers every call the head left
 *     pending; anything else (head moved, results dropped) breaks the chain and the browser reseeds;
 *   - only a round that completed advances the head; a failed, aborted or unresolvable round breaks it,
 *     and so does a round that bypassed the continuation (Responses mode switched off).
 */

export type RoundStart =
  | { ok: true; sessionId: string; previousResponseId: string | null }
  | { ok: false };

export function beginResponsesRound(
  accountId: string,
  providerId: string,
  previousResponseId: string | null,
  answeredCallIds: readonly string[],
): RoundStart {
  return updateConversation(accountId, providerId, (value): RoundStart => {
    if (previousResponseId === null) {
      value.sessionId = randomUUID();
      value.responseId = null;
      value.pendingCallIds = [];
      return { ok: true, sessionId: value.sessionId, previousResponseId: null };
    }
    const answered = new Set(answeredCallIds);
    if (value.responseId !== previousResponseId || value.pendingCallIds.some((id) => !answered.has(id))) {
      value.responseId = null;
      value.pendingCallIds = [];
      return { ok: false };
    }
    return { ok: true, sessionId: value.sessionId, previousResponseId };
  });
}

/** Advance the head. Dropped when the session was rotated meanwhile (Clear, or a reseed from another round). */
export function commitResponsesRound(
  accountId: string,
  providerId: string,
  sessionId: string,
  responseId: string,
  pendingCallIds: readonly string[],
): void {
  updateConversation(accountId, providerId, (value) => {
    if (value.sessionId !== sessionId) return;
    value.responseId = responseId;
    value.pendingCallIds = [...pendingCallIds];
  });
}

/** Forget the head so the next round reseeds. With a sessionId, only if that session is still current. */
export function breakContinuation(accountId: string, providerId: string, sessionId?: string): void {
  const current = readConversation(accountId, providerId);
  if (current.responseId === null && current.pendingCallIds.length === 0) return; // nothing to break: skip the write
  updateConversation(accountId, providerId, (value) => {
    if (sessionId !== undefined && value.sessionId !== sessionId) return;
    value.responseId = null;
    value.pendingCallIds = [];
  });
}
