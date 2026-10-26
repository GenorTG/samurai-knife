/**
 * The tasks the server runs in the isolate pool (`server.ts`): CPU work whose cost the caller controls (a user-supplied
 * regex, a parser over an uploaded file). Each handler is pure and synchronous; `worker.ts` serves them off the main
 * thread under a timeout and a heap cap, and unit tests call them in-process.
 *
 * Threat model: every payload is attacker-controlled. A handler may run long or allocate a lot (that is what the pool
 * bounds), but it never touches the filesystem, the network or account data: inputs arrive in the payload.
 */
import { validateJsonSchema, type JsonSchemaValidation } from "../json-schema";
import { extractTextBounded, type ExtractedText } from "../office/text";
import type { OfficeFormat } from "../office/templates";
import { buildGeneration, type AnchorMode, type Generation } from "../regexgen";
import type { HandlersFor } from "../workers/runtime";
import { msgf } from "@/lib/i18n/msg";

// A type alias, not an interface: it must be assignable to TaskMap (an index signature) without declaring one.
export type IsolateTasks = {
  /** JSON texts parsed in the worker too: a huge or deep document never costs the main thread. */
  validateJsonSchema: { payload: { schema: string; value: string }; result: JsonSchemaValidation };
  /** Regex generation verifies its pattern against the examples: user-shaped regex work. */
  generateRegex: { payload: { positiveExamples: string; negativeExamples: string; anchorMode: AnchorMode }; result: Generation | null };
  extractOfficeText: { payload: { format: OfficeFormat; bytes: Uint8Array; maxChars: number }; result: ExtractedText };
};

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(msgf("Invalid {what} text: {value}", { what, value: error instanceof Error ? error.message : String(error) }));
  }
}

export const ISOLATE_HANDLERS: HandlersFor<IsolateTasks> = {
  validateJsonSchema: ({ schema, value }) => validateJsonSchema(parseJson(schema, "JSON Schema"), parseJson(value, "JSON value")),
  generateRegex: ({ positiveExamples, negativeExamples, anchorMode }) => buildGeneration(positiveExamples, negativeExamples, anchorMode),
  extractOfficeText: ({ format, bytes, maxChars }) => extractTextBounded(format, bytes, maxChars),
};
